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
    // トークン未記録の工程のみ → 列は出ない（従来の列構成を保つ）。トークン列は専用テストで確認。
    expect(md).toContain("| # | 工程 | 状態 | 開始 | 終了 | 所要 | 概算$ | 根拠/補足 |");
    expect(md).not.toContain("トークン(in/out)");
    expect(md).toContain("~$0.5000");
    expect(md).toContain("概算コスト合計");
    // 所要は人が読みやすい M:SS.mmm（1200ms → 0:01.200）。
    expect(md).toContain("0:01.200");
    expect(md).not.toContain("1200ms");
  });

  it("formats elapsed as M:SS.mmm (minutes example)", () => {
    const md = renderProgressMarkdown(aggregate("r", [ev({ step: "create", status: "done", elapsedMs: 241362 })]));
    expect(md).toContain("4:01.362"); // 241362ms = 4分1秒362
  });

  it("sums tokens across steps (and across multiple invocations of one step) and shows a total line", () => {
    const snap = aggregate("r", [
      ev({ step: "create", status: "done", inputTokens: 1000, outputTokens: 2000 }),
      // 同一工程の複数 invocation は積算される（cost と同じ挙動）。
      ev({ step: "revise", status: "done", inputTokens: 300, outputTokens: 400 }),
      ev({ step: "revise", status: "done", inputTokens: 30, outputTokens: 40 }),
    ]);
    expect(snap.totalInputTokens).toBe(1330);
    expect(snap.totalOutputTokens).toBe(2440);
    const md = renderProgressMarkdown(snap);
    expect(md).toContain("| # | 工程 | 状態 | 開始 | 終了 | 所要 | 概算$ | トークン(in/out) | 根拠/補足 |");
    expect(md).toContain("トークン合計: 入力 1,330 / 出力 2,440（合計 3,770 / LLM工程のみ）");
    expect(md).toContain("330/440"); // revise 行（複数 invocation 積算）
  });

  it("omits the token total line and leaves token cells blank when no step reports tokens", () => {
    const snap = aggregate("r", [ev({ step: "factcheck", status: "skip", note: "no facts" })]);
    expect(snap.totalInputTokens).toBeUndefined();
    const md = renderProgressMarkdown(snap);
    expect(md).not.toContain("トークン合計");
    expect(md).not.toContain("undefined");
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

  it("shows a 開始 line from the earliest event time (local time with offset)", () => {
    const snap = aggregate("r", [
      ev({ step: "refine", status: "done", at: "2026-06-21T07:30:00.000Z" }),
      ev({ step: "create", status: "start", at: "2026-06-21T07:24:17.000Z" }), // 最古
    ]);
    expect(snap.startedAt).toBe("2026-06-21T07:24:17.000Z");
    // UTC 07:24:17 → JST 16:24:17。開始行が出る。
    expect(renderProgressMarkdown(snap)).toContain("- 開始: 2026-06-21 16:24:17 +09:00");
  });

  it("fixes the editor-in-chief AI model from the earliest event carrying it (first-write-wins), and omits when absent", () => {
    const withEditor = aggregate("r", [
      // create 時に申告した最古の値が固定される。後続イベントの別値では上書きされない（遡及防止）。
      ev({ step: "create", status: "start", at: "2026-06-21T07:30:00.000Z", editorModel: "claude-opus-4-8" }),
      ev({ step: "editorial", status: "done", at: "2026-06-21T07:43:00.000Z", editorModel: "claude-opus-4-7" }),
    ]);
    expect(withEditor.editorModel).toBe("claude-opus-4-8");
    expect(renderProgressMarkdown(withEditor)).toContain("- 編集長（AIモデル・自己申告）: claude-opus-4-8");

    const noEditor = aggregate("r", [ev({ step: "create", status: "done" })]);
    expect(noEditor.editorModel).toBeUndefined();
    expect(renderProgressMarkdown(noEditor)).not.toContain("編集長（AIモデル");
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

  it("separates non-canonical extras with a divider row and a note (A+C)", () => {
    const md = renderProgressMarkdown(
      aggregate("r", [
        ev({ step: "create", status: "done" }),
        ev({ step: "revise", status: "done" }),
      ])
    );
    expect(md).toContain("追加アクション（工程外"); // 区切り行（A）
    expect(md).toContain("#10 以降は工程ではない追加アクション"); // 注記（C）
    expect(md).toContain("実行時刻順ではありません");
  });

  it("omits the divider/note when there are no non-canonical extras", () => {
    const md = renderProgressMarkdown(aggregate("r", [ev({ step: "create", status: "done" })]));
    expect(md).not.toContain("追加アクション");
  });

  describe("post-completion log section", () => {
    // 増加する at を振って完成→完成後の順序を作る。
    let sec = 0;
    function tick(over: Partial<ProgressEvent> & Pick<ProgressEvent, "step" | "status">): ProgressEvent {
      sec += 1;
      return { at: `2026-06-21T07:19:${String(sec).padStart(2, "0")}.000Z`, runId: "r", ...over };
    }
    function completing(): ProgressEvent[] {
      return [
        tick({ step: "create", status: "done" }),
        tick({ step: "refine", status: "done" }),
        tick({ step: "direction", status: "done" }),
        tick({ step: "factcheck", status: "done" }),
        tick({ step: "build-verify", status: "skip", note: "n/a" }),
        tick({ step: "editorial", status: "done" }),
        tick({ step: "claims-normalize", status: "done" }),
        tick({ step: "verify-artifacts", status: "done" }),
        tick({ step: "export", status: "done" }),
      ];
    }

    it("renders the section with completion datetime, raw step, local time, and a tokens column", () => {
      const snap = aggregate("r", [
        ...completing(),
        tick({ step: "evaluate", status: "done", inputTokens: 30134, outputTokens: 25901, note: "再評価" }),
        tick({ step: "export", status: "done", note: "第2版 再export" }),
      ]);
      const md = renderProgressMarkdown(snap);
      expect(md).toContain("## 完成後の変更ログ（時系列）");
      expect(md).toContain("- 完成到達: 2026-06-21 16:19:09 +09:00"); // export(9秒) の完成時刻
      expect(md).toContain("| 時刻 | 工程 | 状態 | 概算$ | トークン(in/out) | 補足 |");
      expect(md).toContain("| 16:19:10 | evaluate | ✅ done |  | 30,134/25,901 | 再評価 |"); // raw step を保つ
      expect(md).toContain("第2版 再export");
    });

    it("drops the tokens column when no post-completion event reports tokens", () => {
      const snap = aggregate("r", [...completing(), tick({ step: "revise", status: "done", note: "微修正" })]);
      const md = renderProgressMarkdown(snap);
      expect(md).toContain("## 完成後の変更ログ（時系列）");
      expect(md).toContain("| 時刻 | 工程 | 状態 | 概算$ | 補足 |");
      expect(md).not.toMatch(/完成後[\s\S]*トークン\(in\/out\)/);
    });

    it("omits the section entirely when there is no post-completion activity", () => {
      const md = renderProgressMarkdown(aggregate("r", completing()));
      expect(md).not.toContain("完成後の変更ログ");
    });

    it("does not render resolved revise 'start' rows as 進行中 (only the trailing in-flight start)", () => {
      const snap = aggregate("r", [
        ...completing(),
        // 1回目の revise（完了済み）: start→done。start 行は描画しない（done 行が実体）。
        tick({ step: "revise", status: "start" }),
        tick({ step: "revise", status: "done", note: "第2版" }),
        // 2回目の revise（完了済み）。
        tick({ step: "revise", status: "start" }),
        tick({ step: "revise", status: "done", note: "第3版" }),
        // 3回目（進行中）: start のみで後続 terminal なし → これだけ 進行中 として残す。
        tick({ step: "revise", status: "start" }),
      ]);
      const md = renderProgressMarkdown(snap);
      const section = md.slice(md.indexOf("## 完成後の変更ログ"));
      // 完了済み2件の done 行は残る。進行中（🔄）は末尾の未解決 start ちょうど1件だけ。
      expect(section).toContain("第2版");
      expect(section).toContain("第3版");
      expect((section.match(/🔄 進行中/g) ?? []).length).toBe(1);
    });

    it("keeps a non-start status row even if a later same-step terminal exists (only collapses 'start')", () => {
      // verify-artifacts: error→done。error は start ではないので畳まず両方残す（履歴を消さない）。
      const snap = aggregate("r", [
        ...completing(),
        tick({ step: "verify-artifacts", status: "error", note: "FAIL" }),
        tick({ step: "verify-artifacts", status: "done", note: "OK" }),
      ]);
      const section = renderProgressMarkdown(snap).slice(
        renderProgressMarkdown(snap).indexOf("## 完成後の変更ログ")
      );
      expect(section).toContain("FAIL");
      expect(section).toContain("OK");
      expect(section).toContain("❌ error");
    });
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
