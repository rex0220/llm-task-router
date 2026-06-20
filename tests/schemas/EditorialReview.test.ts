import { describe, expect, it } from "vitest";
import { EditorialReviewSchema } from "../../src/schemas/EditorialReviewSchema";
import { schemaRegistry } from "../../src/schemas";

const valid = {
  verdict: "publication-candidate",
  scores: [
    { axis: "科学的正確性", score: 9 },
    { axis: "構成", score: 9.5 },
  ],
  strengths: ["一本の因果線を維持している"],
  weaknesses: [
    { severity: "major", location: "補論/Q値", problem: "Q の定義が曖昧", recommendation: "実効Qと体潮汐Qを分ける" },
    { severity: "preference", problem: "節タイトルがやや硬い", recommendation: "言い換える" },
  ],
  summary: "高品質な科学教養記事",
};

describe("EditorialReviewSchema", () => {
  it("is registered under the EditorialReview SchemaName", () => {
    expect(schemaRegistry.EditorialReview).toBe(EditorialReviewSchema);
  });

  it("accepts a well-formed editorial review (raw has no weakness id)", () => {
    const parsed = EditorialReviewSchema.parse(valid);
    expect(parsed.weaknesses[0]).not.toHaveProperty("id"); // id はパイプラインが normalize 時に採番
    expect(parsed.verdict).toBe("publication-candidate");
  });

  it("rejects an invalid verdict", () => {
    expect(() => EditorialReviewSchema.parse({ ...valid, verdict: "great" })).toThrow();
  });

  it("rejects an unknown weakness severity (only major|minor|preference)", () => {
    expect(() =>
      EditorialReviewSchema.parse({
        ...valid,
        weaknesses: [{ severity: "critical", problem: "x", recommendation: "y" }],
      })
    ).toThrow();
  });

  it("rejects a missing required field", () => {
    const { summary, ...withoutSummary } = valid;
    void summary;
    expect(() => EditorialReviewSchema.parse(withoutSummary)).toThrow();
  });
});
