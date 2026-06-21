import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/storage/RunStore";
import { RunProgress } from "../../src/progress/RunProgress";

const RUN = "2026-06-21-prog";

async function newProgress(): Promise<{ progress: RunProgress; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "prog-"));
  const store = new RunStore(root);
  await store.create(RUN, "topic", ["create"]);
  return { progress: new RunProgress(store), root };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("RunProgress", () => {
  it("appends events and regenerates progress.json / progress.md", async () => {
    const { progress, root } = await newProgress();
    await progress.append(RUN, { step: "create", status: "start", task: "create" });
    await progress.append(RUN, { step: "create", status: "done", elapsedMs: 100, costUsd: 0.1 });
    const snap = await progress.regenerate(RUN);

    expect(snap.steps.find((s) => s.step === "create")?.status).toBe("done");

    const json = JSON.parse(await readFile(join(root, RUN, "progress.json"), "utf8"));
    expect(json.runId).toBe(RUN);
    const md = await readFile(join(root, RUN, "progress.md"), "utf8");
    expect(md).toContain("# 進捗: ");
    expect(md).toContain("create");
  });

  it("records done / skip / error and reflects them in the snapshot", async () => {
    const { progress } = await newProgress();
    await progress.append(RUN, { step: "factcheck", status: "done", note: "BLOCKING 0" });
    await progress.append(RUN, { step: "build-verify", status: "skip", note: "no code" });
    await progress.append(RUN, { step: "verify-artifacts", status: "error", note: "FAIL" });
    const snap = await progress.regenerate(RUN);

    expect(snap.steps.find((s) => s.step === "factcheck")?.status).toBe("done");
    expect(snap.steps.find((s) => s.step === "build-verify")?.status).toBe("skip");
    expect(snap.steps.find((s) => s.step === "verify-artifacts")?.status).toBe("error");
  });

  it("is idempotent: regenerating twice yields the same steps", async () => {
    const { progress } = await newProgress();
    await progress.append(RUN, { step: "create", status: "done", costUsd: 0.2 });
    const a = await progress.regenerate(RUN);
    const b = await progress.regenerate(RUN);
    expect(b.steps).toEqual(a.steps);
    expect(b.totalCostUsd).toBe(a.totalCostUsd);
  });

  it("readSnapshot regenerates from events when progress.json is missing", async () => {
    const { progress, root } = await newProgress();
    await progress.append(RUN, { step: "create", status: "done" });
    // progress.json はまだ無い
    await expect(stat(join(root, RUN, "progress.json"))).rejects.toThrow();
    const snap = await progress.readSnapshot(RUN);
    expect(snap.steps.find((s) => s.step === "create")?.status).toBe("done");
  });

  it("readSnapshot re-generates when events are newer than progress.json", async () => {
    const { progress } = await newProgress();
    await progress.append(RUN, { step: "create", status: "done" });
    await progress.regenerate(RUN);
    await sleep(10); // mtime に差をつける
    await progress.append(RUN, { step: "evaluate", status: "done" });
    const snap = await progress.readSnapshot(RUN);
    expect(snap.steps.find((s) => s.step === "evaluate")?.status).toBe("done");
  });

  it("readSnapshot still works on an existing run with no events (all pending)", async () => {
    const { progress } = await newProgress();
    const snap = await progress.readSnapshot(RUN);
    expect(snap.steps.every((s) => s.status === "pending")).toBe(true);
  });

  it("tolerates a corrupt trailing line in events.jsonl", async () => {
    const { progress, root } = await newProgress();
    await progress.append(RUN, { step: "create", status: "done" });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(join(root, RUN, "progress.events.jsonl"), "{ not json\n", "utf8");
    const events = await progress.readEvents(RUN);
    expect(events.length).toBe(1); // 壊れた行はスキップ
  });
});
