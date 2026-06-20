import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRouterConfig } from "../../src/router/config";

async function writeConfig(yaml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "router-config-"));
  const path = join(dir, "models.yaml");
  await writeFile(path, yaml, "utf8");
  return path;
}

describe("loadRouterConfig", () => {
  it("accepts an editorial_review task (enum includes it)", async () => {
    const path = await writeConfig(`
tasks:
  rewrite:
    primary: { provider: openai, model: gpt-5.4 }
  editorial_review:
    primary: { provider: anthropic, model: claude-opus }
    fallback:
      - { provider: openai, model: gpt-5.4 }
    temperature: 0.2
`);
    const config = await loadRouterConfig(path);
    expect(config.tasks.editorial_review.primary.provider).toBe("anthropic");
    expect(config.tasks.editorial_review.fallback?.[0].provider).toBe("openai");
  });

  it("rejects an unknown task name", async () => {
    const path = await writeConfig(`
tasks:
  not_a_task:
    primary: { provider: openai, model: gpt-5.4 }
`);
    await expect(loadRouterConfig(path)).rejects.toThrow(/Invalid router config/);
  });
});
