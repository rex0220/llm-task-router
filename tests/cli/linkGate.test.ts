import { describe, expect, it } from "vitest";
import { auditRuns, daysBetween, linkGate } from "../../src/cli/linkGate";
import type { Claim, Source } from "../../src/schemas/ClaimsSchema";

function claim(over: Partial<Claim> & Pick<Claim, "id" | "status" | "lifecycle" | "sourceIds">): Claim {
  return {
    claim: "x",
    location: { heading: "## h", anchorHash: "aaaaaaaa" },
    type: "general",
    severity: "minor",
    note: "",
    ...over,
  } as Claim;
}

function source(id: string, over: Partial<Source> = {}): Source {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `Title ${id}`,
    retrievedAt: "2026-06-01",
    sourceType: "secondary",
    summary: "",
    cited: true,
    ...over,
  };
}

// cited（present かつ verified）な1 claim が sourceIds を引く土台。
function citedClaim(sourceIds: string[]): Claim {
  return claim({ id: "C001-aaaaaaaa", status: "verified", lifecycle: "present", sourceIds });
}

const TODAY = "2026-06-25";

describe("daysBetween", () => {
  it("counts whole days between two YYYY-MM-DD dates", () => {
    expect(daysBetween("2026-06-25", "2026-06-25")).toBe(0);
    expect(daysBetween("2026-06-25", "2026-06-24")).toBe(1);
    expect(daysBetween("2026-06-25", "2026-03-27")).toBe(90);
  });
  it("returns NaN for malformed dates", () => {
    expect(Number.isNaN(daysBetween("2026-06", "2026-06-25"))).toBe(true);
    expect(Number.isNaN(daysBetween("2026-06-25", "garbage"))).toBe(true);
  });
});

describe("linkGate", () => {
  it("passes when every cited source is http-verified (checkedAt) and fresh + ok", () => {
    const claims = [citedClaim(["S001"])];
    const sources = [source("S001", { reachable: "ok", checkedAt: "2026-06-20" })];
    const r = linkGate(claims, sources, { today: TODAY });
    expect(r.pass).toBe(true);
    expect(r.fails).toEqual([]);
    expect(r.checkedCited).toBe(1);
  });

  it("FAILs a cited source with no checkedAt (unverified — the maibun case)", () => {
    const claims = [citedClaim(["S001"])];
    const sources = [source("S001", { reachable: "ok" })]; // checkedAt 無し＝LLM 自己申告止まり
    const r = linkGate(claims, sources, { today: TODAY });
    expect(r.pass).toBe(false);
    expect(r.fails.map((f) => f.category)).toEqual(["unverified"]);
  });

  it("FAILs a cited dead source", () => {
    const claims = [citedClaim(["S001"])];
    const sources = [source("S001", { reachable: "dead", checkedAt: "2026-06-20" })];
    const r = linkGate(claims, sources, { today: TODAY });
    expect(r.fails.map((f) => f.category)).toEqual(["dead"]);
  });

  it("FAILs a cited unknown source (checked but undecided)", () => {
    const claims = [citedClaim(["S001"])];
    const sources = [source("S001", { reachable: "unknown", checkedAt: "2026-06-20" })];
    const r = linkGate(claims, sources, { today: TODAY });
    expect(r.fails.map((f) => f.category)).toEqual(["unknown"]);
  });

  it("FAILs a stale ok source in export mode, warns in bulk mode", () => {
    const claims = [citedClaim(["S001"])];
    const sources = [source("S001", { reachable: "ok", checkedAt: "2026-01-01" })]; // > 90日前
    const asExport = linkGate(claims, sources, { today: TODAY, mode: "export" });
    expect(asExport.fails.map((f) => f.category)).toEqual(["stale"]);
    const asBulk = linkGate(claims, sources, { today: TODAY, mode: "bulk" });
    expect(asBulk.pass).toBe(true);
    expect(asBulk.warnings.map((f) => f.category)).toEqual(["stale"]);
  });

  it("legacyGrace downgrades unverified to a warning (but not dead/unknown)", () => {
    const claims = [claim({ id: "C001-aaaaaaaa", status: "verified", lifecycle: "present", sourceIds: ["S001", "S002"] })];
    const sources = [
      source("S001"), // checkedAt 無し → 旧 run では warning
      source("S002", { reachable: "dead", checkedAt: "2026-06-20" }), // dead は降格しない
    ];
    const r = linkGate(claims, sources, { today: TODAY, legacyGrace: true });
    expect(r.pass).toBe(false); // dead が残るので FAIL
    expect(r.fails.map((f) => f.category)).toEqual(["dead"]);
    expect(r.warnings.map((f) => f.category)).toEqual(["unverified"]);
  });

  it("ignores sources not cited by present&verified claims", () => {
    const claims = [
      claim({ id: "C001-aaaaaaaa", status: "unverified", lifecycle: "present", sourceIds: ["S001"] }), // 未検証→非cited
      claim({ id: "C002-bbbbbbbb", status: "verified", lifecycle: "removed", sourceIds: ["S002"] }), // removed→非cited
    ];
    const sources = [source("S001"), source("S002")];
    const r = linkGate(claims, sources, { today: TODAY });
    expect(r.checkedCited).toBe(0);
    expect(r.pass).toBe(true);
  });

  it("skips a cited id with no matching source (dangling — verify-artifacts の領分)", () => {
    const claims = [citedClaim(["S999"])];
    const sources = [source("S001", { reachable: "ok", checkedAt: "2026-06-20" })];
    const r = linkGate(claims, sources, { today: TODAY });
    expect(r.checkedCited).toBe(0);
    expect(r.pass).toBe(true);
  });
});

describe("auditRuns (提案E・bulk・記録ベース)", () => {
  it("flags stale as bulk warning, skips runs without ledgers, and reports clean runs", () => {
    const claims = [citedClaim(["S001"])];
    const fresh = [source("S001", { reachable: "ok", checkedAt: "2026-06-20" })];
    const stale = [source("S001", { reachable: "ok", checkedAt: "2026-01-01" })];
    const audits = auditRuns(
      [
        { runId: "r-fresh", claims, sources: fresh },
        { runId: "r-stale", claims, sources: stale },
        { runId: "r-missing", claims: null, sources: null },
      ],
      { today: TODAY }
    );
    expect(audits[0].result?.pass).toBe(true);
    expect(audits[0].result?.warnings).toEqual([]);
    // bulk モードでは stale は FAIL ではなく warning（一括点検は止めない）。
    expect(audits[1].result?.pass).toBe(true);
    expect(audits[1].result?.warnings.map((f) => f.category)).toEqual(["stale"]);
    expect(audits[2].result).toBeNull();
    expect(audits[2].skippedReason).toMatch(/normalize/);
  });
});
