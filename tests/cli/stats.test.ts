import { describe, expect, it } from "vitest";
import { computeArticleStats } from "../../src/cli/stats";
import { SOURCES_BEGIN, SOURCES_END } from "../../src/cli/references";

describe("computeArticleStats", () => {
  it("counts body chars excluding the 参考 block and newlines (matches awk length sum)", () => {
    const md = [
      "# タイトル",
      "",
      "本文です。", // 5 chars
      "もう一行。", // 5 chars
      "",
      "## 参考",
      "",
      SOURCES_BEGIN,
      "- [S001] Doc",
      "  https://example.com/doc",
      SOURCES_END,
      "",
    ].join("\n");
    const stats = computeArticleStats(md);
    // 参考マーカー行以降は数えない。改行を除いた行長合計。
    // "# タイトル"(6) + "本文です。"(5) + "もう一行。"(5) + "## 参考"(5) = 21
    expect(stats.bodyChars).toBe(21);
    expect(stats.hasReferencesBlock).toBe(true);
    expect(stats.title).toBe("タイトル");
  });

  it("prose chars drop fenced code, markup symbols and whitespace", () => {
    const md = [
      "# T",
      "",
      "本文に **強調** と `code` を含む。", // 散文: 本文に強調とcodeを含む。
      "",
      "```ts",
      "const x: number = 1; // これはコード（除外される）",
      "```",
      "",
      "- 箇条書き項目",
    ].join("\n");
    const stats = computeArticleStats(md);
    // fenced code は丸ごと除外。markup（# * ` -）と空白も除外。
    // 残る散文文字: T 本文に強調とcodeを含む 箇条書き項目
    // = "T" + "本文に強調とcodeを含む。" + "箇条書き項目"
    expect(stats.proseChars).toBe("T".length + "本文に強調とcodeを含む。".length + "箇条書き項目".length);
  });

  it("falls back to whole text when no 参考 block (and reports it)", () => {
    const md = "# だけ\n本文";
    const stats = computeArticleStats(md);
    expect(stats.hasReferencesBlock).toBe(false);
    expect(stats.bodyChars).toBe("# だけ".length + "本文".length);
    expect(stats.title).toBe("だけ");
  });

  it("title is null when there is no H1", () => {
    const stats = computeArticleStats("## 見出し2\n本文");
    expect(stats.title).toBeNull();
  });
});
