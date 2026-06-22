// 本文全体が ```（言語名つきも可）で囲まれている場合のみ、その外側フェンスを除去する。
// 文中の正当なコードブロックには影響しない（先頭/末尾のフェンスが対になっている場合だけ剥がす）。
export function stripWrappingCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (!match) {
    return text;
  }

  const inner = match[1];
  // 内側にさらにフェンスが含まれる（=複数のコードブロックが並ぶ本文）なら、外側剥がしは誤りなので何もしない。
  if (inner.includes("```")) {
    return text;
  }

  return inner;
}

// 本文に紛れ込みやすい「ラップ文」（前置き・後置き・追加提案）を検知して警告文を返す。
// 自然文なので自動削除はせず、警告のみ（誤って正当な導入/結論を消さないため）。
export function detectWrapText(markdown: string): string[] {
  const warnings: string[] = [];
  const trimmed = markdown.trim();
  if (!trimmed) {
    return warnings;
  }

  const lines = trimmed.split("\n");

  // 前置きの検知は「見出しで始まるか」ではなく文言パターンで行う。
  // （Zenn/note などはタイトルが front-matter にあり、本文がリード文から始まるのが正しいため、
  //   見出し開始を必須にすると誤検知する。）
  const firstNonEmpty = lines.find((line) => line.trim() !== "")?.trim() ?? "";
  const preamblePatterns = [
    /^(以下|下記)(は|に|の)/,
    /改稿|書き直し|リライト|修正版|改訂版/,
    /^(here is|here's|below is)\b/i,
    /^(承知しました|了解しました|わかりました)/,
  ];
  if (preamblePatterns.some((pattern) => pattern.test(firstNonEmpty))) {
    warnings.push("冒頭に前置き（例:『以下は…改稿版です』）が混入している可能性があります。");
  }

  // 末尾が記事本文ではなく、追加提案・問いかけになっていないか（直近の数行を確認）。
  const tail = lines
    .filter((line) => line.trim() !== "")
    .slice(-3)
    .join("\n");
  const offerPatterns = [
    "出し直せ",
    "出し直し",
    "作り直せ",
    "作り直し",
    "ご要望",
    "ご希望",
    "いかがでしょうか",
    "どれかで",
    "いずれかで",
    "別の版",
    "他のバージョン",
    "お知らせください",
    "ご指定ください",
    "対応します",
  ];
  if (offerPatterns.some((pattern) => tail.includes(pattern))) {
    warnings.push("末尾に追加提案・問いかけ（例:『…で出し直せます』）が混入している可能性があります。");
  }

  return warnings;
}

// ── 強調 `**…**` レンダリング不備の検出（CommonMark フランキングの該当サブセット）──
// 日本語 × 約物に固有の問題: 閉じ `**` の直前（または開き `**` の直後）が約物だと
// right/left-flanking にならず `**` が文字のまま残る。詳細は
// docs/課題-対策-実装計画-強調マークダウンレンダリング.md / docs/強調マークダウンlint-implementation-plan.md。
//
// 対象は `**`（strong）のみ。`*`（イタリック）・`__`・`***` 以上・入れ子は対象外（明示）。
// コードフェンス / インラインコード / エスケープ `\*` は除外する。本文は書き換えない（検出のみ）。

export type EmphasisLintIssue = {
  line: number; // 1-based
  column: number; // 1-based（`**` の開始位置）
  kind: "unopened" | "unclosed"; // left-flanking 不成立 / right-flanking 不成立
  excerpt: string; // 該当行（前後を ** 含めて抜粋）
};

// 強調 lint ルールセットの版。対象パターン定義（フランキング判定・約物分類等）を変えたら上げる。
// 監査スタンプ（markdown-lint-stamp.json）に焼き込み、どのルールで通したかを後から追えるようにする。
export const STRONG_EMPHASIS_RULE_VERSION = "strong-emphasis-v1";

// lint 対象外の領域（コードフェンス内の各行・インラインコードスパン・エスケープ `\x`）を
// 同じ長さの 'A'（other 扱い）で潰す。行数・桁位置は保存するので line/column が原文と一致する。
function maskNonEmphasis(markdown: string): string {
  const lines = markdown.split("\n");
  let inFence = false;
  let fenceChar = "";
  let fenceLength = 0;
  const masked = lines.map((line) => {
    // CommonMark の fenced code block はインデント最大3スペース（4以上は indented code 扱い）。
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!inFence) {
      if (fence) {
        inFence = true;
        fenceChar = fence[1][0];
        fenceLength = fence[1].length;
        return "A".repeat(line.length);
      }
      return maskInline(line);
    }
    // フェンス内: 閉じフェンスは「同じ文字・開き以上の長さ・後続は空白のみ（info string なし）」。
    if (fence && fence[1][0] === fenceChar && fence[1].length >= fenceLength && fence[2].trim() === "") {
      inFence = false;
    }
    return "A".repeat(line.length);
  });
  return masked.join("\n");
}

