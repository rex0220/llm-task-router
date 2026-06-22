import type { ModelRequest, ModelTask, SchemaName } from "../router/types";
import type { RunStore } from "../storage/RunStore";

export type QiitaStepName = "brief" | "outline" | "draft" | "review" | "final";

export type StepContext = { topic: string; platform: string; style?: string; runId: string; store: RunStore };

// 作法(style)があれば本文生成プロンプトに注入するブロックを返す。
function styleBlock(style?: string): string {
  return style ? `\n作法:\n${style}\n` : "";
}

// 強調 `**…**` の記述規約（第1層・予防）。日本語 × 約物だと CommonMark のフランキング規則で
// `**` が文字のまま残る（例: `**「…」**の` は閉じられない）。本文生成プロンプトに必ず注入する。
// 検出は src/utils/text.ts の detectBrokenStrongEmphasis（第2層・機械ゲート）が担う。
export const STRONG_EMPHASIS_RULE =
  "強調 **…** の内端（開き直後・閉じ直前）に約物（「」（）“”、。：等）を置かないでください。" +
  "括弧・引用符・読点は ** の外に出します（×**「太陽系の化石」**の → ○「**太陽系の化石**」の、" +
  "×**約5.4g（少量）**と → ○**約5.4g**（少量）と）。";

export type QiitaStep = {
  name: QiitaStepName;
  task: ModelTask;
  schemaName?: SchemaName;
  file: string;
  buildInput: (context: StepContext) => Promise<string>;
};

export const DEFAULT_PLATFORM = "Qiita";

export const qiitaSteps: QiitaStep[] = [
  {
    name: "brief",
    task: "article_brief",
    schemaName: "ArticleBrief",
    file: "brief.json",
    buildInput: async ({ topic, platform }) => `
次のテーマで${platform}記事のArticle Briefを作成してください。

テーマ:
${topic}

tags は${platform}向けの投稿タグを3〜5個。各タグはスペースを含まない短い語にする（例: TypeScript, Node.js, 生成AI）。
出力はJSON形式。
`.trim(),
  },
  {
    name: "outline",
    task: "outline",
    schemaName: "ArticleOutline",
    file: "outline.json",
    buildInput: async ({ runId, store, platform }) => {
      const brief = await store.read(runId, "brief.json");
      return `
次のArticle Briefから${platform}記事の構成を作ってください。

${brief}
`.trim();
    },
  },
  {
    name: "draft",
    task: "draft_markdown",
    file: "draft.md",
    buildInput: async ({ runId, store, platform, style }) => {
      const outline = await store.read(runId, "outline.json");
      return `
次の構成から${platform}向けMarkdown本文を書いてください。
記事はタイトルを最初の見出し（レベル1の "# "）として置き、続けて本文を書いてください。タイトルは構成(outline)の title を使ってください。
タイトル見出しと本文のみを出力してください。前置き・後書き・改稿の説明・追加提案や選択肢の提示は含めないでください。
${STRONG_EMPHASIS_RULE}
${styleBlock(style)}
${outline}
`.trim();
    },
  },
  {
    name: "review",
    task: "technical_review",
    schemaName: "ReviewResult",
    file: "review.json",
    buildInput: async ({ runId, store, platform }) => {
      const draft = await store.read(runId, "draft.md");
      return `
次の${platform}記事を技術レビューしてください。
問題点、改善案、修正すべき箇所をJSONで返してください。

${draft}
`.trim();
    },
  },
  {
    name: "final",
    task: "rewrite",
    file: "final.md",
    buildInput: async ({ runId, store, platform, style }) => {
      const draft = await store.read(runId, "draft.md");
      const review = await store.read(runId, "review.json");
      return `
次のレビューを反映して、${platform}記事を改善してください。
記事はタイトルの見出し（レベル1の "# "）から始めます。タイトル見出しは保持してください。
タイトル見出しと本文のみを出力してください。前置き・後書き・改稿の説明・追加提案や選択肢の提示は含めないでください。
${STRONG_EMPHASIS_RULE}
${styleBlock(style)}
記事:
${draft}

レビュー:
${review}
`.trim();
    },
  },
];

export function toModelRequest(step: QiitaStep, input: string): ModelRequest {
  return {
    task: step.task,
    input,
    schemaName: step.schemaName,
  };
}
