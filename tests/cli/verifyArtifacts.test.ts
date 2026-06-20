import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyArtifacts } from "../../src/cli/verifyArtifacts";
import { RunStore } from "../../src/storage/RunStore";

async function newStore(): Promise<RunStore> {
  return new RunStore(await mkdtemp(join(tmpdir(), "va-runs-")));
}

const PUB_OK = [
  "# Publication Check",
  "- GO/NO-GO: GO",
  "- factcheck: done",
  "- build-verify: skipped",
  "- build-verify summary: コードを含まない記事のため",
  "- editorial-review: done",
  "",
].join("\n");

// 非 blocking な claims.json（verified は出典必須なので sourceIds を持つ）。
const CLAIMS_OK = JSON.stringify([
  {
    id: "C001-aaaaaaaa",
    claim: "x",
    location: { heading: "## h", anchorHash: "aaaaaaaa" },
    type: "general",
    status: "verified",
    lifecycle: "present",
    sourceIds: ["S001"],
    severity: "minor",
    note: "",
  },
]);

const SOURCES_OK = JSON.stringify([
  { id: "S001", url: "https://example.com/doc", title: "Doc", retrievedAt: "2026-06-20", sourceType: "primary", summary: "" },
]);

// 揃った run（factcheck done＋claims.json/sources.json / build skipped＋理由 / editorial done）。
async function seedComplete(store: RunStore, runId: string): Promise<void> {
  await store.create(runId, "T", ["final"], "Qiita");
  await store.save(runId, "final.md", "# T\n本文\n");
  await store.save(runId, "final-review.md", "# review\n");
  await store.save(runId, "publication-check.md", PUB_OK);
  await store.save(runId, "factcheck-instruction.md", "- なし\n");
  await store.save(runId, "claims.json", CLAIMS_OK);
  await store.save(runId, "sources.json", SOURCES_OK);
  await store.save(runId, "editorial-review.md", "# editorial\n");
}

describe("verifyArtifacts", () => {
  it("passes when all required artifacts are present and gates declared", async () => {
    const store = await newStore();
    const runId = "2026-06-20-ok";
    await seedComplete(store, runId);
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("fails when final.md is missing", async () => {
    const store = await newStore();
    const runId = "2026-06-20-nofinal";
    await seedComplete(store, runId);
    await store.remove(runId, "final.md");
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/final\.md/);
  });

  it("fails when publication-check has no GO/NO-GO", async () => {
    const store = await newStore();
    const runId = "2026-06-20-nogo";
    await seedComplete(store, runId);
    await store.save(runId, "publication-check.md", "# Publication Check\n- factcheck: done\n- build-verify: skipped\n- build-verify summary: なし\n- editorial-review: done\n");
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/GO\/NO-GO/);
  });

  it("fails when a gate is not declared (no silent skip)", async () => {
    const store = await newStore();
    const runId = "2026-06-20-nogate";
    await seedComplete(store, runId);
    await store.save(runId, "publication-check.md", "# Publication Check\n- GO/NO-GO: GO\n- factcheck: done\n- editorial-review: done\n");
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/build-verify ゲート/);
  });

  it("fails when build-verify report exists but the gate is not declared", async () => {
    const store = await newStore();
    const runId = "2026-06-20-reportnogate";
    await seedComplete(store, runId);
    // build-verify ゲート行を消すが report は置く → report 有無と独立に宣言を必須にする
    await store.save(runId, "publication-check.md", "# Publication Check\n- GO/NO-GO: GO\n- factcheck: done\n- editorial-review: done\n");
    await store.save(runId, "build-verify-report.json", JSON.stringify({ status: "passed", checkedBlocks: [], unverified: [] }));
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/build-verify ゲート/);
  });

  it("fails when factcheck=done but claims.json is missing", async () => {
    const store = await newStore();
    const runId = "2026-06-20-noclaims";
    await seedComplete(store, runId);
    await store.remove(runId, "claims.json");
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/claims\.json/);
  });

  it("fails when a skipped gate has no skip reason", async () => {
    const store = await newStore();
    const runId = "2026-06-20-noskipreason";
    await seedComplete(store, runId);
    // build-verify: skipped だが summary 行を外す
    await store.save(runId, "publication-check.md", "# Publication Check\n- GO/NO-GO: GO\n- factcheck: done\n- build-verify: skipped\n- editorial-review: done\n");
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/build-verify summary/);
  });

  it("fails when a verified claim has empty sourceIds (claims.json schema refine)", async () => {
    const store = await newStore();
    const runId = "2026-06-20-verifiednosrc";
    await seedComplete(store, runId);
    await store.save(
      runId,
      "claims.json",
      JSON.stringify([
        {
          id: "C001-aaaaaaaa",
          claim: "x",
          location: { heading: "## h", anchorHash: "aaaaaaaa" },
          type: "api",
          status: "verified",
          lifecycle: "present",
          sourceIds: [],
          severity: "critical",
          note: "",
        },
      ])
    );
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/スキーマ不適合|sourceId/);
  });

  it("fails when a claim's sourceId is not present in sources.json", async () => {
    const store = await newStore();
    const runId = "2026-06-20-dangling";
    await seedComplete(store, runId);
    await store.save(
      runId,
      "claims.json",
      JSON.stringify([
        {
          id: "C001-aaaaaaaa",
          claim: "x",
          location: { heading: "## h", anchorHash: "aaaaaaaa" },
          type: "api",
          status: "verified",
          lifecycle: "present",
          sourceIds: ["S999"],
          severity: "minor",
          note: "",
        },
      ])
    );
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/存在しません/);
  });

  it("fails when claims.json exists but sources.json is missing", async () => {
    const store = await newStore();
    const runId = "2026-06-20-nosources";
    await seedComplete(store, runId);
    await store.remove(runId, "sources.json");
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/sources\.json/);
  });

  it("fails on blocking claims in claims.json", async () => {
    const store = await newStore();
    const runId = "2026-06-20-blk";
    await seedComplete(store, runId);
    await store.save(
      runId,
      "claims.json",
      JSON.stringify([
        {
          id: "C001-aaaaaaaa",
          claim: "x",
          location: { heading: "## h", anchorHash: "aaaaaaaa" },
          type: "api",
          status: "needs-source",
          lifecycle: "present",
          sourceIds: [],
          severity: "critical",
          note: "",
        },
      ])
    );
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/blocking/);
  });

  it("fails when build-verify-report is skipped without a skipReason", async () => {
    const store = await newStore();
    const runId = "2026-06-20-skip";
    await seedComplete(store, runId);
    await store.save(runId, "build-verify-report.json", JSON.stringify({ status: "skipped", checkedBlocks: [], unverified: [] }));
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/skipReason/);
  });

  it("warns (not fails) when build-verify-report is a valid skip", async () => {
    const store = await newStore();
    const runId = "2026-06-20-skipok";
    await seedComplete(store, runId);
    await store.save(
      runId,
      "build-verify-report.json",
      JSON.stringify({ status: "skipped", skipReason: "コードを含まない記事", checkedBlocks: [], unverified: [] })
    );
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(true);
    expect(r.warnings.join("\n")).toMatch(/skipped/);
  });
});
