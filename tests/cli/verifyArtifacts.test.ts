import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyArtifacts } from "../../src/cli/verifyArtifacts";
import { RunStore } from "../../src/storage/RunStore";
import { RunProgress } from "../../src/progress/RunProgress";

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

// build-verify: done を宣言する版（report と整合させる用）。
const PUB_BUILD_DONE = [
  "# Publication Check",
  "- GO/NO-GO: GO",
  "- factcheck: done",
  "- build-verify: done",
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

const BUILD_ENV = { node: "v20.18.0", typescript: "5.8.3" };

// 揃った run（factcheck done＋claims.json/sources.json / build skipped＋理由 / editorial done）。
async function seedComplete(
  store: RunStore,
  runId: string,
  opts: { ledger?: string | null } = {}
): Promise<void> {
  await store.create(runId, "T", ["final"], "Qiita");
  await store.save(runId, "final.md", "# T\n本文\n");
  await store.save(runId, "final-review.md", "# review\n");
  await store.save(runId, "publication-check.md", PUB_OK);
  await store.save(runId, "factcheck-instruction.md", "- なし\n");
  await store.save(runId, "claims.json", CLAIMS_OK);
  await store.save(runId, "sources.json", SOURCES_OK);
  await store.save(runId, "editorial-review.md", "# editorial\n");
  // editorial-review=done を宣言しているので台帳も必須。既定は未確定 0（weaknesses 空）。
  // ledger:null を渡すと台帳を書かない（台帳欠落ケースの検証用）。
  const ledger = opts.ledger === undefined ? LEDGER_EMPTY : opts.ledger;
  if (ledger !== null) {
    await store.save(runId, "editorial-ledger.json", ledger);
  }
}

const LEDGER_EMPTY = JSON.stringify({ round: 1, lastSeq: 0, weaknesses: [] });

// 任意 severity・resolution の weakness を 1 件持つ台帳を作るヘルパー（新ゲートのテスト用）。
function ledgerWith(
  severity: "major" | "minor" | "preference",
  opts: { status?: "open" | "partial" | "resolved"; resolution?: string } = {}
): string {
  return JSON.stringify({
    round: 1,
    lastSeq: 1,
    weaknesses: [
      {
        severity,
        location: "L",
        problem: "P",
        recommendation: "R",
        id: `W001-${severity}`,
        hash: "deadbeef",
        status: opts.status ?? "open",
        firstRound: 1,
        lastRound: 1,
        ...(opts.resolution ? { resolution: opts.resolution } : {}),
      },
    ],
  });
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

  // Phase 2: 強調 **…** の崩れは warning（非ブロック）。error 化は Phase 3。
  it("warns (non-blocking) when final.md has broken strong emphasis", async () => {
    const store = await newStore();
    const runId = "2026-06-20-emphasis";
    await seedComplete(store, runId);
    await store.save(runId, "final.md", "# T\n小惑星は、**「太陽系の化石」**のような存在です。\n");
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(true); // 非ブロック（errors には積まない）
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.includes("強調がレンダリングされない") && w.includes("L2"))).toBe(true);
  });

  describe("editorial-ledger gate", () => {
    it("fails when editorial-review=done but editorial-ledger.json is missing", async () => {
      const store = await newStore();
      const runId = "2026-06-22-no-ledger";
      await seedComplete(store, runId, { ledger: null });
      const r = await verifyArtifacts(store, runId);
      expect(r.ok).toBe(false);
      expect(r.errors.join("\n")).toMatch(/editorial-ledger\.json がありません/);
    });

    it("fails when a major weakness is unresolved (open, no resolution)", async () => {
      const store = await newStore();
      const runId = "2026-06-22-major-open";
      await seedComplete(store, runId);
      await store.save(runId, "editorial-ledger.json", ledgerWith("major"));
      const r = await verifyArtifacts(store, runId);
      expect(r.ok).toBe(false);
      expect(r.errors.join("\n")).toMatch(/未確定の weakness/);
      expect(r.errors.join("\n")).toMatch(/W001-major\(major\/unresolved\)/);
    });

    it("fails when a major weakness is escalated (judged but not user-approved)", async () => {
      const store = await newStore();
      const runId = "2026-06-22-major-escalated";
      await seedComplete(store, runId);
      await store.save(runId, "editorial-ledger.json", ledgerWith("major", { resolution: "escalated" }));
      const r = await verifyArtifacts(store, runId);
      expect(r.ok).toBe(false);
      expect(r.errors.join("\n")).toMatch(/W001-major\(major\/escalated\)/);
    });

    it("passes once the escalated weakness is user-approved", async () => {
      const store = await newStore();
      const runId = "2026-06-22-major-approved";
      await seedComplete(store, runId);
      await store.save(runId, "editorial-ledger.json", ledgerWith("major", { resolution: "user-approved" }));
      const r = await verifyArtifacts(store, runId);
      expect(r.ok).toBe(true);
      expect(r.errors).toEqual([]);
    });

    it("passes (accepted) and (waived) resolutions", async () => {
      const store = await newStore();
      for (const resolution of ["accepted", "waived"]) {
        const runId = `2026-06-22-${resolution}`;
        await seedComplete(store, runId);
        await store.save(runId, "editorial-ledger.json", ledgerWith("minor", { resolution }));
        const r = await verifyArtifacts(store, runId);
        expect(r.ok).toBe(true);
        expect(r.errors).toEqual([]);
      }
    });

    it("treats an unresolved preference as a warning, not a blocker", async () => {
      const store = await newStore();
      const runId = "2026-06-22-pref-open";
      await seedComplete(store, runId);
      await store.save(runId, "editorial-ledger.json", ledgerWith("preference"));
      const r = await verifyArtifacts(store, runId);
      expect(r.ok).toBe(true);
      expect(r.errors).toEqual([]);
      expect(r.warnings.join("\n")).toMatch(/未確定の preference/);
    });
  });

  // 構文/型チェック既定オフ（作成時に --code-check 非指定）の run は build-verify 宣言を要求しない。
  const PUB_NO_BUILD = [
    "# Publication Check",
    "- GO/NO-GO: GO",
    "- factcheck: done",
    "- editorial-review: done",
    "",
  ].join("\n");

  it("does not require a build-verify declaration when code-check was opted out at creation (codeCheck=false)", async () => {
    const store = await newStore();
    const runId = "2026-06-20-optout";
    await seedComplete(store, runId);
    await store.save(runId, "publication-check.md", PUB_NO_BUILD); // build-verify 行なし
    await new RunProgress(store).appendMany(runId, [{ step: "create", status: "done", codeCheck: false }]);
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("still requires a build-verify declaration when code-check was requested (codeCheck=true)", async () => {
    const store = await newStore();
    const runId = "2026-06-20-optin";
    await seedComplete(store, runId);
    await store.save(runId, "publication-check.md", PUB_NO_BUILD);
    await new RunProgress(store).appendMany(runId, [{ step: "create", status: "done", codeCheck: true }]);
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("build-verify"))).toBe(true);
  });

  it("still requires a build-verify declaration for legacy runs with no codeCheck stamp", async () => {
    const store = await newStore();
    const runId = "2026-06-20-legacy";
    await seedComplete(store, runId);
    await store.save(runId, "publication-check.md", PUB_NO_BUILD); // build-verify 行なし・progress イベントも無し
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("build-verify"))).toBe(true);
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

  it("fails when GO/NO-GO is present but empty (regex must not swallow the next line)", async () => {
    const store = await newStore();
    const runId = "2026-06-20-emptygo";
    await seedComplete(store, runId);
    // 旧 regex (\s* が改行を食う) では空欄 "- GO/NO-GO:" の直後行を値と誤読して通っていた。
    await store.save(
      runId,
      "publication-check.md",
      "# Publication Check\n- GO/NO-GO:\n- factcheck: done\n- build-verify: skipped\n- build-verify summary: なし\n- editorial-review: done\n"
    );
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
    await store.save(runId, "build-verify-report.json", JSON.stringify({ status: "passed", environment: BUILD_ENV, checkedBlocks: [], unverified: [] }));
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

  it("treats an unfilled gate template ('done / skipped') as not declared", async () => {
    const store = await newStore();
    const runId = "2026-06-20-unfilled";
    await seedComplete(store, runId);
    // 編集長がゲートを選ばずテンプレ初期値のまま残した状態
    await store.save(
      runId,
      "publication-check.md",
      "# Publication Check\n- GO/NO-GO: GO\n- factcheck: done / skipped\n- build-verify: skipped\n- build-verify summary: なし\n- editorial-review: done\n"
    );
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/factcheck ゲート/);
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

  it("fails when sources.json has an invalid retrievedAt date", async () => {
    const store = await newStore();
    const runId = "2026-06-20-baddate";
    await seedComplete(store, runId);
    await store.save(
      runId,
      "sources.json",
      JSON.stringify([{ id: "S001", url: "https://example.com/doc", title: "Doc", retrievedAt: "", sourceType: "primary", summary: "" }])
    );
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/sources\.json がスキーマ不適合/);
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

  it("fails when build-verify-report status is failed", async () => {
    const store = await newStore();
    const runId = "2026-06-20-bvfailed";
    await seedComplete(store, runId);
    await store.save(runId, "publication-check.md", PUB_BUILD_DONE);
    await store.save(runId, "build-verify-report.json", JSON.stringify({ status: "failed", environment: BUILD_ENV, checkedBlocks: [], unverified: [] }));
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/status=failed/);
  });

  it("fails when a checkedBlock result is failed even if status is passed", async () => {
    const store = await newStore();
    const runId = "2026-06-20-bvblockfail";
    await seedComplete(store, runId);
    await store.save(runId, "publication-check.md", PUB_BUILD_DONE);
    await store.save(
      runId,
      "build-verify-report.json",
      JSON.stringify({ status: "passed", environment: BUILD_ENV, checkedBlocks: [{ id: "B001", result: "failed" }], unverified: [] })
    );
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/失敗\/部分成功/);
  });

  it("fails when build-verify=done but the report is status=skipped (inconsistent)", async () => {
    const store = await newStore();
    const runId = "2026-06-20-bvinconsistent";
    await seedComplete(store, runId);
    await store.save(runId, "publication-check.md", PUB_BUILD_DONE);
    await store.save(
      runId,
      "build-verify-report.json",
      JSON.stringify({ status: "skipped", skipReason: "x", checkedBlocks: [], unverified: [] })
    );
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/不整合/);
  });

  it("passes when build-verify=done and the report is passed", async () => {
    const store = await newStore();
    const runId = "2026-06-20-bvpassed";
    await seedComplete(store, runId);
    await store.save(runId, "publication-check.md", PUB_BUILD_DONE);
    await store.save(
      runId,
      "build-verify-report.json",
      JSON.stringify({ status: "passed", environment: BUILD_ENV, checkedBlocks: [{ id: "B001", result: "passed" }], unverified: [] })
    );
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("fails when status=passed but unverified is non-empty (use partial)", async () => {
    const store = await newStore();
    const runId = "2026-06-20-bvunverified";
    await seedComplete(store, runId);
    await store.save(runId, "publication-check.md", PUB_BUILD_DONE);
    await store.save(
      runId,
      "build-verify-report.json",
      JSON.stringify({
        status: "passed",
        environment: BUILD_ENV,
        checkedBlocks: [{ id: "B001", result: "passed" }],
        unverified: [{ id: "B002", reason: "外部API依存で未検証" }],
      })
    );
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/unverified/);
  });

  it("fails when build-verify=done and passed but checkedBlocks is empty", async () => {
    const store = await newStore();
    const runId = "2026-06-20-bvemptypassed";
    await seedComplete(store, runId);
    await store.save(runId, "publication-check.md", PUB_BUILD_DONE);
    await store.save(runId, "build-verify-report.json", JSON.stringify({ status: "passed", environment: BUILD_ENV, checkedBlocks: [], unverified: [] }));
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/checkedBlocks が空/);
  });

  it("fails when a non-skipped build-verify-report has no environment.node", async () => {
    const store = await newStore();
    const runId = "2026-06-20-bvnoenv";
    await seedComplete(store, runId);
    await store.save(runId, "publication-check.md", PUB_BUILD_DONE);
    await store.save(
      runId,
      "build-verify-report.json",
      JSON.stringify({ status: "passed", checkedBlocks: [{ id: "B001", result: "passed" }], unverified: [] })
    );
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/environment\.node/);
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

  it("FAILs when the 参考 block has a link not in sources.json (fabricated URL)", async () => {
    const store = await newStore();
    const runId = "2026-06-20-fakelink";
    await seedComplete(store, runId);
    // 参考ブロック内に sources.json(=example.com/doc) に無い URL を混ぜる。
    await store.save(
      runId,
      "final.md",
      "# T\n本文\n\n## 参考\n\n<!-- sources:begin -->\n- [S001] Doc（primary, retrieved: 2026-06-20）\n  https://example.com/doc\n- [S999] 偽\n  https://evil.example.com/fake\n<!-- sources:end -->\n"
    );
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/参考ブロック内/);
  });

  it("FAILs when the sources markers are malformed (e.g. begin without end), not just warns", async () => {
    const store = await newStore();
    const runId = "2026-06-20-badmarker";
    await seedComplete(store, runId);
    // begin だけ残った壊れた参考ブロック＋偽 URL。warning 止まりにせず error にする。
    await store.save(
      runId,
      "final.md",
      "# T\n\n## 参考\n\n<!-- sources:begin -->\n- 偽\n  https://evil.example.com/fake\n"
    );
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/マーカーが壊れて/);
  });

  it("passes (with a warning) when a non-source link sits outside the 参考 block", async () => {
    const store = await newStore();
    const runId = "2026-06-20-bodylink";
    await seedComplete(store, runId);
    await store.save(
      runId,
      "final.md",
      "# T\n本文に GitHub リンク https://github.com/foo/bar あり。\n\n## 参考\n\n<!-- sources:begin -->\n- [S001] Doc（primary, retrieved: 2026-06-20）\n  https://example.com/doc\n<!-- sources:end -->\n"
    );
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(true); // ブロック外の一般リンクは warning 止まり
    expect(r.warnings.join("\n")).toMatch(/参考ブロック外/);
  });
});

