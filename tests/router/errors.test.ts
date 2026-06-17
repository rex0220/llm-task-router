import { describe, expect, it } from "vitest";
import { normalizeProviderError, shouldFallback } from "../../src/router/errors";

describe("router errors", () => {
  it("classifies insufficient quota as billing_quota and does not fall back", () => {
    const error = normalizeProviderError({
      status: 429,
      code: "insufficient_quota",
      message: "You exceeded your current quota.",
    });

    expect(error.kind).toBe("billing_quota");
    expect(shouldFallback(error.kind)).toBe(false);
  });

  it("classifies common provider errors", () => {
    expect(normalizeProviderError({ status: 401, message: "bad key" }).kind).toBe("auth");
    expect(normalizeProviderError({ status: 403, message: "forbidden" }).kind).toBe("auth");
    expect(normalizeProviderError({ status: 429, type: "rate_limit_error" }).kind).toBe("rate_limit");
    expect(normalizeProviderError({ status: 529, type: "overloaded_error" }).kind).toBe("overloaded");
    expect(normalizeProviderError({ status: 503, message: "try later" }).kind).toBe("service_unavailable");
  });
});
