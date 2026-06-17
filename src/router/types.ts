import type { z } from "zod";

export type ModelTask =
  | "article_brief"
  | "outline"
  | "draft_markdown"
  | "technical_review"
  | "final_review"
  | "rewrite"
  | "markdown_format"
  | "title_suggestions";

export type SchemaName = "ArticleBrief" | "ArticleOutline" | "ReviewResult";

export type ModelRequest = {
  task: ModelTask;
  input: string;
  system?: string;
  schemaName?: SchemaName;
  maxTokens?: number;
  temperature?: number;
};

export type ModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
};

export type ModelResponse = {
  provider: string;
  model: string;
  text: string;
  usage?: ModelUsage;
  elapsedMs: number;
  truncated?: boolean;
};

export type ModelCandidate = {
  provider: string;
  model: string;
};

export type TaskConfig = {
  primary: ModelCandidate;
  fallback?: ModelCandidate[];
  temperature?: number;
  max_tokens?: number;
  timeout_ms?: number;
};

export type ProviderConfig = {
  api_key_env?: string;
};

export type ModelPrice = {
  input_usd_per_1m_tokens?: number;
  output_usd_per_1m_tokens?: number;
};

export type RouterConfig = {
  providers: Record<string, ProviderConfig>;
  prices: Record<string, Record<string, ModelPrice>>;
  defaults: {
    timeout_ms: number;
  };
  tasks: Record<ModelTask, TaskConfig>;
};

export type SchemaRegistry = Record<SchemaName, z.ZodTypeAny>;