describe("verifyArtifacts: sources 到達性／差し替え／cited 整合（read-only）", () => {
  it("FAILs when a cited source is reachable:dead", async () => {
    const store = await newStore();
    const runId = "2026-06-20-citeddead";
    await seedComplete(store, runId);
    await store.save(runId, "claims.json", CLAIMS_OK); // C001 verified present [S001]
    await store.save(
      runId,
      "sources.json",
      JSON.stringify([
        { id: "S001", url: "https://example.com/doc", title: "Doc", retrievedAt: "2026-06-20", sourceType: "primary", summary: "", reachable: "dead", cited: true },
      ])
    );
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/reachable=dead の source があります/);
  });

  it("FAILs on a dead source cited by claims even when cited is not materialized (claims is the source of truth)", async () => {
    const store = await newStore();
    const runId = "2026-06-20-deadnocited";
    await seedComplete(store, runId);
    await store.save(runId, "claims.json", CLAIMS_OK); // C001 verified present [S001]
    // reachable:dead は明示、cited は省略（未 materialize）。claims 再導出で S001 は cited。
    await store.save(
      runId,
      "sources.json",
      JSON.stringify([
        { id: "S001", url: "https://example.com/doc", title: "Doc", retrievedAt: "2026-06-20", sourceType: "primary", summary: "", reachable: "dead" },
      ])
    );
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/reachable=dead の source があります/);
  });

  it("FAILs when the 参考 block links to a reachable:dead source", async () => {
    const store = await newStore();
    const runId = "2026-06-20-blockdead";
    await seedComplete(store, runId);
    await store.save(runId, "claims.json", CLAIMS_OK); // cited = S001
    await store.save(
      runId,
      "sources.json",
      JSON.stringify([
        { id: "S001", url: "https://example.com/doc", title: "Doc", retrievedAt: "2026-06-20", sourceType: "primary", summary: "", reachable: "ok", cited: true },
        { id: "S002", url: "https://dead.example/x", title: "Dead", retrievedAt: "2026-06-20", sourceType: "secondary", summary: "", reachable: "dead", cited: false },
      ])
    );
    // 手編集で死リンク(S002)が参考ブロックに混入した状態。
    await store.save(
      runId,
      "final.md",
      "# T\n\n## 参考\n\n<!-- sources:begin -->\n- [S002] Dead（secondary, retrieved: 2026-06-20）\n  https://dead.example/x\n<!-- sources:end -->\n"
    );
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/reachable=dead の source へのリンク/);
  });

  it("FAILs on a dangling replacedBy", async () => {
    const store = await newStore();
    const runId = "2026-06-20-dangling";
    await seedComplete(store, runId);
    await store.save(runId, "claims.json", CLAIMS_OK);
    await store.save(
      runId,
      "sources.json",
      JSON.stringify([
        { id: "S001", url: "https://example.com/doc", title: "Doc", retrievedAt: "2026-06-20", sourceType: "primary", summary: "", reachable: "ok", cited: true, replacedBy: "S999" },
      ])
    );
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/dangling/);
  });

  it("FAILs on a self-referential replacedBy (hand-edit detection)", async () => {
    const store = await newStore();
    const runId = "2026-06-20-selfref";
    await seedComplete(store, runId);
    await store.save(runId, "claims.json", CLAIMS_OK);
    await store.save(
      runId,
      "sources.json",
      JSON.stringify([
        { id: "S001", url: "https://example.com/doc", title: "Doc", retrievedAt: "2026-06-20", sourceType: "primary", summary: "", reachable: "ok", cited: true, replacedBy: "S001" },
      ])
    );
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/自己参照/);
  });

  it("FAILs when cited materialization disagrees with claims (drift)", async () => {
    const store = await newStore();
    const runId = "2026-06-20-citedrift";
    await seedComplete(store, runId);
    await store.save(runId, "claims.json", CLAIMS_OK); // 再導出 cited = {S001}
    await store.save(
      runId,
      "sources.json",
      JSON.stringify([
        { id: "S001", url: "https://example.com/doc", title: "Doc", retrievedAt: "2026-06-20", sourceType: "primary", summary: "", cited: false },
      ])
    );
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/cited が claims から再導出した集合と不一致/);
  });

  it("stays PASS for an old run whose sources.json has no reachability/cited meta", async () => {
    const store = await newStore();
    const runId = "2026-06-20-oldmeta";
    await seedComplete(store, runId); // SOURCES_OK: cited 無し・reachable 無し
    const r = await verifyArtifacts(store, runId);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
});
