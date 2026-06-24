import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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

describe("recordMember resolved order (Step 2)", () => {
  async function frozen(seriesRoot: string): Promise<void> {
    await seriesInit("kagaku", "qiita", seriesRoot);
    const vf = join(tmp("ltr-vf-"), "v.md");
    await writeFile(vf, "tone", "utf8");
    await seriesFreezeVoice("kagaku", vf, seriesRoot);
  }

  it("returns 1 for the first member when order is omitted", async () => {
    const seriesRoot = tmp("ltr-s-");
    await frozen(seriesRoot);
    expect(await recordMember("kagaku", "2026-06-23-a", undefined, seriesRoot)).toBe(1);
  });

  it("auto-numbers the next member at max order + 1", async () => {
    const seriesRoot = tmp("ltr-s-");
    await frozen(seriesRoot);
    await recordMember("kagaku", "2026-06-23-a", undefined, seriesRoot);
    await recordMember("kagaku", "2026-06-23-b", undefined, seriesRoot);
    expect(await recordMember("kagaku", "2026-06-23-c", undefined, seriesRoot)).toBe(3);
  });

  it("returns the explicit order when given", async () => {
    const seriesRoot = tmp("ltr-s-");
    await frozen(seriesRoot);
    expect(await recordMember("kagaku", "2026-06-23-a", 5, seriesRoot)).toBe(5);
  });
});

describe("seriesStatus nullOrderRunIds (Step 3)", () => {
  it("collects runs whose meta.series.order is missing", async () => {
    const seriesRoot = tmp("ltr-s-");
    const runsRoot = tmp("ltr-r-");
    await seriesInit("kagaku", "qiita", seriesRoot);
    const vf = join(tmp("ltr-vf-"), "v.md");
    await writeFile(vf, "tone", "utf8");
    await seriesFreezeVoice("kagaku", vf, seriesRoot);

    const runStore = new RunStore(runsRoot);
    // order を欠いた run（既知バグ状態）。
    await runStore.create("2026-06-23-noorder", "t", ["brief"], "Qiita", "s", "qiita", {
      seriesId: "kagaku",
      voiceVersion: 1,
      voiceHash: voiceHash("tone"),
    });
    const status = await seriesStatus("kagaku", seriesRoot, runsRoot);
    expect(status.nullOrderRunIds).toContain("2026-06-23-noorder");
  });
});

describe("recordMember concurrency serialization (Step 4)", () => {
  it("auto-numbers without duplicate orders or lost updates under parallel calls", async () => {
    const seriesRoot = tmp("ltr-s-");
    await seriesInit("kagaku", "qiita", seriesRoot);
    const vf = join(tmp("ltr-vf-"), "v.md");
    await writeFile(vf, "tone", "utf8");
    await seriesFreezeVoice("kagaku", vf, seriesRoot);

    const n = 20;
    const runIds = Array.from({ length: n }, (_, i) => `2026-06-23-r${String(i).padStart(2, "0")}`);
    const orders = await Promise.all(runIds.map((id) => recordMember("kagaku", id, undefined, seriesRoot)));

    // 戻り値 order は重複しない 1..n の連番（R1 根絶）。
    expect([...orders].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i + 1));

    // series.json には全 runId が残り（R2: lost update なし）、order も重複しない。
    const data = await new SeriesStore(seriesRoot).read("kagaku");
    expect(data?.members).toHaveLength(n);
    expect(new Set(data?.members.map((m) => m.runId)).size).toBe(n);
    expect(new Set(data?.members.map((m) => m.order)).size).toBe(n);
  });

  // ネガティブコントロール（計画テスト計画 項5）: ロックを外すと R2（lost update）が再現することを
  // 示し、上の正例テストが「ロックが効いている」ことを実際に検出できている証跡にする。
  // 将来 recordMember の read-modify-write がよりアトミックに寄ってこの負例が pass し始めたら、
  // 正例の検出力が落ちるサインなので、その時はテスト構造を見直す。
  it("(negative control) loses updates WITHOUT the lock — proves the lock is what protects R2", async () => {
    const seriesRoot = tmp("ltr-s-");
    await seriesInit("kagaku", "qiita", seriesRoot);
    const vf = join(tmp("ltr-vf-"), "v.md");
    await writeFile(vf, "tone", "utf8");
    await seriesFreezeVoice("kagaku", vf, seriesRoot);

    // withLock を即実行（ロック無し）に差し替える。
    const spy = vi
      .spyOn(SeriesStore.prototype, "withLock")
      .mockImplementation((_slug: string, fn: () => Promise<unknown>) => fn());
    try {
      const n = 20;
      const runIds = Array.from({ length: n }, (_, i) => `2026-06-23-n${String(i).padStart(2, "0")}`);
      await Promise.all(runIds.map((id) => recordMember("kagaku", id, undefined, seriesRoot)));

      // ロック無しでは全員が空 members を read→order=1 を計算→last-write-wins で取りこぼす。
      const data = await new SeriesStore(seriesRoot).read("kagaku");
      expect(data!.members.length).toBeLessThan(n);
    } finally {
      spy.mockRestore();
    }
  });
});
