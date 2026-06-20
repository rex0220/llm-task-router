import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunLogger } from "../../src/logger/RunLogger";
import type { ModelProvider, ProviderRequest, ProviderResponse } from "../../src/providers/ModelProvider";
import { ModelRouter } from "../../src/router/ModelRouter";
import type { RouterConfig } from "../../src/router/types";
import { RunStore } from "../../src/storage/RunStore";
import type { ModelStamp } from "../../src/storage/RunStore";
import { runEditorialReview } from "../../src/workflows/editorialReview";
import { tmpLogPath } from "../helpers/tmp";

const REVIEW_JSON = JSON.stringify({
  verdict: "needs-revision",
  scores: [{ axis: "構成", score: 9 }],
  strengths: ["流れが良い"],
  weaknesses: [
    { severity: "major", location: "導入", problem: "前提が不明", recommendation: "前提を1文足す" },
    { severity: "minor", problem: "用語揺れ", recommendation: "統一する" },
    { severity: "preference", problem: "節タイトルが硬い", recommendation: "やわらかく" },
  ],
  summary: "良いが要修正",
});

class FakeProvider implements ModelProvider {
  readonly calls: ProviderRequest[] = [];
  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(request);
    return { text: REVIEW_JSON };
  }
}

function editorialConfig(): RouterConfig {
  const t = { primary: { provider: "x", model: "m" } };
  return {
    providers: {},
    prices: {},
    defaults: { timeout_ms: 1000 },
    tasks: {
      article_brief: t,
      outline: t,
      draft_markdown: t,
      technical_review: t,
      final_review: t,
      rewrite: t,
      markdown_format: t,
      title_suggestions: t,
      // anthropic 2 + openai 1（両 provider をまたぐ）。
      editorial_review: {
        primary: { provider: "anthropic", model: "opus" },
        fallback: [
          { provider: "anthropic", model: "sonnet" },
          { provider: "openai", model: "gpt" },
        ],
      },
    },
  };
}

async function makeRun(finalAuthor?: ModelStamp | "external", opts: { imported?: boolean } = {}): Promise<{
  store: RunStore;
  router: ModelRouter;
  runId: string;
}> {
  const store = new RunStore(await mkdtemp(join(tmpdir(), "er-runs-")));
  const runId = "2026-06-20-er";
  await store.create(runId, "T", ["final"], "Qiita");
  await store.save(runId, "final.md", "# T\n\n本文\n");
  const meta = await store.readMeta(runId);
  if (finalAuthor !== undefined) {
    meta.finalAuthorModel = finalAuthor;
  }
  if (opts.imported) {
    meta.imported = true;
  }
  await store.writeMeta(meta);
  const fake = new FakeProvider();
  const router = new ModelRouter({ anthropic: fake, openai: fake }, editorialConfig(), new RunLogger(tmpLogPath()));
  return { store, router, runId };
}

describe("runEditorialReview (independent mode)", () => {
  it("excludes the final author's provider and reviews with a different provider", async () => {
    const { store, router, runId } = await makeRun({ provider: "openai", model: "gpt" });
    const result = await runEditorialReview(router, store, runId);

    expect(result.reviewerModel.provider).toBe("anthropic"); // openai を除外 → anthropic
    expect(result.candidateCount).toBe(2); // major + minor（preference 除外）
    expect(result.verdict).toBe("needs-revision");

    const meta = await store.readMeta(runId);
    expect(meta.reviewerModel?.provider).toBe("anthropic");

    const normalized = JSON.parse(await store.read(runId, "editorial-review.json")) as {
      weaknesses: { id: string; status: string; severity: string }[];
    };
    expect(normalized.weaknesses).toHaveLength(3);
    expect(normalized.weaknesses.every((w) => w.status === "open")).toBe(true);
    expect(normalized.weaknesses[0].id).toMatch(/^W001-[0-9a-f]{8}$/);

    const candidates = await store.read(runId, "editorial-instruction.candidates.md");
    expect(candidates).toContain("## major");
    expect(candidates).toContain("## minor");
    // preference 弱みの内容は候補に含まれない（ヘッダ説明文に "preference" 語は出るので内容で判定）。
    expect(candidates).not.toContain("節タイトルが硬い");
  });

  it("falls through to openai when the final author is anthropic", async () => {
    const { store, router, runId } = await makeRun({ provider: "anthropic", model: "opus" });
    const result = await runEditorialReview(router, store, runId);
    expect(result.reviewerModel.provider).toBe("openai");
  });

  it("--allow-same-provider drops only the exact model and uses another model of the same provider", async () => {
    const { store, router, runId } = await makeRun({ provider: "anthropic", model: "opus" });
    const result = await runEditorialReview(router, store, runId, { allowSameProvider: true });
    expect(result.reviewerModel).toEqual({ provider: "anthropic", model: "sonnet" }); // opus は除外、sonnet へ
  });

  it("exempts imported/external runs from the independence check", async () => {
    const { store, router, runId } = await makeRun("external", { imported: true });
    const result = await runEditorialReview(router, store, runId);
    expect(result.reviewerModel).toEqual({ provider: "anthropic", model: "opus" }); // 除外なし → primary
  });

  it("fails on a generated run with no recorded finalAuthorModel", async () => {
    const { store, router, runId } = await makeRun(undefined); // 未記録・非 imported
    await expect(runEditorialReview(router, store, runId)).rejects.toThrow(/finalAuthorModel/);
  });
});
