import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectFactcheckScope,
  decideFactcheckScope,
  readSnapshot,
  renderFactcheckScope,
  stampSnapshot,
  FACTCHECK_SNAPSHOT_FILE,
  type FactcheckScope,
} from "../../src/cli/factcheckScope";
import { RunStore } from "../../src/storage/RunStore";
import type { Claim } from "../../src/schemas/ClaimsSchema";

async function newStore(): Promise<RunStore> {
  return new RunStore(await mkdtemp(join(tmpdir(), "fs-runs-")));
}

const SNAP = ["# T", "## 価格", "旧 $10", "## 雑談", "余談A", "余談B", ""].join("\n");
// 価格を改定（del+add）、雑談から1行削除（added=0）。
const FINAL = ["# T", "## 価格", "新 $20", "## 雑談", "余談A", ""].join("\n");

function claimAt(heading: string): Claim {
  return {
    id: "C001-aaaaaaaa",
    claim: "価格は $10",
    location: { heading, anchorHash: "aaaaaaaa" },
    type: "price",
    status: "unverified",
    lifecycle: "present",
    sourceIds: [],
    severity: "major",
    note: "",
  };
}

describe("decideFactcheckScope", () => {
  it("returns full when there is no baseline snapshot", () => {
    expect(decideFactcheckScope(null, FINAL, null).mode).toBe("full");
  });

  it("returns skip when final is identical to the snapshot", () => {
    expect(decideFactcheckScope(SNAP, SNAP, null).mode).toBe("skip");
  });

  it("returns diff with recheck claims, discovery, and low-risk split (claims available)", () => {
    const scope = decideFactcheckScope(SNAP, FINAL, [claimAt("## 価格")]);
    expect(scope.mode).toBe("diff");
    if (scope.mode !== "diff") return;
    expect(scope.claimsAvailable).toBe(true);
    expect(scope.recheckClaims.map((c) => c.heading)).toEqual(["価格"]); // 変更セクションの claim
    expect(scope.discoverySections).toEqual(["価格"]); // added>0 のセクション
    // 雑談: 削除のみ・claim 無し → 低リスク。価格: 追加あり → 低リスクでない。
    expect(scope.lowRiskSections.map((s) => s.heading)).toEqual(["雑談"]);
  });

  it("does not compute low-risk when claims.json is absent (台帳が無いだけを低リスク扱いしない)", () => {
    const scope = decideFactcheckScope(SNAP, FINAL, null);
    expect(scope.mode).toBe("diff");
    if (scope.mode !== "diff") return;
    expect(scope.claimsAvailable).toBe(false);
    expect(scope.recheckClaims).toEqual([]);
    expect(scope.lowRiskSections).toEqual([]); // 全 changed section が通常対象
    expect(scope.changedSections.length).toBe(2); // 価格・雑談
  });

  it("treats a section reorder as a diff (safe side)", () => {
    const a = ["# T", "## A", "x", "## B", "y", ""].join("\n");
    const b = ["# T", "## B", "y", "## A", "x", ""].join("\n");
    expect(decideFactcheckScope(a, b, null).mode).toBe("diff");
  });
});

describe("stampSnapshot / readSnapshot", () => {
  it("returns null before stamping, and writes snapshot + audit meta on stamp", async () => {
    const store = await newStore();
    const runId = "2026-06-21-fs";
    await store.create(runId, "T", ["create"]);
    await store.save(runId, "final.md", FINAL);

    expect(await readSnapshot(store, runId)).toBeNull();

    const meta = await stampSnapshot(store, runId, "factcheck", "BLOCKING 0");
    expect(meta.acceptedAfter).toBe("factcheck");
    expect(meta.note).toBe("BLOCKING 0");
    expect(meta.finalHash).toMatch(/^[0-9a-f]{64}$/);

    const snap = await readSnapshot(store, runId);
    expect(snap).toBe(FINAL);
    const metaRaw = await store.read(runId, "factcheck.snapshot.meta.json");
    expect(JSON.parse(metaRaw).acceptedAfter).toBe("factcheck");
  });

  it("errors when final.md is missing", async () => {
    const store = await newStore();
    const runId = "2026-06-21-fs-nofinal";
    await store.create(runId, "T", ["create"]);
    await expect(stampSnapshot(store, runId, "factcheck", "x")).rejects.toThrow(/final\.md/);
  });
});

