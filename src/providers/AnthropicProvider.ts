import Anthropic from "@anthropic-ai/sdk";
import { RouterError } from "../router/errors";
import type { ModelProvider, ProviderRequest, ProviderResponse } from "./ModelProvider";

export class AnthropicProvider implements ModelProvider {
  private readonly client: Anthropic;

  constructor(apiKey: string | undefined, options: { maxRetries?: number; timeoutMs?: number } = {}) {
    if (!apiKey) {
      throw new RouterError("Anthropic API key is not configured", "auth");
    }

    this.client = new Anthropic({
      apiKey,
      maxRetries: options.maxRetries ?? 2,
      timeout: options.timeoutMs,
    });
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens ?? 4000,
      messages: [{ role: "user", content: request.input }],
    };

    if (request.system) {
      body.system = request.system;
    }

    if (supportsTemperature(request.model) && request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    const response = await this.client.messages.create(body as never, {
      signal: request.abortSignal,
    });

    return {
      text: extractAnthropicText(response),
      usage: response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          }
        : undefined,
      truncated: (response as { stop_reason?: unknown }).stop_reason === "max_tokens",
    };
  }
}

export function supportsTemperature(model: string): boolean {
  const normalized = model.toLowerCase();
  return !(
    normalized.includes("opus") ||
    normalized.includes("sonnet-4") ||
    normalized.includes("haiku-4") ||
    normalized.includes("fable")
  );
}

function extractAnthropicText(response: unknown): string {
  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}
