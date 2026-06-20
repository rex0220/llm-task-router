import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { selectRecheckClaims, writeClaimsRecheck } from "../../src/cli/claimsRecheck";
import type { Claim } from "../../src/schemas/ClaimsSchema";
import type { ChangedSection } from "../../src/cli/updateDiff";
import { RunStore } from "../../src/storage/RunStore";

async function newStore(): Promise<RunStore> {
  return new RunStore(await mkdtemp(join(tmpdir(), "cr-runs-")));
}

function claim(over: Partial<Claim> & { id: string; heading: string }): Claim {
  return {
    id: over.id,
    claim: over.claim ?? "主張",
    location: { heading: over.heading, anchorHash: "aaaaaaaa" },
    type: over.type ?? "general",
    status: over.status ?? "needs-source",
    lifecycle: over.lifecycle ?? "present",
    sourceIds: over.sourceIds ?? [],
    severity: over.severity ?? "minor",
    note: over.note ?? "",
  };
}

function section(heading: string): ChangedSection {
  return { heading, level: 2, added: 1, removed: 0 };
}

describe("selectRecheckClaims", () => {
  it("selects only claims whose heading is in a changed section", () => {
    const claims = [
      claim({ id: "C001-aaaaaaaa", heading: "## 料金", type: "price" }),
      claim({ id: "C002-bbbbbbbb", heading: "## まとめ", type: "general" }),
    ];
    const result = selectRecheckClaims(claims, [section("料金")]);
    expect(result.map((c) => c.id)).toEqual(["C001-aaaaaaaa"]);
  });

  it("orders stale-prone types (price/api/version) before technical/general", () => {
    const claims = [
      claim({ id: "C001-aaaaaaaa", heading: "## S", type: "general" }),
      claim({ id: "C002-bbbbbbbb", heading: "## S", type: "price" }),
      claim({ id: "C003-cccccccc", heading: "## S", type: "technical" }),
      claim({ id: "C004-dddddddd", heading: "## S", type: "api" }),
    ];
    const result = selectRecheckClaims(claims, [section("S")]);
    expect(result.map((c) => c.type)).toEqual(["price", "api", "technical", "general"]);
  });

  it("excludes removed claims even if their heading changed", () => {
    const claims = [
      claim({ id: "C001-aaaaaaaa", heading: "## S", lifecycle: "removed" }),
      claim({ id: "C002-bbbbbbbb", heading: "## S", lifecycle: "present" }),
    ];
    const result = selectRecheckClaims(claims, [section("S")]);
    expect(result.map((c) => c.id)).toEqual(["C002-bbbbbbbb"]);
  });

  it("matches headings regardless of leading # markers", () => {
    const claims = [claim({ id: "C001-aaaaaaaa", heading: "### 詳細" })];
    // changed-sections stores heading text without # markers
    const result = selectRecheckClaims(claims, [section("詳細")]);
    expect(result).toHaveLength(1);
  });
});

describe("writeClaimsRecheck", () => {
  it("writes claims-recheck.md with prioritized candidates", async () => {
    const store = await newStore();
    const runId = "2026-06-20-rc";
    await store.create(runId, "T", ["final"], "Qiita");
    await store.save(
      runId,
      "claims.json",
      JSON.stringify([
        claim({ id: "C001-aaaaaaaa", heading: "## 料金", type: "price", claim: "月額は X" }),
        claim({ id: "C002-bbbbbbbb", heading: "## 無関係", type: "general" }),
      ])
    );
    await store.save(runId, "changed-sections.json", JSON.stringify([section("料金")]));

    const result = await writeClaimsRecheck(store, runId);
    expect(result.candidates.map((c) => c.id)).toEqual(["C001-aaaaaaaa"]);

    const md = await store.read(runId, "claims-recheck.md");
    expect(md).toContain("C001-aaaaaaaa");
    expect(md).not.toContain("C002-bbbbbbbb");
    expect(md).toContain("優先（price / api / version）");
  });

  it("fails when changed-sections.json is missing (non-update run)", async () => {
    const store = await newStore();
    const runId = "2026-06-20-noupdate";
    await store.create(runId, "T", ["final"], "Qiita");
    await store.save(runId, "claims.json", JSON.stringify([claim({ id: "C001-aaaaaaaa", heading: "## S" })]));
    await expect(writeClaimsRecheck(store, runId)).rejects.toThrow();
  });
});
