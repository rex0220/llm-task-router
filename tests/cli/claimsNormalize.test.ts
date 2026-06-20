import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalUrl, claimHash, normalizeClaims, urlHash } from "../../src/cli/claimsNormalize";
import { ClaimsSchema, SourcesSchema } from "../../src/schemas/ClaimsSchema";
import { RunStore } from "../../src/storage/RunStore";

async function newStore(): Promise<RunStore> {
  return new RunStore(await mkdtemp(join(tmpdir(), "cn-runs-")));
}

async function seed(
  store: RunStore,
  runId: string,
  rawClaims: unknown[],
  rawSources: unknown[] = []
): Promise<void> {
  await store.create(runId, "T", ["final"], "Qiita");
  await store.save(runId, "claims.raw.json", JSON.stringify(rawClaims));
  await store.save(runId, "sources.raw.json", JSON.stringify(rawSources));
}

function rawClaim(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claim: "Opus 4.8 のモデルIDは claude-opus-4-8 である",
    location: { heading: "## モデル" },
    type: "api",
    status: "unverified",
    sourceRefs: [],
    severity: "major",
    note: "",
    ...over,
  };
}

describe("canonicalUrl", () => {
  it("strips utm_*, fragment, default port, trailing slash and sorts query", () => {
    const a = canonicalUrl("HTTPS://Example.com:443/docs/?utm_source=x&b=2&a=1#frag/");
    const b = canonicalUrl("https://example.com/docs?a=1&b=2");
    expect(a).toBe(b);
  });

  it("keeps path case and distinct paths distinct", () => {
    expect(urlHash("https://example.com/A")).not.toBe(urlHash("https://example.com/a"));
  });

  it("treats tracking-only differences as the same source key", () => {
    expect(urlHash("https://example.com/p?gclid=123")).toBe(urlHash("https://example.com/p"));
  });
});

