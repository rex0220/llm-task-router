import type { ModelRequest, ModelTask, SchemaName } from "../router/types";
import type { RunStore } from "../storage/RunStore";

export type QiitaStepName = "brief" | "outline" | "draft" | "review" | "final";

export type StepContext = { topic: string; platform: string; style?: string; runId: string; store: RunStore };

// 作法(style)があれば本文生成プロンプトに注入するブロックを返す。
function styleBlock(style?: string): string {
  return style ? `\n作法:\n${style}\n` : "";
}

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
記事本文のみを出力してください。前置き・後書き・改稿の説明・追加提案や選択肢の提示は含めないでください。
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
記事本文のみを出力してください。前置き・後書き・改稿の説明・追加提案や選択肢の提示は含めないでください。
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
