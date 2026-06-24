import { describe, expect, it } from "vitest";
import {
  memberSlugFromRunId,
  validateSeriesData,
  validateSeriesId,
  type SeriesData,
} from "../../src/storage/seriesMeta";

function validData(over: Partial<SeriesData> = {}): SeriesData {
  return {
    version: 1,
    seriesId: "kagaku-2026",
    profile: "qiita",
    voice: {
      frozen: true,
      version: 1,
      frozenAt: "2026-06-23T00:00:00.000Z",
      hash: "abc",
      history: [{ version: 1, hash: "abc", file: "voice.md" }],
      provenance: [{ kind: "handwritten" }],
    },
    members: [{ order: 1, slug: "x", runId: "2026-06-23-x", status: "done" }],
    ...over,
  };
}

describe("validateSeriesId", () => {
  it("accepts a safe slug", () => {
    expect(validateSeriesId("kagaku-2026")).toBe("kagaku-2026");
  });
  it("rejects reserved keys (prototype pollution safe)", () => {
    expect(() => validateSeriesId("__proto__")).toThrow(/Invalid/);
    expect(() => validateSeriesId("constructor")).toThrow(/Invalid/);
  });
  it("rejects the lock-root name .locks (collides with series/.locks/)", () => {
    expect(() => validateSeriesId(".locks")).toThrow(/Invalid/);
  });
  it("rejects unsafe characters", () => {
    expect(() => validateSeriesId("a b")).toThrow(/Invalid/);
    expect(() => validateSeriesId("../escape")).toThrow(/Invalid/);
  });
});

describe("memberSlugFromRunId", () => {
  it("strips the date prefix", () => {
    expect(memberSlugFromRunId("2026-06-23-ai-ir")).toBe("ai-ir");
  });
  it("leaves a runId without a date prefix unchanged", () => {
    expect(memberSlugFromRunId("custom-id")).toBe("custom-id");
  });
});

describe("validateSeriesData", () => {
  it("accepts valid data", () => {
    expect(() => validateSeriesData(validData())).not.toThrow();
  });

  it("throws on non-object", () => {
    expect(() => validateSeriesData(null)).toThrow(/Corrupt/);
    expect(() => validateSeriesData([])).toThrow(/Corrupt/);
  });

  it("rejects a reserved seriesId", () => {
    expect(() => validateSeriesData(validData({ seriesId: "__proto__" }))).toThrow(/Invalid/);
  });

  it("requires a profile", () => {
    expect(() => validateSeriesData(validData({ profile: "" }))).toThrow(/missing profile/);
  });

  it("requires the frozen voice version to be at the history tail", () => {
    const bad = validData();
    bad.voice.version = 2; // history tail is version 1
    expect(() => validateSeriesData(bad)).toThrow(/history tail/);
  });

  it("accepts a planned member with a null runId", () => {
    const data = validData({ members: [{ order: 2, slug: "y", runId: null, status: "planned" }] });
    const parsed = validateSeriesData(data);
    expect(parsed.members[0].runId).toBeNull();
    expect(parsed.members[0].status).toBe("planned");
  });

  it("rejects an unsafe member slug", () => {
    const data = validData({ members: [{ order: 1, slug: "a b", runId: null, status: "planned" }] });
    expect(() => validateSeriesData(data)).toThrow(/Invalid/);
  });

  it("rejects a 0-based member order (1-based invariant)", () => {
    const data = validData({ members: [{ order: 0, slug: "x", runId: "2026-06-23-x", status: "done" }] });
    expect(() => validateSeriesData(data)).toThrow(/integer >= 1/);
  });

  it("rejects a non-integer member order", () => {
    const data = validData({ members: [{ order: 1.5, slug: "x", runId: "2026-06-23-x", status: "done" }] });
    expect(() => validateSeriesData(data)).toThrow(/integer >= 1/);
  });

  it("preserves writing/updating statuses (does not collapse them to planned)", () => {
    const data = validData({
      members: [
        { order: 1, slug: "w", runId: "2026-06-23-w", status: "writing" },
        { order: 2, slug: "u", runId: "2026-06-23-u", status: "updating" },
        { order: 3, slug: "d", runId: "2026-06-23-d", status: "done" },
      ],
    });
    const parsed = validateSeriesData(data);
    expect(parsed.members.map((m) => m.status)).toEqual(["writing", "updating", "done"]);
  });

  it("falls back an unknown status to planned", () => {
    const data = validData({ members: [{ order: 1, slug: "x", runId: "2026-06-23-x", status: "bogus" as never }] });
    expect(validateSeriesData(data).members[0].status).toBe("planned");
  });

  it("preserves a member candidate title (does not drop it on read)", () => {
    const data = validData({
      members: [{ order: 1, slug: "p", runId: null, status: "planned", title: "候補タイトル" } as never],
    });
    expect(validateSeriesData(data).members[0].title).toBe("候補タイトル");
  });

  it("trims a title and treats empty/whitespace as undefined", () => {
    const data = validData({
      members: [
        { order: 1, slug: "a", runId: null, status: "planned", title: "  pad  " } as never,
        { order: 2, slug: "b", runId: null, status: "planned", title: "   " } as never,
      ],
    });
    const parsed = validateSeriesData(data);
    expect(parsed.members[0].title).toBe("pad");
    expect(parsed.members[1].title).toBeUndefined();
  });
});
