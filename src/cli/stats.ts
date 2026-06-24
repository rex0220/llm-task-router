import { SOURCES_BEGIN } from "./references";

// 記事本文の文字数を機械集計する（Qiita 等の分量チェック用）。汎用 awk/python を都度叩く代わりに、
// 参照ブロックの境界（references の SOURCES_BEGIN）を正本に、Python 非依存・クロスプラットフォームで再現する。
// - bodyChars: 参考ブロックを除外し、改行を除いた文字数（空白・コードは含む）。
//   awk 'length($0)' の行長合計（参考マーカー行以降は数えない）と一致する。
// - proseChars: fenced code を落とし、markup 記号と空白を除いた概算の散文文字数。

export interface ArticleStats {
  title: string | null;
  bodyChars: number;
  proseChars: number;
  hasReferencesBlock: boolean;
}

const FENCED_CODE_RE = /```[\s\S]*?```/g;
// 行頭・インラインの markup 記号（見出し/引用/箇条書き/表/リンク/強調/コード）を素朴に落とす。
const MARKUP_CHARS_RE = /[#>*|()[\]`\-]/g;
const H1_RE = /^#\s+/;

export function computeArticleStats(markdown: string): ArticleStats {
  const text = String(markdown ?? "");
  const hasReferencesBlock = text.includes(SOURCES_BEGIN);
  // 参考ブロック（機械生成の `## 参考`）以降は本文の分量に数えない。マーカー行自体も含めない。
  const beforeRefs = text.split(SOURCES_BEGIN)[0];

  // 本文文字数: 改行のみ除外（空白・コードは含む）。行長合計と一致する。
  const bodyChars = beforeRefs.replace(/\n/g, "").length;

  // 概算散文文字数: fenced code → markup 記号 → 空白 の順に落とした残り。
  const proseChars = beforeRefs
    .replace(FENCED_CODE_RE, "")
    .replace(MARKUP_CHARS_RE, "")
    .replace(/\s/g, "").length;

  // タイトル: 最初の H1（`# `）見出し。
  const titleLine = beforeRefs.split("\n").find((line) => H1_RE.test(line));
  const title = titleLine ? titleLine.replace(H1_RE, "").trim() : null;

  return { title, bodyChars, proseChars, hasReferencesBlock };
}

export function renderArticleStats(runId: string, fileName: string, stats: ArticleStats): string {
  const lines = [
    `runId: ${runId}`,
    `file: ${fileName}`,
    `title: ${stats.title ?? "(no H1)"}`,
    `body chars (参考ブロック除外・改行除外・コード含む): ${stats.bodyChars}`,
    `prose chars (コード/markup/空白 除外・概算): ${stats.proseChars}`,
  ];
  if (!stats.hasReferencesBlock) {
    lines.push(`note: 参考ブロック(${SOURCES_BEGIN})が無いため全文を本文として集計しました。`);
  }
  return lines.join("\n");
}
