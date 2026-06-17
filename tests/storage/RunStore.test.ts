import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/storage/RunStore";
import { tmpRunRoot } from "../helpers/tmp";

describe("RunStore", () => {
  it("saves artifacts and step metadata under the run directory", async () => {
    const store = new RunStore(tmpRunRoot());
    const runId = `test-store-${Date.now()}`;

    await store.create(runId, "topic", ["brief"]);
    await store.save(runId, "brief.json", "{\"ok\":true}");
    await store.markDone(runId, "brief", "brief.json");

    const meta = await store.readMeta(runId);
    const content = await store.read(runId, "brief.json");

    expect(meta.steps.brief).toEqual({ status: "done", file: "brief.json" });
    expect(content).toContain("\"ok\":true");
  });

  it("rejects unsafe run ids", async () => {
    const store = new RunStore(tmpRunRoot());
    await expect(store.create("../bad", "topic", [])).rejects.toThrow("Invalid run id");
  });
});
