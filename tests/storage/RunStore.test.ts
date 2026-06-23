import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunStore, withTrailingNewline, type RunSeriesMeta } from "../../src/storage/RunStore";
import { tmpRunRoot } from "../helpers/tmp";

const series = (over: Partial<RunSeriesMeta> = {}): RunSeriesMeta => ({
  seriesId: "kagaku",
  voiceVersion: 1,
  voiceHash: "abc",
  ...over,
});

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

  // 非回帰: series を渡さない既存呼び出しでは meta に series キーが現れない（series-c1-plan §9.5）。
  it("does not add a series key when create is called without series", async () => {
    const store = new RunStore(tmpRunRoot());
    await store.create("2026-06-23-x", "topic", ["brief"]);
    const meta = await store.readMeta("2026-06-23-x");
    expect("series" in meta).toBe(false);
  });

  it("embeds series into the initial meta when provided", async () => {
    const store = new RunStore(tmpRunRoot());
    await store.create("2026-06-23-y", "topic", ["brief"], "Qiita", "style", "qiita", series({ order: 2 }));
    const meta = await store.readMeta("2026-06-23-y");
    expect(meta.series).toEqual(series({ order: 2 }));
  });

  describe("listSeriesRuns", () => {
    it("collects runs by seriesId and ignores others", async () => {
      const root = tmpRunRoot();
      const store = new RunStore(root);
      await store.create("2026-06-23-a", "t", ["brief"], undefined, undefined, undefined, series());
      await store.create("2026-06-23-b", "t", ["brief"], undefined, undefined, undefined, series({ order: 2 }));
      await store.create("2026-06-23-c", "t", ["brief"], undefined, undefined, undefined, series({ seriesId: "other" }));
      await store.create("2026-06-23-d", "t", ["brief"]); // no series

      const { runs, warnings } = await store.listSeriesRuns("kagaku");
      expect(runs.map((r) => r.runId).sort()).toEqual(["2026-06-23-a", "2026-06-23-b"]);
      expect(warnings).toHaveLength(0);
    });

    it("returns empty when the runs root does not exist", async () => {
      const store = new RunStore(join(tmpRunRoot(), "missing"));
      const { runs } = await store.listSeriesRuns("kagaku");
      expect(runs).toHaveLength(0);
    });
  });
});

describe("withTrailingNewline", () => {
  it("appends a newline only when missing (byte-equivalent to the old save rule)", () => {
    expect(withTrailingNewline("abc")).toBe("abc\n");
    expect(withTrailingNewline("abc\n")).toBe("abc\n");
    expect(withTrailingNewline("")).toBe("\n");
    expect(withTrailingNewline("a\nb")).toBe("a\nb\n");
  });
});
