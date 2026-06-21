import { describe, expect, it } from "vitest";
import {
  renderProgressMarkdown,
  formatLocalTime,
  formatLocalDateTime,
} from "../../src/progress/renderMarkdown";
import { aggregate } from "../../src/progress/aggregate";
import type { ProgressEvent } from "../../src/progress/types";

// 注: TZ は vitest.config.ts で Asia/Tokyo に固定（ローカルタイム表示を決定的にするため）。

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
      "direction",
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

  it("renders start/finish in local time (JST), not UTC", () => {
    // UTC 07:19:00 → JST 16:19:00。UTC のままなら 07:19:00 が出るはず。
    const snap = aggregate("r", [ev({ step: "create", status: "done" })]);
    const md = renderProgressMarkdown(snap);
    expect(md).toContain("16:19:00");
    expect(md).not.toContain("07:19:00");
    expect(md).toContain("ローカルタイム"); // 注記
  });

  it("shows the timezone offset on the 更新 line (so it is not mistaken for UTC)", () => {
    const snap = aggregate("r", [ev({ step: "create", status: "done" })]);
    expect(renderProgressMarkdown(snap)).toContain("+09:00");
  });

  it("shows the generating tool version when present, and omits the line when absent", () => {
    const withVer = aggregate("r", [ev({ step: "create", status: "done", version: "0.2.23" })]);
    expect(renderProgressMarkdown(withVer)).toContain("- 生成ツール: llm-task-router 0.2.23");

    const noVer = aggregate("r", [ev({ step: "create", status: "done" })]);
    expect(renderProgressMarkdown(noVer)).not.toContain("生成ツール");
  });

  it("uses canonicalTotal as the position denominator (non-canonical extras do not inflate it)", () => {
    const snap = aggregate("r", [
      ev({ step: "create", status: "done" }),
      ev({ step: "revise", status: "done" }), // 非 canonical
    ]);
    // create done → 現在地は refine(2) / 分母は canonical 9（revise で 10 にならない）。
    expect(renderProgressMarkdown(snap)).toContain("2 / 9 工程目");
  });
});

describe("local time formatters (TZ=Asia/Tokyo)", () => {
  it("formatLocalTime converts a UTC instant to local HH:MM:SS", () => {
    expect(formatLocalTime(new Date("2026-06-21T07:19:05.000Z"))).toBe("16:19:05");
  });

  it("formatLocalDateTime appends the +09:00 offset", () => {
    expect(formatLocalDateTime(new Date("2026-06-21T07:19:05.000Z"))).toBe("2026-06-21 16:19:05 +09:00");
  });
});
