import { describe, expect, it } from "vitest";
import { aggregate } from "../../src/progress/aggregate";
import type { ProgressEvent } from "../../src/progress/types";

let clock = 0;
function ev(over: Partial<ProgressEvent> & Pick<ProgressEvent, "step" | "status">): ProgressEvent {
  clock += 1000;
  return {
    at: new Date(clock).toISOString(),
    runId: "2026-06-21-x",
    ...over,
  };
}

function step(snapshot: ReturnType<typeof aggregate>, key: string) {
  const s = snapshot.steps.find((row) => row.step === key);
  if (!s) {
    throw new Error(`step ${key} not found`);
  }
  return s;
}

describe("aggregate", () => {
  it("renders every canonical step as pending when there are no events", () => {
    const snap = aggregate("r", []);
    expect(snap.steps.length).toBe(10);
    expect(snap.steps.every((s) => s.status === "pending")).toBe(true);
    expect(snap.currentIndex).toBe(1); // 最初の未着手
    expect(snap.complete).toBe(false);
    expect(snap.totalCostUsd).toBeUndefined();
  });

  it("folds start→done into one step and advances currentIndex to the next pending", () => {
    const snap = aggregate("r", [
      ev({ step: "create", status: "start" }),
      ev({ step: "create", status: "done", elapsedMs: 1200, costUsd: 0.5, output: "runs/r/final.md" }),
    ]);
    const create = step(snap, "create");
    expect(create.status).toBe("done");
    expect(create.elapsedMs).toBe(1200);
    expect(create.costUsd).toBe(0.5);
    expect(create.output).toBe("runs/r/final.md");
    expect(create.startedAt).toBeDefined();
    expect(create.finishedAt).toBeDefined();
    // create=done なので現在地は次（refine, index 2）
    expect(snap.currentIndex).toBe(2);
  });

  it("does not let a later skip degrade a completed step (resume safety)", () => {
    const snap = aggregate("r", [
      ev({ step: "create", status: "done" }),
      ev({ step: "create", status: "skip", note: "resume: already done" }),
    ]);
    expect(step(snap, "create").status).toBe("done");
  });

  it("does not let a later skip/error overwrite the note/output of a completed step", () => {
    const snap = aggregate("r", [
      ev({ step: "create", status: "done", output: "runs/r/final.md", note: "ok" }),
      ev({ step: "create", status: "skip", note: "resume: already done" }),
      ev({ step: "create", status: "error", note: "FAIL" }),
    ]);
    const create = step(snap, "create");
    expect(create.status).toBe("done");
    // note/output は代表イベント（done）由来のまま。後続 skip/error の note は混ざらない。
    expect(create.note).toBe("ok");
    expect(create.output).toBe("runs/r/final.md");
  });

  it("sums cost/elapsed across repeated done events for the same step instead of letting the later one win", () => {
    // create で 0.5/1200ms 使った後、resume が改稿なしで done を打っても (cost 0)、
    // 元の create のコストが消えてはいけない（合計に残る）。
    const snap = aggregate("r", [
      ev({ step: "create", status: "done", costUsd: 0.5, elapsedMs: 1200, output: "runs/r/final.md", note: "create" }),
      ev({ step: "create", status: "done", output: "runs/r/final.md", note: "resume: nothing to do" }),
    ]);
    const create = step(snap, "create");
    expect(create.costUsd).toBe(0.5);
    expect(create.elapsedMs).toBe(1200);
    // 説明系フィールド（note）は最後の done（代表イベント）を採用してよい
    expect(create.note).toBe("resume: nothing to do");
    expect(create.output).toBe("runs/r/final.md");
  });

  it("treats a done after error as success (retry)", () => {
    const snap = aggregate("r", [
      ev({ step: "factcheck", status: "error", note: "network" }),
      ev({ step: "factcheck", status: "done", note: "BLOCKING 0" }),
    ]);
    const fc = step(snap, "factcheck");
    expect(fc.status).toBe("done");
    expect(fc.note).toBe("BLOCKING 0");
  });

  it("keeps error when no later done arrives", () => {
    const snap = aggregate("r", [ev({ step: "factcheck", status: "error", note: "boom" })]);
    const fc = step(snap, "factcheck");
    expect(fc.status).toBe("error");
    // currentIndex は「最初の未完工程」。create 等が未着手なので現在地はそちら（先頭）。
    expect(snap.currentIndex).toBe(1);
  });

  it("points currentIndex at an errored step once earlier steps are terminal", () => {
    const snap = aggregate("r", [
      ev({ step: "create", status: "done" }),
      ev({ step: "refine", status: "skip", note: "clean" }),
      ev({ step: "evaluate", status: "done" }),
      ev({ step: "direction", status: "done", note: "verdict=ok" }),
      ev({ step: "factcheck", status: "error", note: "boom" }),
    ]);
    expect(snap.currentIndex).toBe(5); // factcheck（error=未完）が最初の未完（direction=4 の次）
  });

  it("sums only known costs into totalCostUsd", () => {
    const snap = aggregate("r", [
      ev({ step: "create", status: "done", costUsd: 0.5 }),
      ev({ step: "evaluate", status: "done" }), // cost 不明
      ev({ step: "refine", status: "done", costUsd: 0.25 }),
    ]);
    expect(snap.totalCostUsd).toBe(0.75);
  });

  it("keeps currentIndex/total stable regardless of event arrival order (canonical order)", () => {
    // evaluate を create より先に記録しても、表示は canonical 順（create=1, refine=2, evaluate=3）。
    const snap = aggregate("r", [
      ev({ step: "evaluate", status: "done" }),
      ev({ step: "create", status: "done" }),
    ]);
    expect(step(snap, "create").index).toBe(1);
    expect(step(snap, "evaluate").index).toBe(3);
    // create done / refine pending → 現在地は refine
    expect(snap.currentIndex).toBe(2);
  });

  it("appends non-canonical steps at the end in first-seen order", () => {
    const snap = aggregate("r", [
      ev({ step: "revise", status: "done" }),
      ev({ step: "weird-step", status: "done" }),
    ]);
    const revise = step(snap, "revise");
    const weird = step(snap, "weird-step");
    expect(revise.canonical).toBe(false);
    expect(weird.canonical).toBe(false);
    expect(revise.index).toBe(11); // 10 canonical の後
    expect(weird.index).toBe(12);
  });

  it("maps create internal steps (brief/draft/...) onto the create canonical step", () => {
    const snap = aggregate("r", [
      ev({ step: "brief", status: "start" }),
      ev({ step: "draft", status: "done" }),
      ev({ step: "final", status: "done" }),
    ]);
    expect(step(snap, "create").status).toBe("done");
    // create 1行だけ（内部ステップは別行を作らない）
    expect(snap.steps.filter((s) => s.step === "create").length).toBe(1);
  });

  it("places direction between evaluate and factcheck, and keeps direction-draft non-canonical", () => {
    const snap = aggregate("r", [
      ev({ step: "direction", status: "done", note: "verdict=ok" }),
      ev({ step: "direction-draft", status: "done", note: "early" }),
    ]);
    expect(step(snap, "direction").index).toBe(4); // evaluate(3) の次・factcheck(5) の前
    expect(step(snap, "direction").canonical).toBe(true);
    expect(step(snap, "factcheck").index).toBe(5);
    const draft = step(snap, "direction-draft");
    expect(draft.canonical).toBe(false); // 早期プレビューは canonical を満たさない
    expect(draft.index).toBeGreaterThan(10); // 10 canonical の後ろ（追加工程）
  });

  it("folds direction-check alias onto the canonical direction step", () => {
    const snap = aggregate("r", [ev({ step: "direction-check", status: "done", note: "verdict=ok" })]);
    expect(step(snap, "direction").status).toBe("done");
  });

  it("keeps currentIndex at direction when verdict=revise (error), and a later ok (done) advances it", () => {
    // verdict=revise → direction=error。前工程が終わっていても currentIndex は direction に留まる。
    const revised = aggregate("r", [
      ev({ step: "create", status: "done" }),
      ev({ step: "refine", status: "skip", note: "clean" }),
      ev({ step: "evaluate", status: "done" }),
      ev({ step: "direction", status: "error", note: "revise before factcheck; verdict=revise" }),
    ]);
    expect(step(revised, "direction").status).toBe("error");
    expect(revised.currentIndex).toBe(4); // factcheck へ進まない

    // 再判定 ok（done）が error を上書き → currentIndex は factcheck(5) へ。
    const reOk = aggregate("r", [
      ev({ step: "create", status: "done" }),
      ev({ step: "refine", status: "skip", note: "clean" }),
      ev({ step: "evaluate", status: "done" }),
      ev({ step: "direction", status: "error", note: "verdict=revise" }),
      ev({ step: "direction", status: "done", note: "verdict=ok" }),
    ]);
    expect(step(reOk, "direction").status).toBe("done");
    expect(reOk.currentIndex).toBe(5);
  });

  it("marks complete only when every canonical step is done or skipped", () => {
    const allDone = [
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
    ].map((s) => ev({ step: s, status: s === "build-verify" ? "skip" : "done", note: s === "build-verify" ? "no code" : undefined }));
    const snap = aggregate("r", allDone);
    expect(snap.complete).toBe(true);
    expect(snap.currentIndex).toBeUndefined();
  });
});
