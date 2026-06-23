import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSeriesMeta,
  composeSeriesStyle,
  reconcileMembers,
  readSeriesForCreate,
  recordMember,
  resolveSeriesProfile,
  seriesFreezeVoice,
  seriesInit,
  seriesStatus,
  upsertMember,
} from "../../src/cli/series";
import { RunStore, type RunSeriesMeta } from "../../src/storage/RunStore";
import { SeriesStore, voiceHash } from "../../src/storage/SeriesStore";
import type { RunMeta } from "../../src/storage/RunStore";
import type { SeriesMember } from "../../src/storage/seriesMeta";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("composeSeriesStyle", () => {
  it("joins profile style + Series Voice heading + voice body", () => {
    expect(composeSeriesStyle("base style", "calm tone")).toBe("base style\n\n# Series Voice\n\ncalm tone");
  });
  it("starts at the heading when profile style is empty", () => {
    expect(composeSeriesStyle("", "calm tone")).toBe("# Series Voice\n\ncalm tone");
    expect(composeSeriesStyle(undefined, "calm tone")).toBe("# Series Voice\n\ncalm tone");
  });
});

describe("upsertMember", () => {
  const base: SeriesMember[] = [
    { order: 1, slug: "a", runId: "2026-06-23-a", status: "done" },
    { order: 2, slug: "b", runId: null, status: "planned" },
  ];

  it("upserts an existing order slot", () => {
    const out = upsertMember(base, { order: 2, slug: "b2", runId: "2026-06-23-b" });
    expect(out[1]).toEqual({ order: 2, slug: "b2", runId: "2026-06-23-b", status: "done" });
  });
  it("appends at max order + 1 when order is omitted", () => {
    const out = upsertMember(base, { slug: "c", runId: "2026-06-23-c" });
    expect(out[2]).toEqual({ order: 3, slug: "c", runId: "2026-06-23-c", status: "done" });
  });
  it("does not mutate the input", () => {
    upsertMember(base, { order: 1, slug: "x", runId: "y" });
    expect(base[0].slug).toBe("a");
  });
});

describe("reconcileMembers", () => {
  const run = (opts: { runId: string; series?: { order?: number } }): RunMeta => {
    const series: RunSeriesMeta | undefined = opts.series
      ? { seriesId: "s", voiceVersion: 1, voiceHash: "h", order: opts.series.order }
      : undefined;
    return { runId: opts.runId, topic: "t", createdAt: "", updatedAt: "", steps: {}, series } as RunMeta;
  };

  it("flags duplicate orders across runs", () => {
    const { conflicts } = reconcileMembers([], [
      run({ runId: "2026-06-23-a", series: { order: 1 } }),
      run({ runId: "2026-06-23-b", series: { order: 1 } }),
    ]);
    expect(conflicts.some((c) => c.includes("order 1 is claimed by multiple"))).toBe(true);
  });

  it("flags a duplicate runId across member slots", () => {
    const existing: SeriesMember[] = [
      { order: 1, slug: "a", runId: "2026-06-23-a", status: "done" },
      { order: 2, slug: "a2", runId: "2026-06-23-a", status: "done" },
    ];
    const { conflicts } = reconcileMembers(existing, []);
    expect(conflicts.some((c) => c.includes("appears in multiple member slots"))).toBe(true);
  });

  it("flags a planned slug that disagrees with the runId-derived slug", () => {
    const existing: SeriesMember[] = [{ order: 1, slug: "planned-name", runId: null, status: "planned" }];
    const { conflicts, members } = reconcileMembers(existing, [run({ runId: "2026-06-23-actual", series: { order: 1 } })]);
    expect(conflicts.some((c) => c.includes("planned slug"))).toBe(true);
    // run 側を正に埋め直す。
    expect(members[0].runId).toBe("2026-06-23-actual");
    expect(members[0].slug).toBe("actual");
  });
});