describe("normalizeClaims", () => {
  it("assigns CNNN-<hash8> ids and resolves sourceRefs (by key and url) to SNNN", async () => {
    const store = await newStore();
    const runId = "2026-06-20-a";
    await seed(
      store,
      runId,
      [
        rawClaim({ status: "verified", sourceRefs: ["anthropic-models"] }),
        rawClaim({ claim: "別の主張", sourceRefs: ["https://example.com/pricing"] }),
      ],
      [
        { key: "anthropic-models", url: "https://docs.anthropic.com/models", title: "Models", retrievedAt: "2026-06-20", sourceType: "primary", summary: "" },
        { key: "px", url: "https://example.com/pricing", title: "Pricing", retrievedAt: "2026-06-20", sourceType: "secondary", summary: "" },
      ]
    );

    const summary = await normalizeClaims(store, runId, "full");
    expect(summary.present).toBe(2);
    expect(summary.removed).toBe(0);
    expect(summary.sources).toBe(2);

    const claims = ClaimsSchema.parse(JSON.parse(await store.read(runId, "claims.json")));
    const sources = SourcesSchema.parse(JSON.parse(await store.read(runId, "sources.json")));

    const c1 = claims.find((c) => c.claim.startsWith("Opus"));
    expect(c1?.id).toMatch(/^C001-[0-9a-f]{8}$/);
    expect(c1?.location.anchorHash).toBe(claimHash(c1!.claim));
    // key 参照と url 参照の両方が SNNN に解決される
    expect(c1?.sourceIds).toEqual(["S001"]);
    const c2 = claims.find((c) => c.claim === "別の主張");
    expect(c2?.sourceIds).toEqual(["S002"]);
    expect(sources.map((s) => s.id)).toEqual(["S001", "S002"]);
  });

  it("reuses the same id when the same claim reappears, and assigns a new id for a new claim", async () => {
    const store = await newStore();
    const runId = "2026-06-20-b";
    await seed(store, runId, [rawClaim()]);
    const first = await normalizeClaims(store, runId, "full");
    const id1 = ClaimsSchema.parse(JSON.parse(await store.read(runId, "claims.json")))[0].id;

    // 同じ claim ＋ 新規 claim を再投入
    await store.save(runId, "claims.raw.json", JSON.stringify([rawClaim(), rawClaim({ claim: "新しい主張" })]));
    const second = await normalizeClaims(store, runId, "full");
    expect(second.round).toBe(first.round + 1);

    const claims = ClaimsSchema.parse(JSON.parse(await store.read(runId, "claims.json")));
    const same = claims.find((c) => c.claim.startsWith("Opus"));
    expect(same?.id).toBe(id1); // 同一 claim は id 再利用
    expect(claims).toHaveLength(2);
  });

  it("marks a vanished claim removed on scope=full but keeps it on scope=diff", async () => {
    const store = await newStore();
    const runId = "2026-06-20-c";
    await seed(store, runId, [rawClaim({ claim: "A" }), rawClaim({ claim: "B" })]);
    await normalizeClaims(store, runId, "full");

    // B が本文から消えた観測（A だけ）
    await store.save(runId, "claims.raw.json", JSON.stringify([rawClaim({ claim: "A" })]));

    // diff 観測では removed にしない
    const diff = await normalizeClaims(store, runId, "diff");
    expect(diff.removed).toBe(0);
    let claims = ClaimsSchema.parse(JSON.parse(await store.read(runId, "claims.json")));
    expect(claims.find((c) => c.claim === "B")?.lifecycle).toBe("present");

    // full 観測では B を removed に落とす
    const full = await normalizeClaims(store, runId, "full");
    expect(full.removed).toBe(1);
    claims = ClaimsSchema.parse(JSON.parse(await store.read(runId, "claims.json")));
    expect(claims.find((c) => c.claim === "B")?.lifecycle).toBe("removed");
  });

  it("counts blocking = present + critical/major + unverified/needs-source/incorrect", async () => {
    const store = await newStore();
    const runId = "2026-06-20-d";
    await seed(store, runId, [
      rawClaim({ claim: "blk", severity: "critical", status: "needs-source" }),
      rawClaim({ claim: "ok-minor", severity: "minor", status: "incorrect" }),
      rawClaim({ claim: "ok-verified", severity: "major", status: "verified", sourceRefs: ["k"] }),
    ], [{ key: "k", url: "https://example.com/x", title: "", retrievedAt: "", sourceType: "secondary", summary: "" }]);

    const summary = await normalizeClaims(store, runId, "full");
    expect(summary.blocking).toBe(1);
  });

  it("seeds the ledger from the supersedes run so unchanged claims survive a diff update", async () => {
    const store = await newStore();
    const prevId = "2026-06-18-x";
    const newId = "2026-06-20-x-v2";

    // 公開版（前の run）: A,B を full で正規化して台帳を作る
    await seed(store, prevId, [rawClaim({ claim: "A" }), rawClaim({ claim: "B" })]);
    await normalizeClaims(store, prevId, "full");
    const prevClaims = ClaimsSchema.parse(JSON.parse(await store.read(prevId, "claims.json")));
    const prevBId = prevClaims.find((c) => c.claim === "B")!.id;

    // 更新 run: lineage で prev を指し、差分 raw は A だけ
    await store.create(newId, "T", ["final"], "Qiita");
    const meta = await store.readMeta(newId);
    meta.lineage = { supersedesRunId: prevId };
    await store.writeMeta(meta);
    await store.save(newId, "claims.raw.json", JSON.stringify([rawClaim({ claim: "A" })]));
    await store.save(newId, "sources.raw.json", "[]");

    const summary = await normalizeClaims(store, newId, "diff");
    // 差分に無い B も present のまま、id も引き継がれる
    expect(summary.present).toBe(2);
    expect(summary.removed).toBe(0);
    const claims = ClaimsSchema.parse(JSON.parse(await store.read(newId, "claims.json")));
    expect(claims.find((c) => c.claim === "A")?.lifecycle).toBe("present");
    const b = claims.find((c) => c.claim === "B");
    expect(b?.lifecycle).toBe("present");
    expect(b?.id).toBe(prevBId);
  });

  it("does not mutate the supersedes ledger and carries sources/sourceIds into the diff update", async () => {
    const store = await newStore();
    const prevId = "2026-06-18-y";
    const newId = "2026-06-20-y-v2";
    const src = { key: "k", url: "https://example.com/a", title: "A doc", retrievedAt: "2026-06-18", sourceType: "primary", summary: "" };

    // prev: A は verified + 出典、B は needs-source（出典なし）
    await seed(
      store,
      prevId,
      [rawClaim({ claim: "A", status: "verified", sourceRefs: ["k"] }), rawClaim({ claim: "B", type: "price", status: "needs-source" })],
      [src]
    );
    await normalizeClaims(store, prevId, "full");
    const prevLedgerBefore = await store.read(prevId, "claims-ledger.json");

    // new: lineage→prev、diff raw は A だけ（出典そのまま）
    await store.create(newId, "T", ["final"], "Qiita");
    const meta = await store.readMeta(newId);
    meta.lineage = { supersedesRunId: prevId };
    await store.writeMeta(meta);
    await store.save(newId, "claims.raw.json", JSON.stringify([rawClaim({ claim: "A", status: "verified", sourceRefs: ["k"] })]));
    await store.save(newId, "sources.raw.json", JSON.stringify([src]));

    await normalizeClaims(store, newId, "diff");

    // 前版台帳は不変（seed は deep copy）
    expect(await store.read(prevId, "claims-ledger.json")).toBe(prevLedgerBefore);

    // 新 run: A の sourceIds（S001 再利用）と sources.json、B の present が維持
    const claims = ClaimsSchema.parse(JSON.parse(await store.read(newId, "claims.json")));
    const sources = SourcesSchema.parse(JSON.parse(await store.read(newId, "sources.json")));
    expect(claims.find((c) => c.claim === "A")?.sourceIds).toEqual(["S001"]);
    expect(sources.map((s) => s.id)).toContain("S001");
    expect(claims.find((c) => c.claim === "B")?.lifecycle).toBe("present");
  });

  it("rejects a verified claim with no sourceRefs", async () => {
    const store = await newStore();
    const runId = "2026-06-20-e";
    await seed(store, runId, [rawClaim({ status: "verified", sourceRefs: [] })]);
    await expect(normalizeClaims(store, runId, "full")).rejects.toThrow();
  });

  it("rejects a sourceRef that resolves to no declared source", async () => {
    const store = await newStore();
    const runId = "2026-06-20-f";
    await seed(store, runId, [rawClaim({ sourceRefs: ["https://nowhere.example/none"] })]);
    await expect(normalizeClaims(store, runId, "full")).rejects.toThrow(/does not resolve/);
  });
});
