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
import {
  runEditorialReview,
  resolveWeakness,
  parseWeaknessResolution,
  collectUnsettledWeaknesses,
  countUnresolved,
} from "../../src/workflows/editorialReview";
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

  it("re-enforces independence after an imported run is revised by a model", async () => {
    // import 直後は external で免除されるが、revise が finalAuthorModel をモデル印に更新したら
    // imported が残っていても独立性チェックを復活させる（同 provider は除外して別 provider で回す）。
    const { store, runId } = await makeRun({ provider: "anthropic", model: "opus" }, { imported: true });
    const result = await runEditorialReview(routerReturning(REVIEW_JSON), store, runId);
    expect(result.reviewerModel.provider).toBe("openai");
  });

  it("fails on a generated run with no recorded finalAuthorModel", async () => {
    const { store, runId } = await makeRun(undefined);
    await expect(runEditorialReview(routerReturning(REVIEW_JSON), store, runId)).rejects.toThrow(/finalAuthorModel/);
  });

  it("a later independent full read closes prior open weaknesses it no longer reports", async () => {
    const { store, runId } = await makeRun({ provider: "openai", model: "gpt" });
    await runEditorialReview(routerReturning(REVIEW_JSON), store, runId); // round1: major+minor+pref open
    const ledger1 = JSON.parse(await store.read(runId, "editorial-ledger.json")) as LedgerView;
    const minorId = ledger1.weaknesses.find((w) => w.severity === "minor")!.id;
    const prefId = ledger1.weaknesses.find((w) => w.severity === "preference")!.id;

    // round2 独立: major と同内容だけを報告（minor/pref は出さない）
    const onlyMajor = JSON.stringify({
      verdict: "publication-candidate",
      scores: [{ axis: "構成", score: 9.5 }],
      strengths: ["改善"],
      weaknesses: [{ severity: "major", location: "導入", problem: "前提が不明", recommendation: "前提を1文足す" }],
      summary: "ほぼ",
    });
    const result = await runEditorialReview(routerReturning(onlyMajor), store, runId);
    expect(result.round).toBe(2);

    const ledger2 = JSON.parse(await store.read(runId, "editorial-ledger.json")) as LedgerView;
    // 再検出されなかった minor/pref は resolved に閉じられる
    expect(ledger2.weaknesses.find((w) => w.id === minorId)?.status).toBe("resolved");
    expect(ledger2.weaknesses.find((w) => w.id === prefId)?.status).toBe("resolved");
    // 候補は major のみ（古い minor は残らない）
    expect(result.candidateCount).toBe(1);
    const candidates = await store.read(runId, "editorial-instruction.candidates.md");
    expect(candidates).not.toContain("用語揺れ");
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

type ResolvedLedgerView = {
  weaknesses: {
    id: string;
    status: string;
    resolution?: string;
    resolutionEvidence?: string;
    resolvedAt?: string;
    resolvedRound?: number;
  }[];
};

describe("resolveWeakness", () => {
  it("parseWeaknessResolution accepts the four decisions and rejects others", () => {
    expect(parseWeaknessResolution("accepted")).toBe("accepted");
    expect(parseWeaknessResolution("user-approved")).toBe("user-approved");
    expect(() => parseWeaknessResolution("resolved")).toThrow(/Invalid resolution/);
  });

  it("writes the editor decision without touching reviewer status, and refreshes candidates/review.md immediately (fix1)", async () => {
    const { store, runId } = await makeRun({ provider: "openai", model: "gpt" });
    await runEditorialReview(routerReturning(REVIEW_JSON), store, runId);
    const before = JSON.parse(await store.read(runId, "editorial-ledger.json")) as LedgerView;
    const majorId = before.weaknesses.find((w) => w.severity === "major")!.id;

    const result = await resolveWeakness(store, runId, majorId, "accepted", "採用して revise 済み");
    expect(result).toEqual({ runId, id: majorId, resolution: "accepted", severity: "major" });

    const after = JSON.parse(await store.read(runId, "editorial-ledger.json")) as ResolvedLedgerView;
    const entry = after.weaknesses.find((w) => w.id === majorId)!;
    expect(entry.status).toBe("open"); // reviewer status は不変
    expect(entry.resolution).toBe("accepted");
    expect(entry.resolutionEvidence).toBe("採用して revise 済み");
    expect(entry.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.resolvedRound).toBe(1);

    // fix1: 再レビューを回さなくても reader 向け成果物が即時更新される。
    const candidates = await store.read(runId, "editorial-instruction.candidates.md");
    expect(candidates).not.toContain("前提が不明"); // 採用済み major は候補から消える
    expect(candidates).toContain("用語揺れ"); // 未処理 minor は残る
    const reviewMd = await store.read(runId, "editorial-review.md");
    expect(reviewMd).toContain("採否: accepted");
  });

  it("keeps an accepted weakness out of candidates once the reviewer stops reporting it", async () => {
    const { store, runId } = await makeRun({ provider: "openai", model: "gpt" });
    await runEditorialReview(routerReturning(REVIEW_JSON), store, runId);
    const ledger1 = JSON.parse(await store.read(runId, "editorial-ledger.json")) as LedgerView;
    const majorId = ledger1.weaknesses.find((w) => w.severity === "major")!.id;
    await resolveWeakness(store, runId, majorId, "accepted", "採用して revise 済み");

    // major を報告しない再レビュー → closeMissing で status=resolved、resolution は accepted のまま残り候補外。
    const onlyMinor = JSON.stringify({
      verdict: "publication-candidate",
      scores: [{ axis: "構成", score: 9.5 }],
      strengths: ["改善"],
      weaknesses: [{ severity: "minor", problem: "用語揺れ", recommendation: "統一する" }],
      summary: "ほぼ",
    });
    const result2 = await runEditorialReview(routerReturning(onlyMinor), store, runId);
    expect(result2.candidateCount).toBe(1);
    const after = JSON.parse(await store.read(runId, "editorial-ledger.json")) as ResolvedLedgerView;
    const entry = after.weaknesses.find((w) => w.id === majorId)!;
    expect(entry.status).toBe("resolved");
    expect(entry.resolution).toBe("accepted");
  });

  it("resurfaces an accepted weakness when a later review still reports it (fix2: stale resolution cleared)", async () => {
    const { store, runId } = await makeRun({ provider: "openai", model: "gpt" });
    await runEditorialReview(routerReturning(REVIEW_JSON), store, runId);
    const ledger1 = JSON.parse(await store.read(runId, "editorial-ledger.json")) as LedgerView;
    const majorId = ledger1.weaknesses.find((w) => w.severity === "major")!.id;
    await resolveWeakness(store, runId, majorId, "accepted", "採用したつもり（実は未修正）");

    // 同内容を再検出（改稿しても reviewer が同じ major を再び指摘）→ resolution を消して候補へ戻す。
    const result2 = await runEditorialReview(routerReturning(REVIEW_JSON), store, runId);
    expect(result2.candidateCount).toBe(2); // major 再浮上 + minor
    const candidates = await store.read(runId, "editorial-instruction.candidates.md");
    expect(candidates).toContain("前提が不明");
    const after = JSON.parse(await store.read(runId, "editorial-ledger.json")) as ResolvedLedgerView;
    const entry = after.weaknesses.find((w) => w.id === majorId)!;
    expect(entry.status).toBe("open");
    expect(entry.resolution).toBeUndefined();
  });

  it("rejects empty evidence and unknown ids", async () => {
    const { store, runId } = await makeRun({ provider: "openai", model: "gpt" });
    await runEditorialReview(routerReturning(REVIEW_JSON), store, runId);
    await expect(resolveWeakness(store, runId, "W001-xxxxxxxx", "waived", "理由")).rejects.toThrow(/台帳にありません/);
    const real = (JSON.parse(await store.read(runId, "editorial-ledger.json")) as LedgerView).weaknesses[0].id;
    await expect(resolveWeakness(store, runId, real, "waived", "   ")).rejects.toThrow(/evidence/);
  });

  it("fails when there is no ledger yet", async () => {
    const { store, runId } = await makeRun({ provider: "openai", model: "gpt" });
    await expect(resolveWeakness(store, runId, "W001-xxxxxxxx", "accepted", "理由")).rejects.toThrow(/台帳/);
  });
});

// countUnresolved の引数に合う precise 型（status/severity/resolution をリテラルで持つ）。
type GateLedgerView = {
  weaknesses: {
    id: string;
    severity: "major" | "minor" | "preference";
    status: "open" | "partial" | "resolved";
    resolution?: "accepted" | "waived" | "escalated" | "user-approved";
  }[];
};

describe("collectUnsettledWeaknesses (publication gate input)", () => {
  it("returns hasLedger=false (all empty) when no ledger exists", async () => {
    const { store, runId } = await makeRun({ provider: "openai", model: "gpt" });
    const gate = await collectUnsettledWeaknesses(store, runId);
    expect(gate).toEqual({ hasLedger: false, major: [], minor: [], preference: [] });
  });

  it("groups unresolved weaknesses by severity (REVIEW_JSON = 1 major/1 minor/1 preference, all open)", async () => {
    const { store, runId } = await makeRun({ provider: "openai", model: "gpt" });
    await runEditorialReview(routerReturning(REVIEW_JSON), store, runId);
    const gate = await collectUnsettledWeaknesses(store, runId);
    expect(gate.hasLedger).toBe(true);
    expect(gate.major).toHaveLength(1);
    expect(gate.minor).toHaveLength(1);
    expect(gate.preference).toHaveLength(1);
    expect(gate.major[0].reason).toBe("unresolved");
  });

  it("drops settled (accepted) weaknesses but keeps escalated as unsettled", async () => {
    const { store, runId } = await makeRun({ provider: "openai", model: "gpt" });
    await runEditorialReview(routerReturning(REVIEW_JSON), store, runId);
    const ledger = JSON.parse(await store.read(runId, "editorial-ledger.json")) as LedgerView;
    const majorId = ledger.weaknesses.find((w) => w.severity === "major")!.id;
    const minorId = ledger.weaknesses.find((w) => w.severity === "minor")!.id;
    await resolveWeakness(store, runId, majorId, "accepted", "採用して revise 済み");
    await resolveWeakness(store, runId, minorId, "escalated", "上申中");

    const gate = await collectUnsettledWeaknesses(store, runId);
    expect(gate.major).toHaveLength(0); // accepted は settled
    expect(gate.minor).toHaveLength(1); // escalated は未確定
    expect(gate.minor[0].reason).toBe("escalated");
    expect(gate.preference).toHaveLength(1); // 手付かず

    // user-approved にすると settled に転じる。
    await resolveWeakness(store, runId, minorId, "user-approved", "承認下りた");
    const gate2 = await collectUnsettledWeaknesses(store, runId);
    expect(gate2.minor).toHaveLength(0);
  });

  it("countUnresolved shares the predicate (open/partial & no resolution; escalated is NOT unresolved)", async () => {
    const { store, runId } = await makeRun({ provider: "openai", model: "gpt" });
    await runEditorialReview(routerReturning(REVIEW_JSON), store, runId);
    const ledger = JSON.parse(await store.read(runId, "editorial-ledger.json")) as GateLedgerView;
    expect(countUnresolved(ledger.weaknesses)).toBe(3); // 全 open・採否未設定

    const minorId = ledger.weaknesses.find((w) => w.severity === "minor")!.id;
    await resolveWeakness(store, runId, minorId, "escalated", "上申中");
    const after = JSON.parse(await store.read(runId, "editorial-ledger.json")) as GateLedgerView;
    // escalated は countUnresolved 上は「解決」扱い（resolution が付くため）= 2 件に減る。
    expect(countUnresolved(after.weaknesses)).toBe(2);
  });
});
