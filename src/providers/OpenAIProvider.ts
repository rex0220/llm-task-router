import OpenAI from "openai";
import { RouterError } from "../router/errors";
import type { ModelProvider, ProviderRequest, ProviderResponse } from "./ModelProvider";

export class OpenAIProvider implements ModelProvider {
  private readonly client: OpenAI;

  constructor(apiKey: string | undefined, options: { maxRetries?: number; timeoutMs?: number } = {}) {
    if (!apiKey) {
      throw new RouterError("OpenAI API key is not configured", "auth");
    }

    this.client = new OpenAI({
      apiKey,
      maxRetries: options.maxRetries ?? 2,
      timeout: options.timeoutMs,
    });
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      input: request.input,
    };

    if (request.system) {
      body.instructions = request.system;
    }

    if (request.maxTokens) {
      body.max_output_tokens = request.maxTokens;
    }

    if (supportsOpenAITemperature(request.model) && request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.responseFormat?.type === "json_schema") {
      body.text = { format: { type: "json_object" } };
    }

    const response = await this.client.responses.create(body as never, {
      signal: request.abortSignal,
    });

    const usage = response.usage
      ? {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        }
      : undefined;

    return {
      text: extractOpenAIText(response),
      usage,
      truncated: isOpenAITruncated(response),
    };
  }
}

function isOpenAITruncated(response: unknown): boolean {
  const r = response as { status?: unknown; incomplete_details?: { reason?: unknown } };
  return r.status === "incomplete" && r.incomplete_details?.reason === "max_output_tokens";
}

export function supportsOpenAITemperature(model: string): boolean {
  const normalized = model.toLowerCase();
  return !(
    normalized.startsWith("o") ||
    normalized.startsWith("gpt-5") ||
    normalized.includes("reasoning")
  );
}

function extractOpenAIText(response: unknown): string {
  const outputText = (response as { output_text?: unknown }).output_text;
  if (typeof outputText === "string") {
    return outputText;
  }

  const output = (response as { output?: unknown }).output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output) {
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) {
        continue;
      }
      for (const block of content) {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") {
          parts.push(text);
        }
      }
    }
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }

  return "";
}