describe("series store orchestration", () => {
  it("rejects freezing an empty voice", async () => {
    const seriesRoot = tmp("ltr-s-");
    await seriesInit("kagaku", "qiita", seriesRoot);
    await expect(seriesFreezeVoice("kagaku", undefined, seriesRoot)).rejects.toThrow(/empty/);
  });

  it("reads a frozen series and builds the composed style + series meta for create", async () => {
    const seriesRoot = tmp("ltr-s-");
    await seriesInit("kagaku", "qiita", seriesRoot);
    const vf = join(tmp("ltr-vf-"), "voice.md");
    await writeFile(vf, "precise, calm", "utf8");
    await seriesFreezeVoice("kagaku", vf, seriesRoot);

    const { data, voice } = await readSeriesForCreate("kagaku", seriesRoot);
    expect(composeSeriesStyle("PROFILE", voice)).toContain("precise, calm");
    const meta = buildSeriesMeta(data, 1);
    expect(meta).toEqual({
      seriesId: "kagaku",
      role: "article",
      order: 1,
      voiceVersion: 1,
      voiceHash: voiceHash("precise, calm"),
    });
  });

  it("rejects create when the voice is not frozen", async () => {
    const seriesRoot = tmp("ltr-s-");
    await seriesInit("kagaku", "qiita", seriesRoot);
    await expect(readSeriesForCreate("kagaku", seriesRoot)).rejects.toThrow(/not frozen/);
  });

  it("rejects create when voice.md was edited after freeze (first-write-wins)", async () => {
    const seriesRoot = tmp("ltr-s-");
    await seriesInit("kagaku", "qiita", seriesRoot);
    const vf = join(tmp("ltr-vf-"), "v.md");
    await writeFile(vf, "tone", "utf8");
    await seriesFreezeVoice("kagaku", vf, seriesRoot);
    // 凍結後に voice.md を手編集 → hash 不一致で拒否。
    await writeFile(join(new SeriesStore(seriesRoot).seriesPath("kagaku"), "voice.md"), "tampered", "utf8");
    await expect(readSeriesForCreate("kagaku", seriesRoot)).rejects.toThrow(/edited after freeze/);
  });

  it("resolveSeriesProfile defaults to the series profile and rejects a mismatch unless allowed", () => {
    expect(resolveSeriesProfile("qiita", undefined, false, "kagaku")).toBe("qiita");
    expect(resolveSeriesProfile("qiita", "qiita", false, "kagaku")).toBe("qiita");
    expect(() => resolveSeriesProfile("qiita", "zenn", false, "kagaku")).toThrow(/Profile mismatch/);
    expect(resolveSeriesProfile("qiita", "zenn", true, "kagaku")).toBe("zenn");
  });

  it("records a member and reconciles status against run metadata", async () => {
    const seriesRoot = tmp("ltr-s-");
    const runsRoot = tmp("ltr-r-");
    await seriesInit("kagaku", "qiita", seriesRoot);
    const vf = join(tmp("ltr-vf-"), "v.md");
    await writeFile(vf, "tone", "utf8");
    await seriesFreezeVoice("kagaku", vf, seriesRoot);

    // create-equivalent: a run carrying meta.series, plus the series.json member record.
    const runStore = new RunStore(runsRoot);
    const seriesMeta: RunSeriesMeta = {
      seriesId: "kagaku",
      role: "article",
      order: 1,
      voiceVersion: 1,
      voiceHash: voiceHash("tone"),
    };
    await runStore.create("2026-06-23-ai-ir", "t", ["brief"], "Qiita", "s", "qiita", seriesMeta);
    await recordMember("kagaku", "2026-06-23-ai-ir", 1, seriesRoot);

    const status = await seriesStatus("kagaku", seriesRoot, runsRoot);
    expect(status.members).toHaveLength(1);
    expect(status.members[0]).toMatchObject({ order: 1, slug: "ai-ir", runId: "2026-06-23-ai-ir", status: "done" });
    expect(status.conflicts).toHaveLength(0);
  });

  it("flags a voiceHash mismatch when the run was baked with a different voice", async () => {
    const seriesRoot = tmp("ltr-s-");
    const runsRoot = tmp("ltr-r-");
    await seriesInit("kagaku", "qiita", seriesRoot);
    const vf = join(tmp("ltr-vf-"), "v.md");
    await writeFile(vf, "tone", "utf8");
    await seriesFreezeVoice("kagaku", vf, seriesRoot);

    const runStore = new RunStore(runsRoot);
    await runStore.create("2026-06-23-x", "t", ["brief"], "Qiita", "s", "qiita", {
      seriesId: "kagaku",
      order: 1,
      voiceVersion: 1,
      voiceHash: "stale-hash",
    });
    const status = await seriesStatus("kagaku", seriesRoot, runsRoot);
    expect(status.conflicts.some((c) => c.includes("voiceHash mismatch"))).toBe(true);
  });
});
