import { describe, expect, it } from "vitest";
import { renderProgressMarkdown } from "../../src/progress/renderMarkdown";
import { aggregate } from "../../src/progress/aggregate";
import type { ProgressEvent } from "../../src/progress/types";

function ev(over: Partial<ProgressEvent> & Pick<ProgressEvent, "step" | "status">): ProgressEvent {
  return { at: "2026-06-21T07:19:00.000Z", runId: "r", ...over };
}

describe("renderProgressMarkdown", () => {
  it("renders a table with the expected columns and the cost total", () => {
    const snap = aggregate("2026-06-21-x", [ev({ step: "create", status: "done", elapsedMs: 1200, costUsd: 0.5 })]);
    const md = renderProgressMarkdown(snap);
    expect(md).toContain("# 進捗: 2026-06-21-x");
    expect(md).toContain("| # | 工程 | 状態 | 開始 | 終了 | 所要 | 概算$ | 根拠/補足 |");
    expect(md).toContain("~$0.5000");
    expect(md).toContain("概算コスト合計");
    expect(md).toContain("1200ms");
  });

  it("leaves cost/elapsed cells blank when unknown (no n/a noise)", () => {
    const snap = aggregate("r", [ev({ step: "factcheck", status: "skip", note: "no facts" })]);
    const md = renderProgressMarkdown(snap);
    // skip 行に所要/コストは無いので空セル（'undefined' が出ない）
    expect(md).not.toContain("undefined");
    expect(md).toContain("no facts");
  });

  it("shows complete when all canonical steps are terminal", () => {
    const steps = [
      "create",
      "refine",
      "evaluate",
      "factcheck",
      "build-verify",
      "editorial",
      "claims-normalize",
      "verify-artifacts",
      "export",
    ].map((s) => ev({ step: s, status: "done" }));
    const md = renderProgressMarkdown(aggregate("r", steps));
    expect(md).toContain("完了（全工程 done/skip）");
  });

  it("escapes pipe characters in notes", () => {
    const snap = aggregate("r", [ev({ step: "factcheck", status: "done", note: "a|b" })]);
    const md = renderProgressMarkdown(snap);
    expect(md).toContain("a\\|b");
  });
});
