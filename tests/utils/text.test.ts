import { describe, expect, it } from "vitest";
import { detectWrapText, stripWrappingCodeFence } from "../../src/utils/text";

describe("stripWrappingCodeFence", () => {
  it("removes a whole-document fence with a language tag", () => {
    const input = "```markdown\n# Title\n\nbody\n```";
    expect(stripWrappingCodeFence(input)).toBe("# Title\n\nbody");
  });

  it("removes a bare whole-document fence", () => {
    expect(stripWrappingCodeFence("```\nhello\n```")).toBe("hello");
  });

  it("leaves normal markdown untouched", () => {
    const input = "# Title\n\nSome text with an inline `code` span.";
    expect(stripWrappingCodeFence(input)).toBe(input);
  });

  it("does not strip when the body contains multiple code blocks", () => {
    const input = "```ts\nconst a = 1;\n```\n\ntext\n\n```ts\nconst b = 2;\n```";
    expect(stripWrappingCodeFence(input)).toBe(input);
  });
});

describe("detectWrapText", () => {
  it("returns no warnings for a clean article (heading first, normal conclusion)", () => {
    const input = "# タイトル\n\n本文です。\n\nまとめると、これが結論です。";
    expect(detectWrapText(input)).toEqual([]);
  });

  it("warns when the article opens with a meta preamble", () => {
    const input = "以下は、レビューを反映した改稿版です。\n\n# タイトル\n\n本文。";
    const warnings = detectWrapText(input);
    expect(warnings.some((w) => w.includes("前置き"))).toBe(true);
  });

  it("does not warn on a legitimate lead paragraph before the first heading (Zenn/note style)", () => {
    const input = "外部APIを呼ぶとき、失敗にどう備えるかは悩ましい問題です。\n\n## はじめに\n\n本文。";
    expect(detectWrapText(input)).toEqual([]);
  });

  it("warns when the tail offers follow-up options (postamble)", () => {
    const input = "# タイトル\n\n本文。\n\n1. 簡潔版\n2. 詳細版\nのどれかで出し直せます。";
    const warnings = detectWrapText(input);
    expect(warnings.some((w) => w.includes("追加提案"))).toBe(true);
  });
});
