import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  headingMatcher,
  prepareReferencesBlock,
  renderReferencesBlock,
  replaceMarkedBlock,
  resolveReferencesHeading,
  selectReferenceSources,
  stripLlmReferenceSections,
  validateReferencesHeading,
  SOURCES_BEGIN,
  SOURCES_END,
} from "../../src/cli/references";
import { RunStore } from "../../src/storage/RunStore";
import type { Claim, Source } from "../../src/schemas/ClaimsSchema";

function claim(over: Partial<Claim> & Pick<Claim, "id" | "status" | "lifecycle" | "sourceIds">): Claim {
  return {
    claim: "x",
    location: { heading: "## h", anchorHash: "aaaaaaaa" },
    type: "general",
    severity: "minor",
    note: "",
    ...over,
  } as Claim;
}

function source(id: string, over: Partial<Source> = {}): Source {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `Title ${id}`,
    retrievedAt: "2026-06-21",
    sourceType: "secondary",
    summary: "",
    cited: false,
    ...over,
  };
}

describe("selectReferenceSources", () => {
  it("includes only sources cited by present & verified claims", () => {
    const claims = [
      claim({ id: "C001-aaaaaaaa", status: "verified", lifecycle: "present", sourceIds: ["S001"] }),
      claim({ id: "C002-bbbbbbbb", status: "unverified", lifecycle: "present", sourceIds: ["S002"] }), // 未検証→除外
      claim({ id: "C003-cccccccc", status: "verified", lifecycle: "removed", sourceIds: ["S003"] }), // removed→除外
    ];
    const sources = [source("S001"), source("S002"), source("S003")];
    expect(selectReferenceSources(claims, sources).map((s) => s.id)).toEqual(["S001"]);
  });

  it("orders by id ascending (regardless of sourceType) and dedups", () => {
    const claims = [
      claim({ id: "C001-aaaaaaaa", status: "verified", lifecycle: "present", sourceIds: ["S002", "S001", "S002"] }),
    ];
    const sources = [
      source("S001", { sourceType: "secondary" }),
      source("S002", { sourceType: "primary" }),
    ];
    expect(selectReferenceSources(claims, sources).map((s) => s.id)).toEqual(["S001", "S002"]);
  });
});

describe("renderReferencesBlock", () => {
  it("renders markers, label line, and URL line", () => {
    const block = renderReferencesBlock([source("S001", { sourceType: "primary", title: "厚労省" })]);
    expect(block.startsWith(SOURCES_BEGIN)).toBe(true);
    expect(block.endsWith(SOURCES_END)).toBe(true);
    expect(block).toContain("- [S001] 厚労省（primary, retrieved: 2026-06-21）");
    expect(block).toContain("  https://example.com/S001");
  });
});

