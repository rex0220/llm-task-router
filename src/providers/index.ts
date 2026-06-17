import type { RouterConfig } from "../router/types";
import { resolveApiKeyEnv } from "../router/config";
import { AnthropicProvider } from "./AnthropicProvider";
import type { ModelProvider } from "./ModelProvider";
import { OpenAIProvider } from "./OpenAIProvider";

export function createProviders(config: RouterConfig, env: NodeJS.ProcessEnv = process.env): Record<string, ModelProvider> {
  const providers: Record<string, ModelProvider> = {};

  if (hasProviderReference(config, "openai")) {
    const keyEnv = resolveApiKeyEnv("openai", config);
    const apiKey = env[keyEnv] || env.OPENAI_API_KEY;
    if (apiKey) {
      providers.openai = new OpenAIProvider(apiKey);
    }
  }

  if (hasProviderReference(config, "anthropic")) {
    const keyEnv = resolveApiKeyEnv("anthropic", config);
    const apiKey = env[keyEnv] || env.ANTHROPIC_API_KEY;
    if (apiKey) {
      providers.anthropic = new AnthropicProvider(apiKey);
    }
  }

  return providers;
}

function hasProviderReference(config: RouterConfig, provider: string): boolean {
  return Object.values(config.tasks).some(
    (task) => task.primary.provider === provider || task.fallback?.some((candidate) => candidate.provider === provider)
  );
}
