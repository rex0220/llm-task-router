import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkArticle,
  matchNouns,
  matchTerms,
  runSeriesCheck,
  splitParagraphs,
  stripReferenceBlock,
  type Paragraph,
} from "../../src/cli/seriesCheck";
import type { GlossaryData } from "../../src/storage/glossaryMeta";
import { RunStore } from "../../src/storage/RunStore";
import { SeriesStore } from "../../src/storage/SeriesStore";
import { SERIES_FORMAT_VERSION, type SeriesData } from "../../src/storage/seriesMeta";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function glossary(over: Partial<GlossaryData> = {}): GlossaryData {
  return {
    schemaVersion: 1,
    seriesId: "jomon-2026",
    terms: [{ preferred: "竪穴建物", variants: ["竪穴住居"], firstUseAlias: "per-article" }],
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

const textParas = (...texts: string[]): Paragraph[] => texts.map((t) => ({ text: t, code: false }));

describe("splitParagraphs", () => {
  it("splits on blank lines and marks code fences as code", () => {
    const md = "段落A。\n\n段落B。\n\n```\nコード内 竪穴住居\n```\n\n段落C。";
    const paras = splitParagraphs(md);
    expect(paras.map((p) => p.code)).toEqual([false, false, true, false]);
    expect(paras[2].text).toContain("竪穴住居");
  });

  it("treats an unclosed fence as code (excluded from matching)", () => {
    const md = "本文。\n\n```\nまだ閉じてない 竪穴住居";
    const paras = splitParagraphs(md);
    expect(paras[paras.length - 1].code).toBe(true);
  });

  it("splits adjacent list items / headings / table rows into separate paragraphs (no blank line)", () => {
    const md = "## 見出し\n本文行。\n- 項目A\n- 項目B\n| 行1 |\n| 行2 |";
    const texts = splitParagraphs(md).map((p) => p.text);
    expect(texts).toEqual(["## 見出し", "本文行。", "- 項目A", "- 項目B", "| 行1 |", "| 行2 |"]);
  });
});

describe("matchTerms", () => {
  it("flags a bare variant occurrence", () => {
    const findings = matchTerms(textParas("ここでは竪穴住居が並ぶ。"), glossary().terms);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "term", preferred: "竪穴建物", found: "竪穴住居" });
  });

  it("allows the first parenthetical alias and flags later occurrences", () => {
    // 初出は括弧内併記＝許容、2回目の素の出現は検出。
    const md = textParas("竪穴建物（竪穴住居）について説明する。", "再び竪穴住居が出る。");
    const findings = matchTerms(md, glossary().terms);
    expect(findings).toHaveLength(1);
    expect(findings[0].paragraphIndex).toBe(1);
  });

  it("allows the first same-sentence alias next to the preferred term", () => {
    const findings = matchTerms(textParas("竪穴建物はかつて竪穴住居と呼ばれた。"), glossary().terms);
    expect(findings).toHaveLength(0);
  });

  it("does not allow aliases when firstUseAlias is false", () => {
    const terms = [{ preferred: "竪穴建物", variants: ["竪穴住居"], firstUseAlias: false as const }];
    const findings = matchTerms(textParas("竪穴建物（竪穴住居）。"), terms);
    expect(findings).toHaveLength(1);
  });

  it("ignores variants inside code paragraphs", () => {
    const paras: Paragraph[] = [{ text: "竪穴住居", code: true }];
    expect(matchTerms(paras, glossary().terms)).toHaveLength(0);
  });

  it("applies the first-use exemption in text order, not variants-array order", () => {
    // variants は [B, A] の順だが、本文では A が先に括弧併記で出る。初回例外は本文順の A に当たる。
    const terms = [{ preferred: "正", variants: ["B語", "A語"], firstUseAlias: "per-article" as const }];
    // 同一段落内: 「正（A語）… B語」。先頭の A語 は括弧内併記で許容、後続の B語 は検出。
    const findings = matchTerms(textParas("正（A語）と説明し、のちに B語 も出る。"), terms);
    expect(findings).toHaveLength(1);
    expect(findings[0].found).toBe("B語");
  });
});

