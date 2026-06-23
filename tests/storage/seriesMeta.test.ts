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
});
