import { describe, expect, it } from "vitest";
import { RunLogger } from "../../src/logger/RunLogger";
import type { ModelProvider, ProviderRequest, ProviderResponse } from "../../src/providers/ModelProvider";
import { ModelRouter } from "../../src/router/ModelRouter";
import { RouterError } from "../../src/router/errors";
import type { RouterConfig } from "../../src/router/types";
import { tmpLogPath } from "../helpers/tmp";

describe("ModelRouter", () => {
  it("falls back on rate limit errors", async () => {
    const primary = new QueueProvider([new RouterError("rate limited", "rate_limit")]);
    const fallback = new QueueProvider([{ text: "fallback ok" }]);
    const router = new ModelRouter(
      { primary, fallback },
      testConfig(),
      new RunLogger(tmpLogPath())
    );

    const result = await router.run({ task: "draft_markdown", input: "hello" });

    expect(result.provider).toBe("fallback");
    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(1);
  });

  it("does not fall back on auth errors", async () => {
    const primary = new QueueProvider([new RouterError("bad key", "auth")]);
    const fallback = new QueueProvider([{ text: "should not run" }]);
    const router = new ModelRouter(
      { primary, fallback },
      testConfig(),
      new RunLogger(tmpLogPath())
    );

    await expect(router.run({ task: "draft_markdown", input: "hello" })).rejects.toMatchObject({ kind: "auth" });
    expect(fallback.calls).toHaveLength(0);
  });

  it("does not fall back on billing quota errors", async () => {
    const primary = new QueueProvider([new RouterError("quota exhausted", "billing_quota", 429)]);
    const fallback = new QueueProvider([{ text: "should not run" }]);
    const router = new ModelRouter(
      { primary, fallback },
      testConfig(),
      new RunLogger(tmpLogPath())
    );

    await expect(router.run({ task: "draft_markdown", input: "hello" })).rejects.toMatchObject({
      kind: "billing_quota",
    });
    expect(fallback.calls).toHaveLength(0);
  });

  it("falls back when the primary provider times out", async () => {
    const primary = new HangingProvider();
    const fallback = new QueueProvider([{ text: "fallback after timeout" }]);
    const config = testConfig();
    config.defaults.timeout_ms = 20;
    const router = new ModelRouter(
      { primary, fallback },
      config,
      new RunLogger(tmpLogPath())
    );

    const result = await router.run({ task: "draft_markdown", input: "hello" });

    expect(result.provider).toBe("fallback");
    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(1);
  });

  it("repairs once, then falls back on schema validation failure", async () => {
    const primary = new QueueProvider([{ text: "not json" }, { text: "{ nope" }]);
    const fallback = new QueueProvider([
      {
        text: JSON.stringify({
          title: "T",
          tags: ["TypeScript"],
          targetReaders: ["engineer"],
          goal: ["learn"],
          mainClaim: "claim",
          sections: [{ heading: "H", points: ["P"] }],
          codeExamples: [{ language: "ts", purpose: "demo" }],
        }),
      },
    ]);
    const router = new ModelRouter(
      { primary, fallback },
      testConfig(),
      new RunLogger(tmpLogPath())
    );

    const result = await router.run({ task: "article_brief", input: "topic", schemaName: "ArticleBrief" });

    expect(result.provider).toBe("fallback");
    expect(primary.calls).toHaveLength(2);
    expect(fallback.calls).toHaveLength(1);
    expect(JSON.parse(result.text).title).toBe("T");
  });

  it("surfaces a truncation hint when validation keeps failing on truncated output", async () => {
    // {} はJSONとしては有効だが必須フィールドを欠く。truncated=true で打ち切り由来を示す。
    const truncatedInvalid: ProviderResponse = { text: "{}", truncated: true };
    const primary = new QueueProvider([truncatedInvalid, truncatedInvalid]);
    const fallback = new QueueProvider([truncatedInvalid, truncatedInvalid]);
    const router = new ModelRouter(
      { primary, fallback },
      testConfig(),
      new RunLogger(tmpLogPath())
    );

    await expect(
      router.run({ task: "article_brief", input: "topic", schemaName: "ArticleBrief" })
    ).rejects.toThrow(/truncated at max_tokens/);
    // 各候補で initial + repair の2回ずつ呼ばれる。
    expect(primary.calls).toHaveLength(2);
    expect(fallback.calls).toHaveLength(2);
  });

  it("names the failing field when validation fails without truncation", async () => {
    const invalid: ProviderResponse = { text: JSON.stringify({ title: "T" }) };
    const primary = new QueueProvider([invalid, invalid]);
    const router = new ModelRouter(
      { primary },
      testConfig(),
      new RunLogger(tmpLogPath())
    );

    const error = await router
      .run({ task: "outline", input: "topic", schemaName: "ArticleOutline" })
      .catch((e: unknown) => e as RouterError);

    expect(error).toBeInstanceOf(RouterError);
    expect((error as RouterError).message).toContain("sections");
    expect((error as RouterError).message).not.toContain("truncated at max_tokens");
  });

  it("does not call providers for an invalid schemaName", async () => {
    const primary = new QueueProvider([{ text: "should not run" }]);
    const router = new ModelRouter(
      { primary },
      testConfig(),
      new RunLogger(tmpLogPath())
    );

    await expect(
      router.run({ task: "draft_markdown", input: "hello", schemaName: "Missing" as never })
    ).rejects.toMatchObject({ kind: "config" });
    expect(primary.calls).toHaveLength(0);
  });
});

class QueueProvider implements ModelProvider {
  readonly calls: ProviderRequest[] = [];

  constructor(private readonly queue: Array<ProviderResponse | Error>) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(request);
    const next = this.queue.shift();
    if (next instanceof Error) {
      throw next;
    }
    if (!next) {
      throw new Error("No queued response");
    }
    return next;
  }
}

class HangingProvider implements ModelProvider {
  readonly calls: ProviderRequest[] = [];

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(request);
    return new Promise(() => undefined);
  }
}

function testConfig(): RouterConfig {
  return {
    providers: {},
    prices: {},
    defaults: { timeout_ms: 1000 },
    tasks: {
      article_brief: {
        primary: { provider: "primary", model: "p" },
        fallback: [{ provider: "fallback", model: "f" }],
      },
      outline: { primary: { provider: "primary", model: "p" } },
      draft_markdown: {
        primary: { provider: "primary", model: "p" },
        fallback: [{ provider: "fallback", model: "f" }],
      },
      technical_review: { primary: { provider: "primary", model: "p" } },
      final_review: { primary: { provider: "primary", model: "p" } },
      rewrite: { primary: { provider: "primary", model: "p" } },
      markdown_format: { primary: { provider: "primary", model: "p" } },
      title_suggestions: { primary: { provider: "primary", model: "p" } },
    },
  };
}