describe("matchNouns", () => {
  it("flags a variant only when context is present in the same paragraph (OR)", () => {
    const findings = matchNouns(textParas("三内丸山遺跡は青森県にある。"), glossary().nouns);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ preferred: "青森市", found: "青森県", attribute: "location" });
  });

  it("does not flag when the variant and context are in different paragraphs (false negative tolerated)", () => {
    const findings = matchNouns(textParas("三内丸山遺跡の話。", "別の段落で青森県と書く。"), glossary().nouns);
    expect(findings).toHaveLength(0);
  });

  it("matches via contextPatterns even without the canonical", () => {
    const findings = matchNouns(textParas("その所在地は青森県だ。"), glossary().nouns);
    expect(findings).toHaveLength(1);
  });

  it("does not merge separate list items into one paragraph (no false positive across bullets)", () => {
    // canonical と variant が別々の箇条書き項目にある場合は検出しない（段落分割の効果）。
    const md = "- 三内丸山遺跡の説明。\n- 青森県についての別項目。";
    expect(checkArticle(md, glossary())).toHaveLength(0);
  });
});

describe("stripReferenceBlock", () => {
  it("removes the sources marker region (first priority)", () => {
    const md = "本文。\n\n## 参考\n\n<!-- sources:begin -->\n- [S1] 三内丸山遺跡（青森県公式）\n<!-- sources:end -->";
    const out = stripReferenceBlock(md);
    expect(out).not.toContain("青森県公式");
    expect(out).toContain("本文。");
  });

  it("removes from begin to EOF when the end marker is missing", () => {
    const md = "本文。\n\n<!-- sources:begin -->\n- [S1] …青森県公式";
    expect(stripReferenceBlock(md)).not.toContain("青森県公式");
  });

  it("falls back to the 参考 heading up to the next same-or-higher heading", () => {
    const md = "本文。\n\n## 参考\n- [S1] 青森県公式\n\n## 次の節\n青森県の本文。";
    const out = stripReferenceBlock(md);
    expect(out).not.toContain("青森県公式");
    expect(out).toContain("## 次の節");
    expect(out).toContain("青森県の本文。");
  });

  it("falls back to EOF when no later same-or-higher heading exists, and keeps deeper ### inside", () => {
    const md = "本文。\n\n## 出典\n### サブ\n- [S1] 青森県公式";
    const out = stripReferenceBlock(md);
    expect(out).not.toContain("青森県公式");
    expect(out).not.toContain("### サブ");
  });

  it("treats 参考リンク / 出典 as reference headings too", () => {
    expect(stripReferenceBlock("本文。\n\n## 参考リンク\n- 青森県公式")).not.toContain("青森県公式");
    expect(stripReferenceBlock("本文。\n\n## 出典\n- 青森県公式")).not.toContain("青森県公式");
  });

  it("leaves markdown without a reference block unchanged", () => {
    const md = "本文。\n\n三内丸山遺跡は青森県にある。";
    expect(stripReferenceBlock(md)).toBe(md);
  });
});

describe("checkArticle", () => {
  it("combines term and noun findings and skips code blocks", () => {
    const md = "三内丸山遺跡は青森県にある。\n\n竪穴住居が見つかった。\n\n```\n竪穴住居\n```";
    const findings = checkArticle(md, glossary());
    expect(findings).toHaveLength(2);
    expect(findings.filter((f) => f.kind === "noun")).toHaveLength(1);
    expect(findings.filter((f) => f.kind === "term")).toHaveLength(1);
  });

  it("does not flag variants inside the machine-generated reference section (known noise removed)", () => {
    // 本文に揺れは無く、参考章のソース名にだけ青森県がある＝検出ゼロ（第1.5段の効果）。
    const md = "三内丸山遺跡は青森市にある。\n\n## 参考\n\n<!-- sources:begin -->\n- [S6] 三内丸山遺跡とは（青森県公式）\n<!-- sources:end -->";
    expect(checkArticle(md, glossary())).toHaveLength(0);
  });
});

