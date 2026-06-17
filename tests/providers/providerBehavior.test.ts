import { describe, expect, it } from "vitest";
import { supportsTemperature } from "../../src/providers/AnthropicProvider";
import { createProviders } from "../../src/providers";
import { supportsOpenAITemperature } from "../../src/providers/OpenAIProvider";
import type { RouterConfig } from "../../src/router/types";

describe("provider behavior", () => {
  it("skips providers whose API keys are not configured", () => {
    const providers = createProviders(providerConfig(), {
      OPENAI_API_KEY_ARTICLE: "openai-key",
    });

    expect(providers.openai).toBeDefined();
    expect(providers.anthropic).toBeUndefined();
  });

  it("guards unsupported Anthropic temperature models", () => {
    expect(supportsTemperature("claude-opus-4-8")).toBe(false);
    expect(supportsTemperature("claude-sonnet-4-6")).toBe(false);
    expect(supportsTemperature("claude-3-5-sonnet-latest")).toBe(true);
  });

  it("guards unsupported OpenAI temperature models", () => {
    expect(supportsOpenAITemperature("gpt-5.5")).toBe(false);
    expect(supportsOpenAITemperature("o3-mini")).toBe(false);
    expect(supportsOpenAITemperature("gpt-4o")).toBe(true);
  });
});

function providerConfig(): RouterConfig {
  return {
    providers: {
      openai: { api_key_env: "OPENAI_API_KEY_ARTICLE" },
      anthropic: { api_key_env: "ANTHROPIC_API_KEY_ARTICLE" },
    },
    prices: {},
    defaults: { timeout_ms: 1000 },
    tasks: {
      article_brief: {
        primary: { provider: "openai", model: "gpt-4o" },
        fallback: [{ provider: "anthropic", model: "claude-3-5-sonnet-latest" }],
      },
      outline: { primary: { provider: "openai", model: "gpt-4o" } },
      draft_markdown: { primary: { provider: "openai", model: "gpt-4o" } },
      technical_review: { primary: { provider: "openai", model: "gpt-4o" } },
      final_review: { primary: { provider: "openai", model: "gpt-4o" } },
      rewrite: { primary: { provider: "openai", model: "gpt-4o" } },
      markdown_format: { primary: { provider: "openai", model: "gpt-4o" } },
      title_suggestions: { primary: { provider: "openai", model: "gpt-4o" } },
    },
  };
}
