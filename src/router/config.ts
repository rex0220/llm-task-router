import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { RouterError } from "./errors";
import type { ModelTask, RouterConfig } from "./types";

const modelTaskSchema = z.enum([
  "article_brief",
  "outline",
  "draft_markdown",
  "technical_review",
  "final_review",
  "rewrite",
  "markdown_format",
  "title_suggestions",
]);

const candidateSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});

const taskConfigSchema = z.object({
  primary: candidateSchema,
  fallback: z.array(candidateSchema).optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  timeout_ms: z.number().int().positive().optional(),
});

const routerConfigSchema = z.object({
  providers: z.record(z.object({ api_key_env: z.string().min(1).optional() })).default({}),
  prices: z
    .record(
      z.record(
        z.object({
          input_usd_per_1m_tokens: z.number().nonnegative().optional(),
          output_usd_per_1m_tokens: z.number().nonnegative().optional(),
        })
      )
    )
    .default({}),
  defaults: z.object({ timeout_ms: z.number().int().positive().default(120000) }).default({ timeout_ms: 120000 }),
  tasks: z.record(modelTaskSchema, taskConfigSchema),
});

export async function loadRouterConfig(path = "config/models.yaml"): Promise<RouterConfig> {
  const raw = await readFile(path, "utf8");
  const parsed = routerConfigSchema.safeParse(parse(raw));

  if (!parsed.success) {
    throw new RouterError(`Invalid router config: ${parsed.error.message}`, "config");
  }

  const config = parsed.data as RouterConfig;
  for (const [task, taskConfig] of Object.entries(config.tasks) as [ModelTask, RouterConfig["tasks"][ModelTask]][]) {
    if (!taskConfig.primary) {
      throw new RouterError(`Task ${task} is missing primary model`, "config");
    }
  }

  return config;
}

export function resolveApiKeyEnv(providerName: string, config: RouterConfig): string {
  const configured = config.providers[providerName]?.api_key_env;
  if (configured) {
    return configured;
  }

  switch (providerName) {
    case "openai":
      return "OPENAI_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "gemini":
      return "GEMINI_API_KEY";
    default:
      return `${providerName.toUpperCase()}_API_KEY`;
  }
}
