import { describe, expect, it } from "vitest";
import { formatDuration } from "../../src/utils/duration";

describe("formatDuration", () => {
  it("formats minutes:seconds.millis", () => {
    expect(formatDuration(241362)).toBe("4:01.362"); // 4分1秒362
    expect(formatDuration(121827)).toBe("2:01.827");
    expect(formatDuration(1200)).toBe("0:01.200");
  });

  it("zero-pads seconds and millis", () => {
    expect(formatDuration(5)).toBe("0:00.005");
    expect(formatDuration(60000)).toBe("1:00.000");
    expect(formatDuration(0)).toBe("0:00.000");
  });

  it("lets minutes overflow past 60 (no hours)", () => {
    expect(formatDuration(72 * 60000 + 5000)).toBe("72:05.000");
  });
});
