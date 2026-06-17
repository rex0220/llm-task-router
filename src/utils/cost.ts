import type { ModelPrice, ModelUsage } from "../router/types";

export function estimateCostUsd(usage: ModelUsage | undefined, price: ModelPrice | undefined): number | undefined {
  if (!usage || !price) {
    return undefined;
  }

  const inputRate = price.input_usd_per_1m_tokens ?? 0;
  const outputRate = price.output_usd_per_1m_tokens ?? 0;

  if (inputRate <= 0 && outputRate <= 0) {
    return undefined;
  }

  const inputCost = ((usage.inputTokens ?? 0) / 1_000_000) * inputRate;
  const outputCost = ((usage.outputTokens ?? 0) / 1_000_000) * outputRate;
  return Number((inputCost + outputCost).toFixed(6));
}
