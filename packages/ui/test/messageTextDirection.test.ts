import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  MessageResponse,
  messageResponsePropsAreEqual,
  type MessageResponseProps,
} from "@/components/ai-elements/message.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationUserInputBody } from "@/v4/ConversationUserInputBody.js";

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: unknown) => unknown) =>
    selector({
      codePreviewSettings: {
        darkTheme: "github-dark",
        fontSizePx: 13,
        lightTheme: "github-light",
        wrapLongLines: true,
      },
      theme: "zai-light",
    }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({}),
  useOptionalPlatform: () => ({}),
}));

const MIXED_DIRECTION_MARKDOWN = [
  "## عنوان القسم",
  "مرحبا بالعالم، استخدم `foo()` هنا.",
  "English paragraph.",
  "- العنصر الأول\n- العنصر الثاني",
  "1. שלום\n2. עולם",
  "| العمود | Column |\n| --- | --- |\n| قيمة | value |",
  "```ts\nconst answer = 42;\n```",
].join("\n\n");

function renderWithIntl(children: ReactNode): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, { children, initialLocale: "en-US" }),
  );
}

function renderMessage(props: Omit<MessageResponseProps, "children"> = {}): string {
  return renderWithIntl(
    createElement(
      TooltipProvider,
      null,
      createElement(MessageResponse, props, MIXED_DIRECTION_MARKDOWN),
    ),
  );
}

function openingTags(html: string, tagName: string): string[] {
  return html.match(new RegExp(`<${tagName}(?=[\\s>])[^>]*>`, "g")) ?? [];
}

describe("message text direction", () => {
  it("MessageResponse 缺省按块使用 dir=auto，代码固定 ltr", () => {
    const html = renderMessage();

    for (const tagName of ["p", "h2", "ul", "ol", "th", "td"]) {
      const tags = openingTags(html, tagName);
      expect(tags, tagName).not.toHaveLength(0);
      for (const tag of tags) {
        expect(tag, tagName).toContain('dir="auto"');
      }
    }
    // li 继承列表方向；带 dir 会让 ul/ol 的 auto 检测跳过全部文字。
    for (const tag of openingTags(html, "li")) {
      expect(tag).not.toContain("dir=");
    }

    const inlineCodeTags = openingTags(html, "code").filter((tag) =>
      tag.includes("bg-markdown-inline-code"),
    );
    expect(inlineCodeTags).toHaveLength(1);
    expect(inlineCodeTags[0]).toContain('dir="ltr"');

    // 第一个 data-language 节点是 CodeBlock 外层容器，内部高亮视图继承其方向。
    const codeBlockTags = openingTags(html, "div").filter((tag) =>
      tag.includes('data-language="ts"'),
    );
    expect(codeBlockTags).not.toHaveLength(0);
    expect(codeBlockTags[0]).toContain('dir="ltr"');
  });

  it("MessageResponse 显式 dir 应用到文本块，代码仍为 ltr", () => {
    const html = renderMessage({ dir: "rtl" });

    for (const tagName of ["p", "h2", "ul", "ol", "th", "td"]) {
      for (const tag of openingTags(html, tagName)) {
        expect(tag, tagName).toContain('dir="rtl"');
      }
    }
    const codeBlockTags = openingTags(html, "div").filter((tag) =>
      tag.includes('data-language="ts"'),
    );
    expect(codeBlockTags[0]).toContain('dir="ltr"');
  });

  it("dir 变化会使 MessageResponse memo 失效", () => {
    const base: MessageResponseProps = { children: "مرحبا" };

    expect(messageResponsePropsAreEqual(base, { ...base })).toBe(true);
    expect(messageResponsePropsAreEqual(base, { ...base, dir: "rtl" })).toBe(false);
  });

  it("用户气泡正文容器使用 dir=auto", () => {
    const html = renderWithIntl(
      createElement(ConversationUserInputBody, {
        children: createElement("span", null, "مرحبا"),
        contentText: "مرحبا",
        rowId: 1,
      }),
    );

    const contentTags = openingTags(html, "div").filter((tag) =>
      tag.includes("data-v4-user-input-collapsible-content"),
    );
    expect(contentTags).toHaveLength(1);
    expect(contentTags[0]).toContain('dir="auto"');
  });
});
