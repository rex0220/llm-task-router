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
  constructor(private readonly json: string) {}
  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(request);
    return { text: this.json };
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

function routerReturning(json: string): ModelRouter {
  const fake = new FakeProvider(json);
  return new ModelRouter({ anthropic: fake, openai: fake }, editorialConfig(), new RunLogger(tmpLogPath()));
}

async function makeRun(
  finalAuthor?: ModelStamp | "external",
  opts: { imported?: boolean; final?: string } = {}
): Promise<{ store: RunStore; runId: string }> {
  const store = new RunStore(await mkdtemp(join(tmpdir(), "er-runs-")));
  const runId = "2026-06-20-er";
  await store.create(runId, "T", ["final"], "Qiita");
  await store.save(runId, "final.md", opts.final ?? "# T\n\n本文\n");
  const meta = await store.readMeta(runId);
  if (finalAuthor !== undefined) {
    meta.finalAuthorModel = finalAuthor;
  }
  if (opts.imported) {
    meta.imported = true;
  }
  await store.writeMeta(meta);
  return { store, runId };
}

type LedgerView = { round: number; lastSeq: number; weaknesses: { id: string; status: string; severity: string }[] };

describe("runEditorialReview (independent mode)", () => {
  it("excludes the final author's provider and reviews with a different provider", async () => {
    const { store, runId } = await makeRun({ provider: "openai", model: "gpt" });
    const result = await runEditorialReview(routerReturning(REVIEW_JSON), store, runId);

    expect(result.reviewerModel.provider).toBe("anthropic");
    expect(result.round).toBe(1);
    expect(result.candidateCount).toBe(2); // major + minor（preference 除外）
    expect(result.verdict).toBe("needs-revision");

    const normalized = JSON.parse(await store.read(runId, "editorial-review.json")) as {
      round: number;
      weaknesses: { id: string; status: string }[];
    };
    expect(normalized.round).toBe(1);
    expect(normalized.weaknesses).toHaveLength(3);
    expect(normalized.weaknesses.every((w) => w.status === "open")).toBe(true);
    expect(normalized.weaknesses[0].id).toMatch(/^W001-[0-9a-f]{8}$/);

    const candidates = await store.read(runId, "editorial-instruction.candidates.md");
    expect(candidates).toContain("## major");
    expect(candidates).toContain("## minor");
    expect(candidates).not.toContain("節タイトルが硬い"); // preference 内容は候補に含まれない

    // ラウンド成果物（継続の起点）
    await expect(store.read(runId, "editorial-r1-before.md")).resolves.toContain("本文");
    await expect(store.read(runId, "editorial-ledger.json")).resolves.toContain("W001");
  });

  it("--allow-same-provider drops only the exact model and uses another model of the same provider", async () => {
    const { store, runId } = await makeRun({ provider: "anthropic", model: "opus" });
    const result = await runEditorialReview(routerReturning(REVIEW_JSON), store, runId, { allowSameProvider: true });
    expect(result.reviewerModel).toEqual({ provider: "anthropic", model: "sonnet" });
  });

  it("exempts imported/external runs", async () => {
    const { store, runId } = await makeRun("external", { imported: true });
    const result = await runEditorialReview(routerReturning(REVIEW_JSON), store, runId);
    expect(result.reviewerModel).toEqual({ provider: "anthropic", model: "opus" });
  });

  it("fails on a generated run with no recorded finalAuthorModel", async () => {
    const { store, runId } = await makeRun(undefined);
    await expect(runEditorialReview(routerReturning(REVIEW_JSON), store, runId)).rejects.toThrow(/finalAuthorModel/);
  });
});

describe("runEditorialReview (continuation mode)", () => {
  it("tracks resolution, keeps forgotten ids open, adds new weaknesses, and overwrites the latest alias", async () => {
    const { store, runId } = await makeRun({ provider: "openai", model: "gpt" });
    // round 1（独立）で台帳を作る
    await runEditorialReview(routerReturning(REVIEW_JSON), store, runId);
    const ledger1 = JSON.parse(await store.read(runId, "editorial-ledger.json")) as LedgerView;
    const major = ledger1.weaknesses.find((w) => w.severity === "major")!;

    // 本文を改稿（since-last 差分が出るように）
    await store.save(runId, "final.md", "# T\n\n改稿後の本文\n");

    // 継続 round 2: major(W001) を resolved に、minor(W002) は返さない（open のまま）、新規を1件
    const contJson = JSON.stringify({
      verdict: "publication-candidate",
      scores: [{ axis: "構成", score: 9.5 }],
      strengths: ["改善された"],
      trackedWeaknesses: [{ id: major.id, status: "resolved", evidence: "前提を追記済み" }],
      newWeaknesses: [{ severity: "minor", problem: "新しい用語ミス", recommendation: "直す" }],
      summary: "ほぼ完成",
    });

    const result = await runEditorialReview(routerReturning(contJson), store, runId, { mode: "continuation" });
    expect(result.round).toBe(2);
    expect(result.mode).toBe("continuation");

    const ledger2 = JSON.parse(await store.read(runId, "editorial-ledger.json")) as LedgerView;
    expect(ledger2.round).toBe(2);
    // W001(major) は resolved
    expect(ledger2.weaknesses.find((w) => w.id === major.id)?.status).toBe("resolved");
    // minor(用語揺れ) は trackedに無いので open のまま
    const minorOrig = ledger1.weaknesses.find((w) => w.severity === "minor")!;
    expect(ledger2.weaknesses.find((w) => w.id === minorOrig.id)?.status).toBe("open");
    // 新規 weakness が採番されている（lastSeq 4 → W004）
    expect(ledger2.lastSeq).toBe(4);
    expect(ledger2.weaknesses.some((w) => w.id.startsWith("W004-"))).toBe(true);

    // 候補は open|partial の major|minor のみ（resolved 除外）→ 元 minor + 新 minor = 2
    expect(result.candidateCount).toBe(2);

    // 最新 alias が round2 で上書き、ラウンド成果物も残る
    const latest = JSON.parse(await store.read(runId, "editorial-review.json")) as { round: number };
    expect(latest.round).toBe(2);
    await expect(store.read(runId, "editorial-r2-review.json")).resolves.toContain("W004");
    await expect(store.read(runId, "editorial-r2-before.md")).resolves.toContain("改稿後");
  });

  it("fails when continuation is requested without a prior ledger", async () => {
    const { store, runId } = await makeRun({ provider: "openai", model: "gpt" });
    await expect(runEditorialReview(routerReturning(REVIEW_JSON), store, runId, { mode: "continuation" })).rejects.toThrow(
      /台帳/
    );
  });
});