// 1 行内のインラインコードスパンとエスケープを潰す。長さは保存する。
// backtick run はちょうど同じ長さの閉じ run までをコードスパンとして潰す（``code`` 等にも対応）。
function maskInline(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length) {
      out += "AA"; // エスケープした文字（`\*` 等）は非デリミタ化
      i += 2;
      continue;
    }
    if (c === "`") {
      let runEnd = i + 1;
      while (runEnd < line.length && line[runEnd] === "`") {
        runEnd++;
      }
      const runLength = runEnd - i;
      const close = findBacktickClose(line, runEnd, runLength);
      if (close >= 0) {
        out += "A".repeat(close - i); // 開き run〜閉じ run までコードスパンとして潰す
        i = close;
        continue;
      }
      out += line.slice(i, runEnd); // 閉じない backtick 列はコードでない＝リテラルのまま残す
      i = runEnd;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// from 以降で、ちょうど runLength 個連続する backtick 列の終端 index を返す（無ければ -1）。
function findBacktickClose(line: string, from: number, runLength: number): number {
  let p = from;
  while (p < line.length) {
    if (line[p] !== "`") {
      p += 1;
      continue;
    }
    let q = p;
    while (q < line.length && line[q] === "`") {
      q++;
    }
    if (q - p === runLength) {
      return q;
    }
    p = q;
  }
  return -1;
}

type CharClass = "whitespace" | "punctuation" | "other";

// ASCII punctuation（CommonMark 定義の 32 文字）。Unicode の P カテゴリに含まれない $ + < = > ^ ` | ~ を補う。
const ASCII_PUNCT_RE = /[!-/:-@[-`{-~]/;

function classifyChar(ch: string | undefined): CharClass {
  if (ch === undefined || /\s/.test(ch)) {
    return "whitespace";
  }
  // CommonMark の「punctuation」= ASCII punctuation または Unicode P カテゴリ。
  // 記号（\p{S}：℃ ™ ° 等）は punctuation ではない（false positive 防止のため含めない）。
  if (ASCII_PUNCT_RE.test(ch) || /\p{P}/u.test(ch)) {
    return "punctuation";
  }
  return "other";
}

// 公開: 本文から開閉できない `**` を行番号付きで返す。
export function detectBrokenStrongEmphasis(markdown: string): EmphasisLintIssue[] {
  const masked = maskNonEmphasis(markdown);
  const maskedLines = masked.split("\n");
  const rawLines = markdown.split("\n");
  const issues: EmphasisLintIssue[] = [];

  // 段落をまたぐ誤ペアリングを避けるため 1 行単位で判定する（対象データの崩れはすべて行内）。
  maskedLines.forEach((line, idx) => {
    const delimiters = collectStrongDelimiters(line);
    // 著者の意図に沿って前から 2 個ずつ「開き/閉じ」のペアとして局所判定する。
    // 1 span につき欠陥のある端だけを 1 件報告する（健全な相方は報告しない）。
    for (let k = 0; k + 1 < delimiters.length; k += 2) {
      const opener = delimiters[k];
      const closer = delimiters[k + 1];
      let broken: StrongDelimiter | undefined;
      let kind: EmphasisLintIssue["kind"] | undefined;
      if (!opener.canOpen) {
        broken = opener; // 開き側が left-flanking 不成立（内端の約物で開けない）
        kind = "unopened";
      } else if (!closer.canClose) {
        broken = closer; // 閉じ側が right-flanking 不成立（内端の約物で閉じられない）
        kind = "unclosed";
      }
      if (broken && kind) {
        // excerpt は column と整合させるため trim しない（先頭空白のある行で位置がずれないように）。
        issues.push({ line: idx + 1, column: broken.pos + 1, kind, excerpt: rawLines[idx] });
      }
    }
    // 奇数個の余り `**` は意図的なペアが取れないため Phase 1 では報告しない（false positive 抑止）。
  });

  return issues;
}

// 公開: 強調崩れを warning 文字列の配列で返す（verify-artifacts / 生成ワークフローで共用）。
// label を渡すと「final.md L..」のように対象ファイルを前置する。
export function strongEmphasisWarnings(markdown: string, options: { label?: string } = {}): string[] {
  const where = options.label ? `${options.label} ` : "";
  return detectBrokenStrongEmphasis(markdown).map((issue) => {
    const what = issue.kind === "unopened" ? "開けない **" : "閉じられない **";
    // 検出対象は CJK 約物だけでなく ASCII punctuation（+ % 等）も含むため、
    // 修正案は約物に限定せず汎用に示す（「+ を外へ」のような意味を変える誘導を避ける）。
    return (
      `強調がレンダリングされない可能性: ${where}L${issue.line}:${issue.column}（${what}）。` +
      `内端の句読点・記号で開閉できていません。句読点・記号を ** の外へ出す／強調範囲を調整する／閉じ ** の後に空白を入れる等で修正してください。`
    );
  });
}

type StrongDelimiter = { pos: number; canOpen: boolean; canClose: boolean };

// ちょうど 2 連の `*`（`**`）だけを候補にする（単独 `*`・`***` 以上は対象外）。
function collectStrongDelimiters(line: string): StrongDelimiter[] {
  const delimiters: StrongDelimiter[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "*") {
      i += 1;
      continue;
    }
    let j = i;
    while (j < line.length && line[j] === "*") {
      j++;
    }
    const runLength = j - i;
    if (runLength === 2) {
      const before = classifyChar(line[i - 1]);
      const after = classifyChar(line[j]);
      const leftFlanking =
        after !== "whitespace" && (after !== "punctuation" || before === "whitespace" || before === "punctuation");
      const rightFlanking =
        before !== "whitespace" && (before !== "punctuation" || after === "whitespace" || after === "punctuation");
      delimiters.push({ pos: i, canOpen: leftFlanking, canClose: rightFlanking });
    }
    i = j;
  }
  return delimiters;
}