describe("collectFactcheckScope (end-to-end read)", () => {
  it("returns full first, skip after stamp with no change", async () => {
    const store = await newStore();
    const runId = "2026-06-21-fs-e2e";
    await store.create(runId, "T", ["create"]);
    await store.save(runId, "final.md", FINAL);

    expect((await collectFactcheckScope(store, runId)).mode).toBe("full");
    await stampSnapshot(store, runId, "factcheck", "done");
    expect((await collectFactcheckScope(store, runId)).mode).toBe("skip");

    await store.save(runId, "final.md", SNAP); // baseline と違う内容に
    expect((await collectFactcheckScope(store, runId)).mode).toBe("diff");
  });
});

describe("collectFactcheckScope claims handling", () => {
  async function seedDiff(store: RunStore, runId: string): Promise<void> {
    await store.create(runId, "T", ["create"]);
    await store.save(runId, "final.md", FINAL);
    await stampSnapshot(store, runId, "factcheck", "base");
    await store.save(runId, "final.md", SNAP); // baseline と差分を作る
  }

  it("throws when claims.json exists but is corrupt (not silently treated as absent)", async () => {
    const store = await newStore();
    const runId = "2026-06-21-fs-corrupt";
    await seedDiff(store, runId);
    await store.save(runId, "claims.json", "{ not valid json");
    await expect(collectFactcheckScope(store, runId)).rejects.toThrow(/claims\.json/);
  });

  it("treats missing claims.json as absent (claimsAvailable=false), not an error", async () => {
    const store = await newStore();
    const runId = "2026-06-21-fs-noclaims";
    await seedDiff(store, runId);
    const scope = await collectFactcheckScope(store, runId);
    expect(scope.mode).toBe("diff");
    if (scope.mode !== "diff") return;
    expect(scope.claimsAvailable).toBe(false);
  });

  it("falls back to supersedes-run claims when current run has none (enrich not silently dropped)", async () => {
    const store = await newStore();
    const prev = "2026-06-20-base";
    const runId = "2026-06-21-update";
    // 前版 run に claims.json
    await store.create(prev, "T", ["create"]);
    const claims = JSON.stringify([claimAt("## 価格")]);
    await store.save(prev, "claims.json", claims);
    // 更新 run: lineage で前版を指す。current claims は無し。
    await store.create(runId, "T", ["create"]);
    await store.save(runId, "final.md", FINAL);
    await stampSnapshot(store, runId, "factcheck", "base");
    await store.save(runId, "final.md", SNAP);
    const meta = await store.readMeta(runId);
    meta.lineage = { supersedesRunId: prev };
    await store.writeMeta(meta);

    const scope = await collectFactcheckScope(store, runId);
    expect(scope.mode).toBe("diff");
    if (scope.mode !== "diff") return;
    expect(scope.claimsAvailable).toBe(true);
    expect(scope.claimsSourceRunId).toBe(prev); // 前版から読んだことを記録
    expect(scope.recheckClaims.map((c) => c.heading)).toContain("価格");
  });
});

describe("renderFactcheckScope", () => {
  it("renders the three modes and notes claims absence", () => {
    expect(renderFactcheckScope({ mode: "full" }, "r")).toContain("full");
    expect(renderFactcheckScope({ mode: "skip" }, "r")).toContain("skip");
    const diff = decideFactcheckScope(SNAP, FINAL, null);
    const md = renderFactcheckScope(diff, "r");
    expect(md).toContain("diff");
    expect(md).toContain("claims.json なし");
  });
});
