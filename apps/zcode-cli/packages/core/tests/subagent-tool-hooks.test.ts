import { describe, expect, it, vi } from "vitest";
import {
  createModelId,
  createModelProviderId,
  createSessionId,
  createWorkspaceHookBundleSnapshot,
  type ExecutionPort,
  type ExecutionResult,
  type HookEventName,
  type WorkspaceHookBundleSnapshot,
} from "@zcode/contracts";
import type { WorkspaceHookRuntimeAdmissionPort } from "../src/hooks/index.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { MemoryFileSystem } from "./memory-test-utils.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

describe("subagent tool hooks", () => {
  // Bug 根因：child runtime 的配置逐字段构造，未携带 hooks / workspace hook 快照，
  // 子代理内的工具调用从不触发 PreToolUse 等工具 Hook，安全类 Hook 对子代理整体失效。
  it("runs configured tool hooks for subagent tool calls and tags them with the parent session", async () => {
    const sessionId = createSessionId("runtime-subagent-tool-hooks");
    const hookStdins: Array<Record<string, unknown>> = [];
    let parentCallCount = 0;
    let childCallCount = 0;

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        modelSelection: {
          providerId: createModelProviderId("provider-test"),
          modelId: createModelId("parent-model"),
        },
        workingDirectory: "/workspace/project",
        hooks: {
          enabled: true,
          events: {
            PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "pre-read" }] }],
            SessionStart: [{ hooks: [{ type: "command", command: "session-start" }] }],
            Stop: [{ hooks: [{ type: "command", command: "stop" }] }],
          },
          maxOutputBytes: 4096,
          timeoutMs: 1000,
        },
      },
      {
        eventStore: createTestSessionEventStore(),
        executionPort: recordingHookExecutionPort(hookStdins),
        fileSystemPort: new MemoryFileSystem({
          "/workspace/project/README.md": "subagent hook fixture\n",
        }),
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            const toolNames = (request.tools ?? []).map((tool: any) => tool.name);
            if (toolNames.includes("Agent")) {
              parentCallCount++;
              if (parentCallCount === 1) {
                return {
                  finishReason: "tool-calls",
                  providerMetadata: undefined,
                  text: "",
                  toolCalls: [
                    {
                      id: "call_parent_agent",
                      name: "Agent",
                      input: {
                        description: "Read project readme",
                        prompt: "Read README.md.",
                        subagent_type: "general-purpose",
                      },
                    },
                  ],
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              }
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "parent received child result",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            childCallCount++;
            if (childCallCount === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  { id: "call_child_read", name: "Read", input: { file_path: "README.md" } },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "child read the readme",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("Delegate reading README.md to a child.");

    const childPreToolUse = hookStdins.filter(
      (stdin) => stdin.hook_event_name === "PreToolUse" && stdin.tool_use_id === "call_child_read",
    );
    expect(childPreToolUse).toHaveLength(1);
    expect(childPreToolUse[0]).toMatchObject({
      agent_type: "zcode-general-purpose",
      parent_session_id: sessionId,
      session_id: expect.stringContaining("sess_subagent_agent_"),
      tool_name: "Read",
    });

    // 子代理只补工具级 Hook；SessionStart / Stop 等会话级 Hook 仍只属于主会话。
    const lifecycleSessions = hookStdins
      .filter((stdin) => stdin.hook_event_name === "SessionStart" || stdin.hook_event_name === "Stop")
      .map((stdin) => `${String(stdin.hook_event_name)}:${String(stdin.session_id)}`);
    expect(lifecycleSessions).toEqual([`SessionStart:${sessionId}`, `Stop:${sessionId}`]);
  });
  // 项目级 Hook（受信 .zcode/config.json）走 workspace 快照 + admission：子代理复用父的
  // 同一快照与准入实例，子代理派发同样经过 admission 评估。
  it("runs trusted project hooks for subagent tool calls through the shared workspace admission", async () => {
    const sessionId = createSessionId("runtime-subagent-project-hooks");
    const hookStdins: Array<Record<string, unknown>> = [];
    let parentCallCount = 0;
    let childCallCount = 0;
    const admission = {
      activate: vi.fn(async () => {}),
      evaluateDispatch: vi.fn(() => ({ allowed: true as const })),
      getCurrentSnapshot: vi.fn(() => projectHookSnapshot),
      invalidate: vi.fn(),
      replaceSnapshot: vi.fn(),
    } satisfies WorkspaceHookRuntimeAdmissionPort;

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        modelSelection: {
          providerId: createModelProviderId("provider-test"),
          modelId: createModelId("parent-model"),
        },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore: createTestSessionEventStore(),
        executionPort: recordingHookExecutionPort(hookStdins),
        fileSystemPort: new MemoryFileSystem({
          "/workspace/project/README.md": "subagent project hook fixture\n",
        }),
        workspaceHookAdmission: admission,
        workspaceHookSnapshot: projectHookSnapshot,
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            const toolNames = (request.tools ?? []).map((tool: any) => tool.name);
            if (toolNames.includes("Agent")) {
              parentCallCount++;
              if (parentCallCount === 1) {
                return {
                  finishReason: "tool-calls",
                  providerMetadata: undefined,
                  text: "",
                  toolCalls: [
                    {
                      id: "call_parent_agent",
                      name: "Agent",
                      input: {
                        description: "Read project readme",
                        prompt: "Read README.md.",
                        subagent_type: "general-purpose",
                      },
                    },
                  ],
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              }
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "parent received child result",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            childCallCount++;
            if (childCallCount === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  { id: "call_child_read", name: "Read", input: { file_path: "README.md" } },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "child read the readme",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("Delegate reading README.md to a child.");

    const childPreToolUse = hookStdins.filter(
      (stdin) => stdin.hook_event_name === "PreToolUse" && stdin.tool_use_id === "call_child_read",
    );
    expect(childPreToolUse).toHaveLength(1);
    expect(childPreToolUse[0]).toMatchObject({
      parent_session_id: sessionId,
      session_id: expect.stringContaining("sess_subagent_agent_"),
      tool_name: "Read",
    });
    // 锁定子代理确实经由共享 admission 完成派发评估（本场景实测调用 2 次），
    // 而不是绕过 admission 直接执行项目 Hook。
    expect(admission.evaluateDispatch).toHaveBeenCalledTimes(2);
    expect(admission.evaluateDispatch).toHaveBeenCalledWith({
      hookDeclarationDigest: "a".repeat(64),
      reviewItemId: "item-0",
    });
  });
});


function recordingHookExecutionPort(stdins: Array<Record<string, unknown>>): ExecutionPort {
  return {
    async run(request) {
      const stdin = typeof request.stdin === "string" ? request.stdin : "";
      if (stdin.includes("hook_event_name")) {
        stdins.push(JSON.parse(stdin) as Record<string, unknown>);
      }
      return completed("{}");
    },
  };
}

function completed(stdout: string): ExecutionResult {
  const now = new Date();
  return {
    cancelled: false,
    completedAt: now,
    durationMs: 1,
    exitCode: 0,
    startedAt: now,
    status: "completed",
    stderr: { bytes: 0, text: "", truncated: false },
    stdout: { bytes: Buffer.byteLength(stdout), text: stdout, truncated: false },
    timedOut: false,
  };
}

const projectHookSnapshot: WorkspaceHookBundleSnapshot = createWorkspaceHookBundleSnapshot({
  schemaVersion: 1,
  workspaceIdentity: "local:/workspace",
  discoveredAt: "2026-08-06T00:00:00.000Z",
  sourceFiles: [
    {
      canonicalPath: "/workspace/project/.zcode/config.json",
      baseDir: "/workspace/project",
      discoveryOrder: 0,
      configFileKind: ".zcode/config.json",
      explicitProjectConfig: false,
      editable: true,
      hooksRoot: { enabled: true },
    },
  ],
  hooks: [
    {
      reviewItemId: "item-0",
      event: "PreToolUse" as HookEventName,
      matcherIndex: 0,
      hookIndex: 0,
      sourceFileIndex: 0,
      sourceRelativePath: ".zcode/config.json",
      matcher: "Read",
      type: "command",
      command: "project-audit-hook",
      resolvedTimeoutMs: 60_000,
      resolvedMaxOutputBytes: 32_768,
      sourceRootEnabled: true,
      declarationEnabled: true,
      runtimeHooksEnabled: true,
      configuredEnabled: true,
      editable: true,
      declarationDigestAlgorithm: "sha256",
      hookDeclarationDigest: "a".repeat(64),
    },
  ],
  digestAlgorithm: "sha256",
  bundleDigest: "c".repeat(64),
});