describe("replaceMarkedBlock", () => {
  const block = renderReferencesBlock([source("S001")]);

  it("replaces an existing marker block in place (status=replaced)", () => {
    const body = `# T\n\n## 参考\n\n${SOURCES_BEGIN}\n- 古い\n${SOURCES_END}\n\n以降の文。`;
    const r = replaceMarkedBlock(body, SOURCES_BEGIN, SOURCES_END, block);
    expect(r.status).toBe("replaced");
    expect(r.content).toContain("https://example.com/S001");
    expect(r.content).not.toContain("- 古い");
    expect(r.content).toContain("以降の文。"); // 前後文は保持
  });

  it("replaces the non-marker 参考 section body without duplicating it (status=section-replaced)", () => {
    const body = "# T\n\n## 参考\n- 厚労省「人口動態統計」\n- OECD\n\n## 次の章\n本文";
    const r = replaceMarkedBlock(body, SOURCES_BEGIN, SOURCES_END, block);
    expect(r.status).toBe("section-replaced");
    expect(r.content).not.toContain("- 厚労省「人口動態統計」"); // 旧「名前のみ」は消える（二重化しない）
    expect(r.content).toContain(SOURCES_BEGIN);
    expect(r.content).toContain("## 次の章"); // 後続章は保持
  });

  it("creates a 参考 section at the end when none exists (status=created)", () => {
    const r = replaceMarkedBlock("# T\n本文だけ", SOURCES_BEGIN, SOURCES_END, block);
    expect(r.status).toBe("created");
    expect(r.content).toContain("## 参考");
    expect(r.content).toContain(SOURCES_BEGIN);
  });

  it("throws on malformed markers (only begin / only end / reversed)", () => {
    expect(() => replaceMarkedBlock(`x ${SOURCES_BEGIN} y`, SOURCES_BEGIN, SOURCES_END, block)).toThrow();
    expect(() => replaceMarkedBlock(`x ${SOURCES_END} y`, SOURCES_BEGIN, SOURCES_END, block)).toThrow();
    expect(() => replaceMarkedBlock(`${SOURCES_END}\n${SOURCES_BEGIN}`, SOURCES_BEGIN, SOURCES_END, block)).toThrow();
  });

  const HEADING = "参考・題材として確認した公式情報";

  it("creates a custom heading section when none exists (status=created)", () => {
    const r = replaceMarkedBlock("# T\n本文だけ", SOURCES_BEGIN, SOURCES_END, block, HEADING);
    expect(r.status).toBe("created");
    expect(r.content).toContain(`## ${HEADING}`);
    expect(r.content).not.toMatch(/^## 参考$/m); // 既定見出しは出ない
    expect(r.warnings).toBeUndefined();
  });

  it("preserves a custom heading line when replacing the marker block (Case 1)", () => {
    const body = `# T\n\n## ${HEADING}\n\n${SOURCES_BEGIN}\n- 古い\n${SOURCES_END}\n\n後文`;
    const r = replaceMarkedBlock(body, SOURCES_BEGIN, SOURCES_END, block, HEADING);
    expect(r.status).toBe("replaced");
    expect(r.content).toContain(`## ${HEADING}`); // 見出しは保持
    expect(r.content).not.toContain("- 古い");
  });

  it("replaces the markerless custom-heading section without duplicating (Case 2-a)", () => {
    const body = `# T\n\n## ${HEADING}\n- 旧名のみ\n\n## 次\n本文`;
    const r = replaceMarkedBlock(body, SOURCES_BEGIN, SOURCES_END, block, HEADING);
    expect(r.status).toBe("section-replaced");
    expect(r.content).not.toContain("- 旧名のみ");
    expect(r.content).toContain(SOURCES_BEGIN);
    expect(r.content.match(new RegExp(`## ${HEADING}`, "g"))?.length).toBe(1); // 二重化しない
    expect(r.warnings).toBeUndefined();
  });

  it("adopts/renames a legacy ## 参考 to the custom heading (Case 2-b)", () => {
    // 初回生成で LLM が本文に旧 `## 参考` を書いた状況。設定見出しに rename して二重化を防ぐ。
    const body = "# T\n\n## 参考\n- 旧名のみ\n\n## 次\n本文";
    const r = replaceMarkedBlock(body, SOURCES_BEGIN, SOURCES_END, block, HEADING);
    expect(r.status).toBe("section-replaced");
    expect(r.content).toContain(`## ${HEADING}`); // rename された
    expect(r.content).not.toMatch(/^## 参考$/m); // 旧見出しは消える
    expect(r.content).not.toContain("- 旧名のみ");
    expect(r.warnings).toBeUndefined();
  });

  it("warns but does not throw when both custom heading and legacy ## 参考 exist (Case 2-c)", () => {
    const body = `# T\n\n## ${HEADING}\n- A\n\n## 参考\n- B\n\n## 次\n本文`;
    const r = replaceMarkedBlock(body, SOURCES_BEGIN, SOURCES_END, block, HEADING);
    expect(r.status).toBe("section-replaced");
    expect(r.content).toContain(SOURCES_BEGIN); // 設定見出し章を置換
    expect(r.content).toMatch(/^## 参考$/m); // 旧 ## 参考 は残置
    expect(r.warnings?.join("\n")).toMatch(/旧 ## 参考 が残存/);
  });

  it("keeps default 参考 behavior unchanged when heading is default", () => {
    const body = "# T\n\n## 参考\n- 旧\n\n## 次\n本文";
    const r = replaceMarkedBlock(body, SOURCES_BEGIN, SOURCES_END, block); // heading 省略＝既定
    expect(r.status).toBe("section-replaced");
    expect(r.content).toContain("## 参考");
    expect(r.warnings).toBeUndefined();
  });
});

describe("headingMatcher", () => {
  it("matches a heading containing regex metacharacters without breaking", () => {
    const h = "参考 (一次情報) [確認済]";
    expect(headingMatcher(h).test(`## ${h}`)).toBe(true);
    expect(headingMatcher(h).test("## 参考 x一次情報y z確認済w")).toBe(false);
  });
});

describe("validateReferencesHeading", () => {
  it("accepts a custom heading and trims surrounding whitespace", () => {
    const r = validateReferencesHeading("  参考・題材として確認した公式情報  ");
    expect(r).toEqual({ ok: true, value: "参考・題材として確認した公式情報" });
  });

  it("rejects empty / whitespace-only / newline / # / HTML comment / LLM-colliding headings", () => {
    expect(validateReferencesHeading("").ok).toBe(false);
    expect(validateReferencesHeading("   ").ok).toBe(false);
    expect(validateReferencesHeading("参考\n資料").ok).toBe(false);
    expect(validateReferencesHeading("## 参考").ok).toBe(false); // # を含む
    expect(validateReferencesHeading("参考 <!-- x -->").ok).toBe(false);
    expect(validateReferencesHeading("参考資料").ok).toBe(false); // LLM 見出しと衝突
    expect(validateReferencesHeading("出典").ok).toBe(false);
  });
});

describe("resolveReferencesHeading", () => {
  it("falls back to 参考 when unset or blank", () => {
    expect(resolveReferencesHeading({})).toBe("参考");
    expect(resolveReferencesHeading({ referencesHeading: "   " })).toBe("参考");
    expect(resolveReferencesHeading({ referencesHeading: "参考・確認元" })).toBe("参考・確認元");
  });
});

describe("stripLlmReferenceSections", () => {
  it("removes an LLM 参考リンク section with URLs but keeps the machine ## 参考 block", () => {
    const body = [
      "# 記事",
      "本文。",
      "",
      "## 参考リンク",
      "",
      "- 電通「2025年 日本の広告費」",
      "  https://www.dentsu.co.jp/news/release/2026/0305-011003.html",
      "- 電通 ニュース一覧",
      "  https://www.dentsu.co.jp/news/",
      "",
      "## 参考",
      "",
      SOURCES_BEGIN,
      "- [S001] 2025年 日本の広告費（primary, retrieved: 2026-06-21）",
      "  https://www.dentsu.co.jp/news/release/2026/0305-011003.html",
      SOURCES_END,
      "",
    ].join("\n");
    const r = stripLlmReferenceSections(body);
    expect(r.removed).toEqual(["参考リンク"]);
    expect(r.body).not.toContain("## 参考リンク");
    expect(r.body).not.toContain("ニュース一覧"); // LLM 製 nav リンクも消える
    expect(r.body).toContain("## 参考"); // 機械見出しは残る
    expect(r.body).toContain(SOURCES_BEGIN); // 機械ブロックは無傷
    expect(r.body).toContain("[S001]");
  });

  it("matches 出典 / References / 参考文献 (case-insensitive) when they contain URLs", () => {
    const body = ["## 出典", "- 例 https://example.com/a", "", "## 本論", "本文"].join("\n");
    const r = stripLlmReferenceSections(body);
    expect(r.removed).toEqual(["出典"]);
    expect(r.body).toContain("## 本論");
    expect(r.body).not.toContain("https://example.com/a");
  });

  it("does NOT remove a reference-titled section that has no URL (prose only)", () => {
    const body = ["## 参考リンク", "（後日追記予定。リンクなし）", "", "## 次"].join("\n");
    const r = stripLlmReferenceSections(body);
    expect(r.removed).toEqual([]);
    expect(r.body).toContain("## 参考リンク");
  });

  it("never strips the machine ## 参考 block itself", () => {
    const body = ["## 参考", SOURCES_BEGIN, "- [S001] x", "  https://example.com/a", SOURCES_END].join("\n");
    const r = stripLlmReferenceSections(body);
    expect(r.removed).toEqual([]);
    expect(r.body).toContain(SOURCES_BEGIN);
  });

  it("does not strip the configured custom heading even if it would collide (defense-in-depth)", () => {
    // 「参考資料」は通常 LLM_REFERENCE_HEADING_RE に当たるが、configuredHeading 指定時は除外しない。
    const body = ["## 参考資料", "- 例 https://example.com/a", "", "## 次", "本文"].join("\n");
    const r = stripLlmReferenceSections(body, "参考資料");
    expect(r.removed).toEqual([]);
    expect(r.body).toContain("## 参考資料");
    expect(r.body).toContain("https://example.com/a");
  });
});

describe("prepareReferencesBlock (I/O)", () => {
  async function newStore(): Promise<RunStore> {
    return new RunStore(await mkdtemp(join(tmpdir(), "ref-runs-")));
  }
  const CLAIMS = JSON.stringify([
    {
      id: "C001-aaaaaaaa",
      claim: "x",
      location: { heading: "## h", anchorHash: "aaaaaaaa" },
      type: "general",
      status: "verified",
      lifecycle: "present",
      sourceIds: ["S001"],
      severity: "minor",
      note: "",
    },
  ]);
  const SOURCES = JSON.stringify([
    { id: "S001", url: "https://example.com/doc", title: "Doc", retrievedAt: "2026-06-21", sourceType: "primary", summary: "" },
  ]);

  it("builds a block from claims/sources", async () => {
    const store = await newStore();
    await store.create("r", "T", ["create"]);
    await store.save("r", "claims.json", CLAIMS);
    await store.save("r", "sources.json", SOURCES);
    const { block, count } = await prepareReferencesBlock(store, "r");
    expect(count).toBe(1);
    expect(block).toContain("https://example.com/doc");
  });

  it("errors when claims/sources are missing", async () => {
    const store = await newStore();
    await store.create("r", "T", ["create"]);
    await expect(prepareReferencesBlock(store, "r")).rejects.toThrow(/claims-normalize/);
  });

  it("errors when no present&verified source exists (no empty block)", async () => {
    const store = await newStore();
    await store.create("r", "T", ["create"]);
    await store.save("r", "claims.json", JSON.stringify([]));
    await store.save("r", "sources.json", SOURCES);
    await expect(prepareReferencesBlock(store, "r")).rejects.toThrow(/検証済み source/);
  });

  it("keeps cited reachable:unknown in the block but warns (C-2: 除外せず可視化)", async () => {
    const store = await newStore();
    await store.create("r", "T", ["create"]);
    const claims = JSON.stringify([
      { id: "C001-aaaaaaaa", claim: "a", location: { heading: "## h", anchorHash: "aaaaaaaa" }, type: "general", status: "verified", lifecycle: "present", sourceIds: ["S001"], severity: "minor", note: "" },
    ]);
    const sources = JSON.stringify([
      { id: "S001", url: "https://unknown.example/x", title: "Unknown", retrievedAt: "2026-06-21", sourceType: "primary", summary: "", reachable: "unknown", cited: true },
    ]);
    await store.save("r", "claims.json", claims);
    await store.save("r", "sources.json", sources);
    const { block, count, warnings } = await prepareReferencesBlock(store, "r");
    expect(count).toBe(1); // unknown は参考章に残す（block に出る）
    expect(block).toContain("https://unknown.example/x");
    expect(warnings.join("\n")).toMatch(/reachable=unknown.*S001/);
  });

  it("does NOT throw when every cited source is unknown (no zero-throw via unknown — gate に集約)", async () => {
    const store = await newStore();
    await store.create("r", "T", ["create"]);
    const claims = JSON.stringify([
      { id: "C001-aaaaaaaa", claim: "a", location: { heading: "## h", anchorHash: "aaaaaaaa" }, type: "general", status: "verified", lifecycle: "present", sourceIds: ["S001"], severity: "minor", note: "" },
    ]);
    const sources = JSON.stringify([
      { id: "S001", url: "https://unknown.example/x", title: "Unknown", retrievedAt: "2026-06-21", sourceType: "primary", summary: "", reachable: "unknown", cited: true },
    ]);
    await store.save("r", "claims.json", claims);
    await store.save("r", "sources.json", sources);
    const { count } = await prepareReferencesBlock(store, "r");
    expect(count).toBe(1); // throw せず参考章を生成（除外・停止は linkGate の責務）
  });

  it("excludes reachable:dead from the block and returns a warning", async () => {
    const store = await newStore();
    await store.create("r", "T", ["create"]);
    // cited だが dead な S001 と、cited かつ live な S002。
    const claims = JSON.stringify([
      { id: "C001-aaaaaaaa", claim: "a", location: { heading: "## h", anchorHash: "aaaaaaaa" }, type: "general", status: "verified", lifecycle: "present", sourceIds: ["S001"], severity: "minor", note: "" },
      { id: "C002-bbbbbbbb", claim: "b", location: { heading: "## h", anchorHash: "bbbbbbbb" }, type: "general", status: "verified", lifecycle: "present", sourceIds: ["S002"], severity: "minor", note: "" },
    ]);
    const sources = JSON.stringify([
      { id: "S001", url: "https://dead.example/x", title: "Dead", retrievedAt: "2026-06-21", sourceType: "primary", summary: "", reachable: "dead", cited: true },
      { id: "S002", url: "https://live.example/y", title: "Live", retrievedAt: "2026-06-21", sourceType: "primary", summary: "", reachable: "ok", cited: true },
    ]);
    await store.save("r", "claims.json", claims);
    await store.save("r", "sources.json", sources);
    const { block, count, warnings } = await prepareReferencesBlock(store, "r");
    expect(count).toBe(1);
    expect(block).toContain("https://live.example/y");
    expect(block).not.toContain("https://dead.example/x");
    expect(warnings.join("\n")).toMatch(/reachable=dead.*S001/);
  });
});