describe("runSeriesCheck", () => {
  async function setup(opts: { withGlossary?: boolean; glossarySeriesId?: string } = {}) {
    const seriesRoot = tmp("ltr-gs-");
    const runsRoot = tmp("ltr-gr-");
    const seriesStore = new SeriesStore(seriesRoot);
    const runStore = new RunStore(runsRoot);

    const data: SeriesData = {
      version: SERIES_FORMAT_VERSION,
      seriesId: "jomon-2026",
      profile: "qiita",
      voice: { frozen: false, version: 0, frozenAt: "", hash: "", history: [], provenance: [] },
      members: [
        { order: 1, slug: "jomon-1", runId: "2026-06-23-jomon-1", status: "done" },
        { order: 2, slug: "jomon-2", runId: "2026-06-23-jomon-2", status: "done" },
        { order: 3, slug: "jomon-3", runId: "2026-06-23-jomon-3", status: "writing" },
        { order: 4, slug: "jomon-4", runId: null, status: "planned" },
      ],
    };
    await seriesStore.write("jomon-2026", data);

    if (opts.withGlossary !== false) {
      const sid = opts.glossarySeriesId ?? "jomon-2026";
      const yaml = [
        "schemaVersion: 1",
        `seriesId: ${sid}`,
        "terms:",
        "  - preferred: 竪穴建物",
        "    variants: [竪穴住居]",
        "nouns:",
        "  - canonical: 三内丸山遺跡",
        "    attributes:",
        "      location:",
        "        preferred: 青森市",
        "        variants: [青森県]",
        "        contextPatterns: [三内丸山遺跡, 所在地]",
        "",
      ].join("\n");
      await writeFile(join(seriesStore.seriesPath("jomon-2026"), "glossary.yaml"), yaml, "utf8");
    }

    // jomon-1: 正しい（竪穴建物・青森市）。jomon-2: 揺れ（竪穴住居・青森県）。jomon-3: final.md 欠落。
    await runStore.save("2026-06-23-jomon-1", "final.md", "三内丸山遺跡は青森市にある。\n\n竪穴建物が並ぶ。");
    await runStore.save("2026-06-23-jomon-2", "final.md", "三内丸山遺跡は青森県にある。\n\n竪穴住居が見つかった。");
    // jomon-3 は final.md を書かない（skip 理由を固定）。

    return { seriesStore, runStore, deps: { seriesStore, runStore, now: () => "2026-06-25T00:00:00.000Z" } };
  }

  it("checks members, records findings, and skips planned/missing with reasons", async () => {
    const { deps } = await setup();
    const report = await runSeriesCheck("jomon-2026", deps);

    expect(report.missingGlossary).toBe(false);
    expect(report.checkedAt).toBe("2026-06-25T00:00:00.000Z");
    expect(report.glossary?.hash).toMatch(/^[0-9a-f]{64}$/);

    const byOrder = Object.fromEntries(report.members.map((m) => [m.order, m]));
    expect(byOrder[1].findings).toHaveLength(0);
    expect(byOrder[2].findings).toHaveLength(2);
    expect(byOrder[3].skipped).toBe("final.md missing");
    expect(byOrder[4].skipped).toBe("planned");
    expect(report.totalFindings).toBe(2);
  });

  it("returns missingGlossary when glossary.yaml is absent (no throw)", async () => {
    const { deps } = await setup({ withGlossary: false });
    const report = await runSeriesCheck("jomon-2026", deps);
    expect(report.missingGlossary).toBe(true);
    expect(report.totalFindings).toBe(0);
    expect(report.members.every((m) => m.skipped === "glossary not configured")).toBe(true);
  });

  it("throws when glossary seriesId does not match series.json", async () => {
    const { deps } = await setup({ glossarySeriesId: "other-series" });
    await expect(runSeriesCheck("jomon-2026", deps)).rejects.toThrow(/does not match series.json seriesId/);
  });

  it("warns that series-wide is treated as per-article", async () => {
    const seriesRoot = tmp("ltr-gs-");
    const runsRoot = tmp("ltr-gr-");
    const seriesStore = new SeriesStore(seriesRoot);
    const runStore = new RunStore(runsRoot);
    await seriesStore.write("jomon-2026", {
      version: SERIES_FORMAT_VERSION,
      seriesId: "jomon-2026",
      profile: "qiita",
      voice: { frozen: false, version: 0, frozenAt: "", hash: "", history: [], provenance: [] },
      members: [],
    });
    const yaml = ["schemaVersion: 1", "seriesId: jomon-2026", "terms:", "  - preferred: x", "    variants: [y]", "    firstUseAlias: series-wide", ""].join("\n");
    await writeFile(join(seriesStore.seriesPath("jomon-2026"), "glossary.yaml"), yaml, "utf8");
    const report = await runSeriesCheck("jomon-2026", { seriesStore, runStore });
    expect(report.warnings.some((w) => w.includes("series-wide"))).toBe(true);
  });
});
