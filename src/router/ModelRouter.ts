import type { z } from "zod";
import type { ModelProvider, ProviderRequest, ProviderResponse } from "../providers/ModelProvider";
import { RunLogger } from "../logger/RunLogger";
import { schemaHints, schemaRegistry } from "../schemas";
import { estimateCostUsd } from "../utils/cost";
import { parseJsonObject } from "../utils/json";
import { withAbortableTimeout } from "../utils/timeout";
import { normalizeProviderError, RouterError, shouldFallback } from "./errors";
import type { ModelCandidate, ModelRequest, ModelResponse, RouterConfig, SchemaName } from "./types";

export class ModelRouter {
  constructor(
    private readonly providers: Record<string, ModelProvider>,
    private readonly config: RouterConfig,
    private readonly logger: RunLogger = new RunLogger()
  ) {}

  async run(request: ModelRequest): Promise<ModelResponse> {
    const taskConfig = this.config.tasks[request.task];
    if (!taskConfig) {
      throw new RouterError(`Task is not configured: ${request.task}`, "config");
    }

    if (request.schemaName && !schemaRegistry[request.schemaName]) {
      throw new RouterError(`Schema is not registered: ${request.schemaName}`, "config");
    }

    const candidates = [taskConfig.primary, ...(taskConfig.fallback ?? [])];
    let lastError: unknown;

    for (const candidate of candidates) {
      const provider = this.providers[candidate.provider];
      if (!provider) {
        lastError = new RouterError(`Provider is not registered: ${candidate.provider}`, "config");
        continue;
      }

      try {
        const startedAt = Date.now();
        const providerRequest = this.buildProviderRequest(request, candidate);
        const response = await this.callProvider(provider, providerRequest);
        const result = this.toModelResponse(candidate, response, Date.now() - startedAt);
        const validated = await this.validateAndMaybeRepair(provider, providerRequest, candidate, result, request.schemaName);
        await this.logger.logSuccess(request, validated);
        return validated;
      } catch (error) {
        const normalized = normalizeProviderError(error);
        lastError = normalized;
        await this.logger.logFailure(request, candidate, normalized);

        if (!shouldFallback(normalized.kind)) {
          throw normalized;
        }
      }
    }

    if (lastError) {
      const normalized = normalizeProviderError(lastError);
      throw new RouterError(`All model candidates failed: ${normalized.message}`, normalized.kind, normalized.statusCode);
    }

    throw new RouterError(`No model candidates configured for task: ${request.task}`, "config");
  }

  private buildProviderRequest(request: ModelRequest, candidate: ModelCandidate): ProviderRequest {
    const taskConfig = this.config.tasks[request.task];
    return {
      model: candidate.model,
      input: request.schemaName ? withSchemaInstruction(request.input, request.schemaName) : request.input,
      system: request.system,
      temperature: request.temperature ?? taskConfig.temperature,
      maxTokens: request.maxTokens ?? taskConfig.max_tokens,
      timeoutMs: taskConfig.timeout_ms ?? this.config.defaults.timeout_ms,
      responseFormat: request.schemaName ? { type: "json_schema", schemaName: request.schemaName } : { type: "text" },
    };
  }

  private async callProvider(provider: ModelProvider, request: ProviderRequest): Promise<ProviderResponse> {
    return withAbortableTimeout(request.timeoutMs, (abortSignal) => provider.generate({ ...request, abortSignal }));
  }

  private toModelResponse(candidate: ModelCandidate, response: ProviderResponse, elapsedMs: number): ModelResponse {
    const usage = response.usage ? { ...response.usage } : undefined;
    if (usage && usage.costUsd === undefined) {
      usage.costUsd = estimateCostUsd(usage, this.config.prices[candidate.provider]?.[candidate.model]);
    }

    return {
      provider: candidate.provider,
      model: candidate.model,
      text: response.text,
      usage,
      elapsedMs,
      truncated: response.truncated,
    };
  }

  private async validateAndMaybeRepair(
    provider: ModelProvider,
    originalRequest: ProviderRequest,
    candidate: ModelCandidate,
    response: ModelResponse,
    schemaName?: SchemaName
  ): Promise<ModelResponse> {
    if (!schemaName) {
      return response;
    }

    try {
      return this.validateResponse(response, schemaName);
    } catch (firstError) {
      if (normalizeProviderError(firstError).kind !== "schema_validation") {
        throw firstError;
      }
    }

    const repairRequest: ProviderRequest = {
      ...originalRequest,
      input: buildRepairPrompt(schemaName, response.text),
      temperature: 0,
      responseFormat: { type: "json_schema", schemaName },
    };

    const startedAt = Date.now();
    const repaired = await this.callProvider(provider, repairRequest);
    const repairedResponse = this.toModelResponse(candidate, repaired, Date.now() - startedAt);

    try {
      return this.validateResponse(repairedResponse, schemaName);
    } catch (repairError) {
      const reason = normalizeProviderError(repairError).message;
      // 打ち切りが原因なら、修復を何度試しても直らない。実際の対処（max_tokens増）へ誘導する。
      const truncated = response.truncated || repairedResponse.truncated;
      const hint = truncated
        ? " — output was truncated at max_tokens; raise max_tokens for this task and rerun"
        : "";
      throw new RouterError(
        `Model output failed ${schemaName} validation after one repair attempt: ${reason}${hint}`,
        "schema_validation"
      );
    }
  }

  private validateResponse(response: ModelResponse, schemaName: SchemaName): ModelResponse {
    const schema = schemaRegistry[schemaName];
    if (!schema) {
      throw new RouterError(`Schema is not registered: ${schemaName}`, "config");
    }

    const parsed = parseJsonObject(response.text);
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      throw new RouterError(
        `Model output did not match schema ${schemaName}: ${formatZodIssues(validated.error)}`,
        "schema_validation"
      );
    }

    return {
      ...response,
      text: `${JSON.stringify(validated.data, null, 2)}\n`,
    };
  }
}

function withSchemaInstruction(input: string, schemaName: SchemaName): string {
  return [
    input,
    "",
    "出力は次のJSONスキーマに厳密に従ってください。",
    "指定されたキーのみを含むJSONを返し、コードフェンスや説明文は付けないでください。",
    "",
    "JSONスキーマ:",
    schemaHints[schemaName],
  ].join("\n");
}

// zodの検証エラーを「フィールドパス: メッセージ」の短い列にまとめる。
// 打ち切りで途中欠落したのか、キー名が違うのかを一目で切り分けられるようにする。
function formatZodIssues(error: z.ZodError): string {
  const issues = error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
  const extra = error.issues.length > 3 ? ` (+${error.issues.length - 3} more)` : "";
  return `${issues.join("; ")}${extra}`;
}

function buildRepairPrompt(schemaName: SchemaName, invalidOutput: string): string {
  return [
    `The previous response did not match the ${schemaName} JSON schema.`,
    "Return only corrected JSON that uses exactly the keys below.",
    "Do not include markdown fences or commentary.",
    "",
    "JSON schema:",
    schemaHints[schemaName],
    "",
    "Invalid response:",
    invalidOutput,
  ].join("\n");
}
