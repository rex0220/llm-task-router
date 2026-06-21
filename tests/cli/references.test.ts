import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  prepareReferencesBlock,
  renderReferencesBlock,
  replaceMarkedBlock,
  selectReferenceSources,
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

  it("orders primary before secondary, then by id, and dedups", () => {
    const claims = [
      claim({ id: "C001-aaaaaaaa", status: "verified", lifecycle: "present", sourceIds: ["S002", "S001", "S002"] }),
    ];
    const sources = [
      source("S001", { sourceType: "secondary" }),
      source("S002", { sourceType: "primary" }),
    ];
    expect(selectReferenceSources(claims, sources).map((s) => s.id)).toEqual(["S002", "S001"]);
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
});
