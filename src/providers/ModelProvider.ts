import type { ModelUsage } from "../router/types";

export type ProviderRequest = {
  model: string;
  system?: string;
  input: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  responseFormat?: {
    type: "text" | "json_schema";
    schemaName?: string;
    jsonSchema?: unknown;
  };
};

export type ProviderResponse = {
  text: string;
  usage?: ModelUsage;
  // 出力が max_tokens / max_output_tokens で打ち切られた場合 true。
  truncated?: boolean;
};

export interface ModelProvider {
  generate(request: ProviderRequest): Promise<ProviderResponse>;
}
