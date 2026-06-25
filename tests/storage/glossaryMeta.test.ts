import { describe, expect, it } from "vitest";
import { validateGlossaryData, type GlossaryData } from "../../src/storage/glossaryMeta";

function validInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    seriesId: "jomon-2026",
    terms: [{ preferred: "竪穴建物", variants: ["竪穴住居"], firstUseAlias: "per-article", note: "初出のみ可" }],
    nouns: [
      {
        canonical: "三内丸山遺跡",
        attributes: {
          location: { preferred: "青森市", variants: ["青森県"], contextPatterns: ["三内丸山遺跡", "所在地"] },
        },
      },
    ],
    ...over,
  };
}

describe("validateGlossaryData", () => {
  it("round-trips a valid glossary", () => {
    const data: GlossaryData = validateGlossaryData(validInput());
    expect(data.seriesId).toBe("jomon-2026");
    expect(data.terms[0].preferred).toBe("竪穴建物");
    expect(data.terms[0].variants).toEqual(["竪穴住居"]);
    expect(data.nouns[0].attributes.location.variants).toEqual(["青森県"]);
  });

  it("keeps an optional revision and drops it when absent", () => {
    expect(validateGlossaryData(validInput({ revision: 3 })).revision).toBe(3);
    expect(validateGlossaryData(validInput()).revision).toBeUndefined();
  });

  it("defaults firstUseAlias to per-article and accepts false/series-wide", () => {
    expect(validateGlossaryData(validInput({ terms: [{ preferred: "x", variants: [] }] })).terms[0].firstUseAlias).toBe(
      "per-article"
    );
    expect(
      validateGlossaryData(validInput({ terms: [{ preferred: "x", variants: [], firstUseAlias: false }] })).terms[0]
        .firstUseAlias
    ).toBe(false);
    expect(
      validateGlossaryData(validInput({ terms: [{ preferred: "x", variants: [], firstUseAlias: "series-wide" }] }))
        .terms[0].firstUseAlias
    ).toBe("series-wide");
  });

  it("ignores unknown numbers/format keys (forward compat)", () => {
    const data = validateGlossaryData(validInput({ numbers: [{ key: "縄文中期" }], format: { qa: "heading-question" } }));
    expect(data.terms).toHaveLength(1);
  });

  it("rejects a non-object root", () => {
    expect(() => validateGlossaryData([])).toThrow(/expected a YAML mapping/);
    expect(() => validateGlossaryData(null)).toThrow(/expected a YAML mapping/);
  });

  it("rejects a missing or unknown schemaVersion", () => {
    expect(() => validateGlossaryData(validInput({ schemaVersion: undefined }))).toThrow(/schemaVersion/);
    expect(() => validateGlossaryData(validInput({ schemaVersion: 2 }))).toThrow(/Unsupported/);
  });

  it("rejects non-array terms/nouns", () => {
    expect(() => validateGlossaryData(validInput({ terms: {} }))).toThrow(/terms must be an array/);
    expect(() => validateGlossaryData(validInput({ nouns: "x" }))).toThrow(/nouns must be an array/);
  });

  it("rejects an empty preferred/canonical", () => {
    expect(() => validateGlossaryData(validInput({ terms: [{ preferred: "  ", variants: [] }] }))).toThrow(
      /preferred must be a non-empty string/
    );
    expect(() => validateGlossaryData(validInput({ nouns: [{ canonical: "", attributes: {} }] }))).toThrow(
      /canonical must be a non-empty string/
    );
  });

  it("rejects reserved attribute keys (prototype pollution safe)", () => {
    // 注: { __proto__: ... } のリテラルはプロトタイプ設定になり own key にならない。
    // YAML パーサが作る own key を再現するため JSON.parse で構築する。
    const attributes = JSON.parse('{"__proto__":{"preferred":"a","variants":[],"contextPatterns":[]}}');
    expect(() => validateGlossaryData(validInput({ nouns: [{ canonical: "x", attributes }] }))).toThrow(
      /reserved key|must match/
    );
  });

  it("rejects non-ASCII attribute keys (not supported yet)", () => {
    expect(() =>
      validateGlossaryData(
        validInput({ nouns: [{ canonical: "三内丸山遺跡", attributes: { 所在地: { preferred: "青森市", variants: [], contextPatterns: [] } } }] })
      )
    ).toThrow(/non-ASCII keys are not supported/);
  });

  it("validates seriesId format (does not compare against series.json here)", () => {
    expect(() => validateGlossaryData(validInput({ seriesId: "../escape" }))).toThrow(/Invalid/);
  });
});
