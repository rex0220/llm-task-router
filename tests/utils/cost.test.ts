import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "../../src/utils/cost";

describe("estimateCostUsd", () => {
  it("computes cost from token usage and per-1M prices", () => {
    const cost = estimateCostUsd(
      { inputTokens: 1_000_000, outputTokens: 500_000 },
      { input_usd_per_1m_tokens: 2.5, output_usd_per_1m_tokens: 15 }
    );
    // 1M * 2.5 + 0.5M * 15 = 2.5 + 7.5 = 10
    expect(cost).toBe(10);
  });

  it("returns undefined when no price is configured", () => {
    expect(estimateCostUsd({ inputTokens: 1000, outputTokens: 1000 }, undefined)).toBeUndefined();
  });

  it("returns undefined when prices are zero", () => {
    expect(
      estimateCostUsd(
        { inputTokens: 1000, outputTokens: 1000 },
        { input_usd_per_1m_tokens: 0, output_usd_per_1m_tokens: 0 }
      )
    ).toBeUndefined();
  });

  it("treats missing token counts as zero", () => {
    const cost = estimateCostUsd({ outputTokens: 1_000_000 }, { output_usd_per_1m_tokens: 15 });
    expect(cost).toBe(15);
  });
});
