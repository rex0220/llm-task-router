import { describe, expect, it } from "vitest";
import {
  gateState,
  hasSkipReason,
  parseGateSummary,
  parseGoNoGo,
  parseReason,
} from "../../src/cli/publicationCheck";

const PC = [
  "# Publication Check",
  "- runId: 2026-06-21-x",
  "- GO/NO-GO: GO",
  "- reason: 全ゲート通過・読者価値あり",
  "- factcheck: done",
  "- factcheck summary: BLOCKING 0 / 主要数値 verified",
  "- build-verify: skipped",
  "- build-verify summary: コードを含まない記事のため",
  "- editorial-review: done",
  "- editorial-review summary: publication-candidate 採用4件",
  "",
].join("\n");

describe("publicationCheck parser", () => {
  it("reads gate states (done / skipped / missing)", () => {
    expect(gateState(PC, "factcheck")).toBe("done");
    expect(gateState(PC, "build-verify")).toBe("skipped");
    expect(gateState(PC, "claims-normalize")).toBe("missing");
  });

  it("does not read the unfilled template 'done / skipped' as done", () => {
    const tmpl = "- factcheck: done / skipped\n";
    expect(gateState(tmpl, "factcheck")).toBe("missing");
  });

  it("detects skip-reason / gate summary presence", () => {
    expect(hasSkipReason(PC, "build-verify")).toBe(true);
    expect(hasSkipReason(PC, "claims-normalize")).toBe(false);
    expect(parseGateSummary(PC, "factcheck")).toBe("BLOCKING 0 / 主要数値 verified");
    expect(parseGateSummary(PC, "editorial-review")).toBe("publication-candidate 採用4件");
  });

  it("parses GO/NO-GO and reason", () => {
    expect(parseGoNoGo(PC)).toBe("GO");
    expect(parseReason(PC)).toBe("全ゲート通過・読者価値あり");
  });

  it("returns undefined for empty (unfilled) fields", () => {
    const empty = ["- GO/NO-GO:", "- reason: ", "- factcheck summary:"].join("\n");
    expect(parseGoNoGo(empty)).toBeUndefined();
    expect(parseReason(empty)).toBeUndefined();
    expect(parseGateSummary(empty, "factcheck")).toBeUndefined();
  });
});
