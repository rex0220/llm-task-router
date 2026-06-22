import { describe, expect, it } from "vitest";
import { detectBrokenStrongEmphasis, detectWrapText, stripWrappingCodeFence } from "../../src/utils/text";

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

describe("detectBrokenStrongEmphasis", () => {
  // 実データ（hayabusa2.md）の崩れ5例: 閉じ `**` の直前が約物で right-flanking 不成立。
  // 1 span につき欠陥のある閉じ端だけを 1 件報告する（健全な開き端は報告しない）。
  it.each([
    "小惑星はしばしば、**「太陽系の化石」**のような存在だと説明されます。",
    "つまり、**初代の感動をなぞる続編**ではなく、**成功と反省を取り込んだ“次の世代の再挑戦”**でした。",
    "**2019年4月**、はやぶさ2は**SCI（Small Carry-on Impactor：衝突装置）**を用いて人工クレーターを作りました。",
    "リュウグウから持ち帰られた試料量は、**約5.4g（小さじ1杯にも満たないごく少量）**と公表されています。",
    "これは当初の目標だった**100mg（0.1g）**を大きく上回る成果でした。",
  ])("reports exactly one unclosed issue at the closing ** in real data: %s", (input) => {
    const closingColumn = input.lastIndexOf("**") + 1; // 崩れている閉じ端はその行の最後の **
    expect(detectBrokenStrongEmphasis(input)).toEqual([
      { line: 1, column: closingColumn, kind: "unclosed", excerpt: input },
    ]);
  });

  it("reports exactly one unopened issue at the opening ** (left-flanking fails)", () => {
    const input = "これは**「太陽系」**の存在です。";
    const openingColumn = input.indexOf("**") + 1;
    expect(detectBrokenStrongEmphasis(input)).toEqual([
      { line: 1, column: openingColumn, kind: "unopened", excerpt: input },
    ]);
  });

  it("reports nothing for normal emphasis ending on a letter", () => {
    expect(detectBrokenStrongEmphasis("まず外せないのが**初代はやぶさ**です。")).toEqual([]);
  });

  it("reports nothing when punctuation sits outside the emphasis", () => {
    expect(detectBrokenStrongEmphasis("小惑星はしばしば、「**太陽系の化石**」のような存在です。")).toEqual([]);
    expect(detectBrokenStrongEmphasis("試料量は、**約5.4g**（ごく少量）と公表されています。")).toEqual([]);
  });

  it("does not report a healthy first bold when a later bold on the same line is broken", () => {
    const input = "**2019年4月**、はやぶさ2は**SCI（衝突装置）**を用いた。";
    const issues = detectBrokenStrongEmphasis(input);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("unclosed");
    expect(input.slice(issues[0].column - 1, issues[0].column + 1)).toBe("**");
    expect(issues[0].column).toBe(input.lastIndexOf("**") + 1);
  });

  it("does not flag symbol-terminated bold (℃ / ™ are not punctuation)", () => {
    expect(detectBrokenStrongEmphasis("気温は**30℃**を超えた。")).toEqual([]);
    expect(detectBrokenStrongEmphasis("**R&D™**は重要だ。")).toEqual([]);
  });

  it("flags ASCII-punctuation-terminated bold (+ and % are punctuation, cannot close)", () => {
    for (const input of ["**C++**を使う。", "**100%**を達成した。"]) {
      expect(detectBrokenStrongEmphasis(input)).toEqual([
        { line: 1, column: input.lastIndexOf("**") + 1, kind: "unclosed", excerpt: input },
      ]);
    }
  });

  it("ignores ** inside a fenced code block", () => {
    const input = "```\n**「太陽系の化石」**のような\n```";
    expect(detectBrokenStrongEmphasis(input)).toEqual([]);
  });

  it("does not close a 4-backtick fence on an inner 3-backtick line", () => {
    const input = "````\n```\n**「太陽系の化石」**のような\n```\n````";
    expect(detectBrokenStrongEmphasis(input)).toEqual([]);
  });

  it("does not treat a 4-space-indented ``` as a fence (still lints following body)", () => {
    // 先頭4スペースの ``` は fence ではない（CommonMark は最大3スペース）。後続の本文は通常どおり lint。
    const input = "    ```\n小惑星は、**「太陽系の化石」**のような存在です。";
    const line2 = input.split("\n")[1];
    expect(detectBrokenStrongEmphasis(input)).toEqual([
      { line: 2, column: line2.lastIndexOf("**") + 1, kind: "unclosed", excerpt: line2 },
    ]);
  });

  it("ignores ** inside an inline code span (single and double backticks)", () => {
    expect(detectBrokenStrongEmphasis("コードは `**「x」**の` のように書く。")).toEqual([]);
    expect(detectBrokenStrongEmphasis("コードは ``a `**「x」**の` b`` のように書く。")).toEqual([]);
  });

  it("ignores escaped \\*\\* (literal asterisks)", () => {
    expect(detectBrokenStrongEmphasis("ここは\\*\\*強調しない\\*\\*だけ。")).toEqual([]);
  });

  it("ignores single-asterisk / math-like usage (not a ** run)", () => {
    expect(detectBrokenStrongEmphasis("計算は a*b*c で、ポインタは *ptr です。")).toEqual([]);
  });

  it("reports the correct 1-based line and column", () => {
    const input = "見出し\n\n小惑星は、**「太陽系の化石」**のような存在です。";
    const line3 = input.split("\n")[2];
    expect(detectBrokenStrongEmphasis(input)).toEqual([
      { line: 3, column: line3.lastIndexOf("**") + 1, kind: "unclosed", excerpt: line3 },
    ]);
  });
});
