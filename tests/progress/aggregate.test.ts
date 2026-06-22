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
    expect(snap.steps.length).toBe(9);
    expect(snap.canonicalTotal).toBe(9);
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
      ev({ step: "direction", status: "done", note: "verdict=ok" }),
      ev({ step: "factcheck", status: "error", note: "boom" }),
    ]);
    expect(snap.currentIndex).toBe(4); // factcheck（error=未完）が最初の未完（direction=3 の次）
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
    // factcheck を create より先に記録しても、表示は canonical 順（create=1, refine=2, ..., factcheck=4）。
    const snap = aggregate("r", [
      ev({ step: "factcheck", status: "done" }),
      ev({ step: "create", status: "done" }),
    ]);
    expect(step(snap, "create").index).toBe(1);
    expect(step(snap, "factcheck").index).toBe(4);
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
    expect(revise.index).toBe(10); // 9 canonical の後
    expect(weird.index).toBe(11);
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

  it("places direction between refine and factcheck, and keeps direction-draft non-canonical", () => {
    const snap = aggregate("r", [
      ev({ step: "direction", status: "done", note: "verdict=ok" }),
      ev({ step: "direction-draft", status: "done", note: "early" }),
    ]);
    expect(step(snap, "direction").index).toBe(3); // refine(2) の次・factcheck(4) の前
    expect(step(snap, "direction").canonical).toBe(true);
    expect(step(snap, "factcheck").index).toBe(4);
    const draft = step(snap, "direction-draft");
    expect(draft.canonical).toBe(false); // 早期プレビューは canonical を満たさない
    expect(draft.index).toBeGreaterThan(9); // 9 canonical の後ろ（追加工程）
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
      ev({ step: "direction", status: "error", note: "revise before factcheck; verdict=revise" }),
    ]);
    expect(step(revised, "direction").status).toBe("error");
    expect(revised.currentIndex).toBe(3); // factcheck へ進まない

    // 再判定 ok（done）が error を上書き → currentIndex は factcheck(4) へ。
    const reOk = aggregate("r", [
      ev({ step: "create", status: "done" }),
      ev({ step: "refine", status: "skip", note: "clean" }),
      ev({ step: "direction", status: "error", note: "verdict=revise" }),
      ev({ step: "direction", status: "done", note: "verdict=ok" }),
    ]);
    expect(step(reOk, "direction").status).toBe("done");
    expect(reOk.currentIndex).toBe(4);
  });

  it("marks complete only when every canonical step is done or skipped", () => {
    const allDone = [
      "create",
      "refine",
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

  it("exposes toolVersion from the version-bearing event with the max `at` (time-based, not array order)", () => {
    // at 最大の版を採用する。配列では新版(0.3.0)を先頭に置く＝「配列末尾」を採る実装なら 0.2.0 になり落ちる。
    const snap = aggregate("r", [
      ev({ step: "refine", status: "done", version: "0.3.0", at: "2026-06-21T05:00:00.000Z" }),
      ev({ step: "create", status: "done", version: "0.2.0", at: "2026-06-21T04:00:00.000Z" }),
    ]);
    expect(snap.toolVersion).toBe("0.3.0");
  });

  it("leaves toolVersion undefined when no event carries a version", () => {
    const snap = aggregate("r", [ev({ step: "create", status: "done" })]);
    expect(snap.toolVersion).toBeUndefined();
  });

  it("folds the evaluate alias onto the refine canonical step (single final-review stage)", () => {
    // refine 主経路でも article:evaluate 単独でも、同じ「評価・改稿」枠を満たす。
    const viaEvaluate = aggregate("r", [ev({ step: "evaluate", status: "done", costUsd: 0.1 })]);
    expect(step(viaEvaluate, "refine").status).toBe("done");
    expect(viaEvaluate.steps.filter((s) => s.step === "evaluate").length).toBe(0); // 別行を作らない
    expect(viaEvaluate.canonicalTotal).toBe(9);
  });

  it("keeps the position denominator at canonical count even with non-canonical extras (no 3/11 regression)", () => {
    // 実ログ再現: 全 canonical done/skip ＋ export 未了。revise / direction-draft の非 canonical あり。
    const events = [
      ev({ step: "create", status: "done" }),
      ev({ step: "refine", status: "done" }),
      ev({ step: "direction", status: "done", note: "verdict=ok" }),
      ev({ step: "direction-draft", status: "done", note: "early preview" }), // 非 canonical
      ev({ step: "factcheck", status: "done" }),
      ev({ step: "build-verify", status: "skip", note: "no code" }),
      ev({ step: "editorial", status: "done" }),
      ev({ step: "revise", status: "done", costUsd: 0.05 }), // 非 canonical
      ev({ step: "claims-normalize", status: "done" }),
      ev({ step: "verify-artifacts", status: "done" }),
      // export は未了
    ];
    const snap = aggregate("r", events);
    expect(snap.canonicalTotal).toBe(9); // 分母は canonical のみ（revise/direction-draft で膨らまない）
    expect(snap.total).toBeGreaterThan(9); // 全行数には非 canonical も含む
    expect(step(snap, "export").index).toBe(9);
    expect(snap.currentIndex).toBe(9); // 未完 canonical は export だけ。非 canonical に乗っ取られない
    expect(snap.complete).toBe(false);
  });

  describe("codeCheck（構文/型チェックの実施対象・first-write-wins）", () => {
    it("derives codeCheck from the earliest event that declares it", () => {
      const snap = aggregate("r", [
        ev({ step: "create", status: "start", codeCheck: false }),
        ev({ step: "create", status: "done", codeCheck: false }),
        ev({ step: "build-verify", status: "done", codeCheck: true }), // 後続の宣言では上書きしない
      ]);
      expect(snap.codeCheck).toBe(false);
    });

    it("is undefined for legacy runs that never stamped it", () => {
      const snap = aggregate("r", [ev({ step: "create", status: "done" })]);
      expect(snap.codeCheck).toBeUndefined();
    });

    it("treats build-verify as 対象外(skip) when codeCheck is false and no real event exists", () => {
      const snap = aggregate("r", [
        ev({ step: "create", status: "start", codeCheck: false }),
        ev({ step: "create", status: "done", codeCheck: false }),
        ev({ step: "refine", status: "done" }),
        ev({ step: "direction", status: "done" }),
        ev({ step: "factcheck", status: "done" }),
        ev({ step: "editorial", status: "done" }),
        ev({ step: "claims-normalize", status: "done" }),
        ev({ step: "verify-artifacts", status: "done" }),
        ev({ step: "export", status: "done" }),
      ]);
      const bv = step(snap, "build-verify");
      expect(bv.status).toBe("skip");
      expect(bv.note).toContain("コードチェック非指定");
      // build-verify が未実施の必須工程に見えず、全 canonical done/skip で complete になる。
      expect(snap.complete).toBe(true);
      expect(snap.currentIndex).toBeUndefined();
    });

    it("keeps a real build-verify event over the opted-out synthesized skip (manual rescue)", () => {
      const snap = aggregate("r", [
        ev({ step: "create", status: "done", codeCheck: false }),
        ev({ step: "build-verify", status: "done", note: "手動で実施。report status=passed" }),
      ]);
      const bv = step(snap, "build-verify");
      expect(bv.status).toBe("done");
      expect(bv.note).toContain("手動で実施");
    });

    it("leaves build-verify pending when codeCheck is true and no event yet", () => {
      const snap = aggregate("r", [ev({ step: "create", status: "done", codeCheck: true })]);
      expect(step(snap, "build-verify").status).toBe("pending");
    });
  });

  describe("post-completion log", () => {
    // 全 canonical を done/skip にして完成させる最小イベント列（build-verify は skip）。
    function completing(): ProgressEvent[] {
      return [
        ev({ step: "create", status: "done" }),
        ev({ step: "refine", status: "done" }),
        ev({ step: "direction", status: "done" }),
        ev({ step: "factcheck", status: "done" }),
        ev({ step: "build-verify", status: "skip", note: "n/a" }),
        ev({ step: "editorial", status: "done" }),
        ev({ step: "claims-normalize", status: "done" }),
        ev({ step: "verify-artifacts", status: "done" }),
        ev({ step: "export", status: "done" }), // ← これで完成
      ];
    }

    it("sets completedAt at the first all-terminal event and leaves postCompletion undefined when nothing follows", () => {
      const events = completing();
      const snap = aggregate("r", events);
      expect(snap.complete).toBe(true);
      expect(snap.completedAt).toBe(events[events.length - 1].at); // export の at
      expect(snap.postCompletion).toBeUndefined();
    });

    it("collects events after completion in chronological order", () => {
      const events = [
        ...completing(),
        ev({ step: "revise", status: "done", costUsd: 0.46 }),
        ev({ step: "factcheck", status: "done", note: "差分factcheck" }),
        ev({ step: "export", status: "done", note: "第2版 再export" }),
      ];
      const completedAt = events[8].at; // 最初の export
      const snap = aggregate("r", events);
      expect(snap.completedAt).toBe(completedAt);
      expect(snap.postCompletion?.map((e) => e.step)).toEqual(["revise", "factcheck", "export"]);
      expect(snap.postCompletion?.[0].costUsd).toBe(0.46);
    });

    it("completes via the synthesized build-verify skip (codeCheck=false, no bv event)", () => {
      const events = [
        ev({ step: "create", status: "done", codeCheck: false }),
        ev({ step: "refine", status: "done" }),
        ev({ step: "direction", status: "done" }),
        ev({ step: "factcheck", status: "done" }),
        ev({ step: "editorial", status: "done" }),
        ev({ step: "claims-normalize", status: "done" }),
        ev({ step: "verify-artifacts", status: "done" }),
        ev({ step: "export", status: "done" }),
      ];
      const snap = aggregate("r", events);
      expect(snap.complete).toBe(true);
      expect(snap.completedAt).toBe(events[events.length - 1].at); // export で全 terminal
      expect(snap.postCompletion).toBeUndefined();
    });

    it("delays completion to a manual build-verify recorded after export (findings #2)", () => {
      const events = [
        ev({ step: "create", status: "done", codeCheck: false }),
        ev({ step: "refine", status: "done" }),
        ev({ step: "direction", status: "done" }),
        ev({ step: "factcheck", status: "done" }),
        ev({ step: "editorial", status: "done" }),
        ev({ step: "claims-normalize", status: "done" }),
        ev({ step: "verify-artifacts", status: "done" }),
        ev({ step: "export", status: "done", note: "先に export" }),
        ev({ step: "revise", status: "done", note: "export 後 revise" }),
        ev({ step: "build-verify", status: "done", note: "手動 build-verify" }), // ← 完成はここ
      ];
      const snap = aggregate("r", events);
      // build-verify 実イベントを完成条件に含めるので completedAt は手動 bv まで遅れる。
      expect(snap.completedAt).toBe(events[9].at);
      // export 後・bv 前の revise は完成後ログに入らない。
      expect(snap.postCompletion).toBeUndefined();
    });

    it("preserves tokens and the raw step name (evaluate→refine) in post-completion entries", () => {
      const events = [
        ...completing(),
        ev({ step: "evaluate", status: "done", inputTokens: 30134, outputTokens: 25901 }),
      ];
      const snap = aggregate("r", events);
      const entry = snap.postCompletion?.[0];
      expect(entry?.step).toBe("evaluate"); // raw を保つ
      expect(entry?.canonicalStep).toBe("refine"); // 畳み先
      expect(entry?.label).toBe("評価・改稿（refine / evaluate）");
      expect(entry?.inputTokens).toBe(30134);
      expect(entry?.outputTokens).toBe(25901);
    });

    it("leaves completedAt undefined for a run that never completed", () => {
      const snap = aggregate("r", [ev({ step: "create", status: "done" }), ev({ step: "refine", status: "start" })]);
      expect(snap.complete).toBe(false);
      expect(snap.completedAt).toBeUndefined();
      expect(snap.postCompletion).toBeUndefined();
    });

    it("fixes completedAt to the FIRST completion even after a second round completes again", () => {
      const events = [
        ...completing(),
        ev({ step: "revise", status: "done" }),
        ev({ step: "factcheck", status: "done" }), // canonical をやり直し
        ev({ step: "verify-artifacts", status: "done" }),
        ev({ step: "export", status: "done" }), // 再完成
      ];
      const firstCompletion = events[8].at;
      const snap = aggregate("r", events);
      expect(snap.completedAt).toBe(firstCompletion);
      expect(snap.postCompletion?.length).toBe(4);
    });

    it("does NOT emit the section when the run momentarily completed then regressed (final not complete)", () => {
      // build-verify は完成時 skip。後から error が来ると最終状態は error（error>skip）＝未完に戻る。
      // （done は最高優先度なので done→error では退行しない。退行が起きるのは skip→error 等。）
      const events = [
        ...completing(),
        ev({ step: "build-verify", status: "error", note: "手動で回したら FAIL" }),
      ];
      const snap = aggregate("r", events);
      expect(step(snap, "build-verify").status).toBe("error");
      expect(snap.complete).toBe(false); // 現在地は未完
      expect(snap.completedAt).toBeUndefined();
      expect(snap.postCompletion).toBeUndefined();
    });

    it("orders same-at events by input array order (tie-break)", () => {
      const sameAt = "2026-06-22T05:00:00.000Z";
      const base = completing();
      // 完成後に同一 at の2イベント（revise, factcheck）を入力順 revise→factcheck で置く。
      const events: ProgressEvent[] = [
        ...base,
        { at: sameAt, runId: "r", step: "revise", status: "done" },
        { at: sameAt, runId: "r", step: "factcheck", status: "done" },
      ];
      const snap = aggregate("r", events);
      expect(snap.postCompletion?.map((e) => e.step)).toEqual(["revise", "factcheck"]);
    });

    it("is idempotent: aggregating the same events twice yields equal completedAt/postCompletion", () => {
      const events = [...completing(), ev({ step: "revise", status: "done" }), ev({ step: "export", status: "done" })];
      const a = aggregate("r", events);
      const b = aggregate("r", events);
      expect(a.completedAt).toBe(b.completedAt);
      expect(a.postCompletion).toEqual(b.postCompletion);
    });

    it("keeps both events when the same step is recorded twice post-completion (append-only honesty)", () => {
      const events = [...completing(), ev({ step: "export", status: "done" }), ev({ step: "export", status: "done" })];
      const snap = aggregate("r", events);
      // 集約表は1行に畳むが、完成後ログには export が2件並ぶ。
      expect(snap.postCompletion?.filter((e) => e.step === "export").length).toBe(2);
    });
  });
});
