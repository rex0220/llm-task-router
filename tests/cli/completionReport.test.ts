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
});

function makeData(over: Partial<CompletionReportData> = {}): CompletionReportData {
  return {
    runId: "r",
    title: "タイトル",
    progress: { complete: true, total: 9 },
    factcheck: { state: "done" },
    buildVerify: { state: "skipped" },
    editorial: { state: "done" },
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
