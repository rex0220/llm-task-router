import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectCompletionReportData,
  mergeCompletionReport,
  renderCompletionReport,
  type CompletionReportData,
} from "../../src/cli/completionReport";
import { RunStore } from "../../src/storage/RunStore";
import { RunProgress } from "../../src/progress/RunProgress";

async function newStore(): Promise<RunStore> {
  return new RunStore(await mkdtemp(join(tmpdir(), "cr-runs-")));
}

const PC = [
  "# Publication Check",
  "- GO/NO-GO: GO",
  "- reason: 全ゲート通過",
  "- factcheck: done",
  "- factcheck summary: BLOCKING 0",
  "- build-verify: skipped",
  "- build-verify summary: コード無し",
  "- editorial-review: done",
  "- editorial-review summary: 採用4件",
  "",
].join("\n");

const CLAIMS = JSON.stringify([
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
const SOURCES = JSON.stringify([
  { id: "S001", url: "https://example.com/d", title: "D", retrievedAt: "2026-06-20", sourceType: "primary", summary: "" },
]);

async function seed(store: RunStore, runId: string): Promise<void> {
  await store.create(runId, "T", ["create"], "Qiita", undefined, "qiita");
  await store.save(runId, "final.md", "# 本物のタイトル\n本文\n");
  await store.save(runId, "publication-check.md", PC);
  await store.save(runId, "claims.json", CLAIMS);
  await store.save(runId, "sources.json", SOURCES);
}

describe("collectCompletionReportData", () => {
  it("collects title from body H1, gates, cost, and counts", async () => {
    const store = await newStore();
    const runId = "2026-06-21-cr";
    await seed(store, runId);
    const data = await collectCompletionReportData(store, runId, PC);
    expect(data.title).toBe("本物のタイトル");
    expect(data.profile).toBe("qiita");
    expect(data.goNoGo).toBe("GO");
    expect(data.reason).toBe("全ゲート通過");
    expect(data.factcheck.state).toBe("done");
    expect(data.buildVerify.state).toBe("skipped");
    expect(data.claims).toEqual({ total: 1, sources: 1, blocking: 0 });
  });

  it("falls back to runId for title and tolerates missing artifacts", async () => {
    const store = await newStore();
    const runId = "2026-06-21-bare";
    await store.create(runId, "T", ["create"]);
    await store.save(runId, "publication-check.md", PC);
    // final.md / claims.json なし
    const data = await collectCompletionReportData(store, runId, PC);
    expect(data.title).toBe(runId);
    expect(data.claims).toBeNull();
    expect(data.buildReport).toBeNull();
  });

  it("reads verify-artifacts/export status from progress snapshot (latest event wins)", async () => {
    const store = await newStore();
    const runId = "2026-06-21-vae";
    await seed(store, runId);
    // verify-artifacts は初回 error → 修正後 done。export は承認後 done。
    await new RunProgress(store).appendMany(runId, [
      { step: "verify-artifacts", status: "error", note: "FAIL (2 件)" },
      { step: "verify-artifacts", status: "done", note: "OK" },
      { step: "export", status: "done", output: "export/x.md", note: "ユーザー承認済み" },
    ]);
    const data = await collectCompletionReportData(store, runId, PC);
    expect(data.verifyArtifacts).toEqual({ status: "done", note: "OK" });
    expect(data.exported).toEqual({ status: "done", output: "export/x.md", note: "ユーザー承認済み" });
  });

  it("shows the latest verify-artifacts event (done→error regression is not masked by aggregate priority)", async () => {
    const store = await newStore();
    const runId = "2026-06-21-regress";
    await seed(store, runId);
    // done の後に error（退行）。aggregate の集約 status は done>error で done を返すが、
    // 完成報告は最後のイベント＝error を表示しなければならない。
    await new RunProgress(store).appendMany(runId, [
      { step: "verify-artifacts", status: "done", note: "OK" },
      { step: "verify-artifacts", status: "error", note: "FAIL (再発)" },
    ]);
    const data = await collectCompletionReportData(store, runId, PC);
    expect(data.verifyArtifacts).toEqual({ status: "error", note: "FAIL (再発)" });
  });

  it("treats verify-artifacts as pending and export as null when no such events exist", async () => {
    const store = await newStore();
    const runId = "2026-06-21-noevents";
    await seed(store, runId);
    const data = await collectCompletionReportData(store, runId, PC);
    expect(data.verifyArtifacts.status).toBe("pending");
    expect(data.exported).toBeNull();
  });
});

function makeData(over: Partial<CompletionReportData> = {}): CompletionReportData {
  return {
    runId: "r",
    title: "タイトル",
    progress: { complete: true, canonicalTotal: 9 },
    factcheck: { state: "done" },
    buildVerify: { state: "skipped" },
    editorial: { state: "done" },
    editorialGate: { hasLedger: false, major: [], minor: [], preference: [] },
    verifyArtifacts: { status: "done", note: "OK" },
    exported: null,
    claims: { total: 1, sources: 1, blocking: 0 },
    buildReport: null,
    goNoGo: "GO",
    reason: "ok",
    ...over,
  };
}

describe("renderCompletionReport", () => {
  it("renders auto markers, gate table, and editor placeholders", () => {
    const md = renderCompletionReport(makeData());
    expect(md).toContain("<!-- auto:begin -->");
    expect(md).toContain("<!-- auto:end -->");
    expect(md).toContain("## ゲート結果");
    expect(md).toContain("## 構成");
    expect(md).toContain("<!-- editor:");
    expect(md).toContain("- GO/NO-GO: GO");
  });

  it("escapes pipes in cell values", () => {
    const md = renderCompletionReport(makeData({ title: "a | b" }));
    expect(md).toContain("a \\| b");
  });

  it("renders verify-artifacts row from snapshot status (no more 'publication-check では判定不可')", () => {
    const md = renderCompletionReport(makeData({ verifyArtifacts: { status: "done", note: "OK" } }));
    expect(md).toContain("| verify-artifacts | done | OK |");
    expect(md).not.toContain("publication-check では判定不可");
  });

  it("renders build-verify as 対象外 when code check was opted out at creation (codeCheckRequested=false)", () => {
    const md = renderCompletionReport(makeData({ codeCheckRequested: false }));
    expect(md).toContain("| build-verify | 対象外 | 作成時にコードチェック非指定（既定オフ） |");
  });

  it("renders build-verify from publication-check gate state when code check was requested", () => {
    const md = renderCompletionReport(makeData({ codeCheckRequested: true, buildVerify: { state: "done", summary: "passed" } }));
    expect(md).toContain("| build-verify | done | passed |");
    expect(md).not.toContain("対象外");
  });

  it("still surfaces a build-verify report even when opted out (manual run)", () => {
    const md = renderCompletionReport(
      makeData({ codeCheckRequested: false, buildReport: { status: "passed", checkedBlocks: 2, unverified: 0 } })
    );
    // 手動で回した report があれば対象外扱いにせず要約を出す。
    expect(md).toContain("checkedBlocks 2");
    expect(md).not.toContain("作成時にコードチェック非指定");
  });

  it("shows machine gate OK and does not touch transcribed GO when ledger has no unsettled", () => {
    const md = renderCompletionReport(
      makeData({ goNoGo: "GO", editorialGate: { hasLedger: true, major: [], minor: [], preference: [] } })
    );
    expect(md).toContain("- GO/NO-GO: GO"); // 転記は不変
    expect(md).toContain("- machine gate（editorial）: OK（未確定 0）");
  });

  it("surfaces machine gate BLOCK alongside (not overriding) a transcribed GO when a major is unsettled", () => {
    const md = renderCompletionReport(
      makeData({
        goNoGo: "GO",
        editorialGate: {
          hasLedger: true,
          major: [{ id: "W001-x", severity: "major", status: "open", reason: "unresolved", problem: "P" }],
          minor: [],
          preference: [],
        },
      })
    );
    // publication-check 由来の GO は転記のまま（黙って NO-GO に上書きしない）。
    expect(md).toContain("- GO/NO-GO: GO");
    // machine gate は別軸で BLOCK を併記し、editorial 行にも要 editorial-resolve を出す。
    expect(md).toContain("- machine gate（editorial）: BLOCK（未確定 major 1）");
    expect(md).toMatch(/machine gate: BLOCK.*要 editorial-resolve/);
  });

  it("treats escalated as unsettled (BLOCK) in the machine gate", () => {
    const md = renderCompletionReport(
      makeData({
        editorialGate: {
          hasLedger: true,
          major: [{ id: "W001-x", severity: "major", status: "open", reason: "escalated", problem: "P" }],
          minor: [],
          preference: [],
        },
      })
    );
    expect(md).toContain("BLOCK（未確定 major 1）");
    expect(md).toContain("W001-x(major/escalated)");
  });

  it("shows export state in the auto block (done with path, and 未実行 default)", () => {
    const done = renderCompletionReport(
      makeData({ exported: { status: "done", output: "export/x.md", note: "承認済み" } })
    );
    expect(done).toContain("- export: done / export/x.md / 承認済み");

    const notYet = renderCompletionReport(makeData({ exported: null }));
    expect(notYet).toContain("- export: 未実行");
  });

  it("shows the generating tool version in the auto block, and omits the line when absent", () => {
    expect(renderCompletionReport(makeData({ toolVersion: "0.2.23" }))).toContain(
      "- 生成ツール: llm-task-router 0.2.23"
    );
    // version 無し（既存 run）は行を出さない（progress.md と挙動を揃える）。
    expect(renderCompletionReport(makeData())).not.toContain("生成ツール");
  });
});

describe("mergeCompletionReport (marker protection)", () => {
  it("creates a fresh report when there is no existing file", () => {
    const { content, recovered } = mergeCompletionReport(makeData(), null);
    expect(recovered).toBe(false);
    expect(content).toContain("## 構成");
  });

  it("keeps editor sections and refreshes only the auto block on regeneration", () => {
    const initial = renderCompletionReport(makeData({ goNoGo: "NO-GO" }));
    const edited = initial.replace(
      "<!-- editor: 記事の構成ナラティブ（導入→…→まとめ）。編集長が記入 -->",
      "導入→本論→まとめ（編集長記入）"
    );
    // 成果物が変わって再生成（GO/NO-GO が NO-GO → GO）。
    const { content, recovered } = mergeCompletionReport(makeData({ goNoGo: "GO" }), edited);
    expect(recovered).toBe(false);
    expect(content).toContain("導入→本論→まとめ（編集長記入）"); // editor 欄は残る
    expect(content).toContain("- GO/NO-GO: GO"); // auto 欄は最新
    expect(content).not.toContain("- GO/NO-GO: NO-GO");
  });

  it("flags recovered when the existing file has no auto markers", () => {
    const { content, recovered } = mergeCompletionReport(makeData(), "壊れた手書きファイル\n");
    expect(recovered).toBe(true);
    expect(content).toContain("<!-- auto:begin -->");
  });

  it("flags recovered for malformed markers (missing begin / reversed / duplicated)", () => {
    const onlyEnd = "ゴミ\n<!-- auto:end -->\n## 構成\n本文\n";
    expect(mergeCompletionReport(makeData(), onlyEnd).recovered).toBe(true);

    const reversed = "<!-- auto:end -->\n間\n<!-- auto:begin -->\n";
    expect(mergeCompletionReport(makeData(), reversed).recovered).toBe(true);

    const duplicated =
      "<!-- auto:begin -->\nA\n<!-- auto:end -->\n<!-- auto:begin -->\nB\n<!-- auto:end -->\n";
    expect(mergeCompletionReport(makeData(), duplicated).recovered).toBe(true);
  });
});
