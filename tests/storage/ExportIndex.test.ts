import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNoVersionRegression,
  entryContentEqual,
  ExportIndex,
  type ExportIndexEntry,
} from "../../src/storage/ExportIndex";

async function newIndex(): Promise<ExportIndex> {
  const dir = await mkdtemp(join(tmpdir(), "idx-"));
  return new ExportIndex(join(dir, "index.json"));
}

function entry(over: Partial<ExportIndexEntry> = {}): ExportIndexEntry {
  return {
    runId: "2026-06-19-x",
    url: "https://qiita.com/u/items/abc",
    articleId: "abc",
    version: 1,
    updatedAt: "2026-06-19T00:00:00.000Z",
    ...over,
  };
}

describe("ExportIndex", () => {
  it("returns an empty index when the file is missing", async () => {
    const index = await newIndex();
    expect(await index.exists()).toBe(false);
    const data = await index.read();
    expect(Object.keys(data.articles)).toHaveLength(0);
    expect(await index.resolve("anything")).toBeUndefined();
  });

  it("writes and resolves an entry", async () => {
    const index = await newIndex();
    await index.write("my-article", entry({ version: 2 }));
    const got = await index.resolve("my-article");
    expect(got?.version).toBe(2);
    expect(got?.articleId).toBe("abc");
    expect(await index.exists()).toBe(true);
  });

  it("upserts (overwrites) an existing slug", async () => {
    const index = await newIndex();
    await index.write("a", entry({ version: 1 }));
    await index.write("a", entry({ version: 2, url: "https://qiita.com/u/items/new" }));
    const got = await index.resolve("a");
    expect(got?.version).toBe(2);
    expect(got?.url).toContain("new");
  });

  it("does not resolve inherited keys (prototype pollution safe)", async () => {
    const index = await newIndex();
    await index.write("a", entry());
    await expect(index.resolve("__proto__")).rejects.toThrow(/Invalid slug/);
    // 継承プロパティ名（安全文字種は通るが台帳には無い）は関数を漏らさず undefined を返す
    expect(await index.resolve("toString")).toBeUndefined();
  });

  it("rejects unsafe slugs", async () => {
    const index = await newIndex();
    await expect(index.resolve("../escape")).rejects.toThrow(/Invalid/);
    await expect(index.write("a b", entry())).rejects.toThrow(/Invalid/);
  });

  it("throws a clear error on a corrupt (invalid JSON) index instead of crashing cryptically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "idx-"));
    const path = join(dir, "index.json");
    await writeFile(path, "{ not json", "utf8");
    const index = new ExportIndex(path);
    await expect(index.read()).rejects.toThrow(/Corrupt export index/);
  });

  it("throws a clear error when the index JSON is not an object", async () => {
    const dir = await mkdtemp(join(tmpdir(), "idx-"));
    const path = join(dir, "index.json");
    await writeFile(path, "null", "utf8");
    const index = new ExportIndex(path);
    await expect(index.read()).rejects.toThrow(/expected a JSON object/);
  });
});

describe("entryContentEqual", () => {
  it("ignores updatedAt", () => {
    expect(entryContentEqual(entry({ updatedAt: "A" }), entry({ updatedAt: "B" }))).toBe(true);
  });
  it("is false when content differs", () => {
    expect(entryContentEqual(entry({ version: 1 }), entry({ version: 2 }))).toBe(false);
    expect(entryContentEqual(undefined, entry())).toBe(false);
  });
});

describe("assertNoVersionRegression", () => {
  it("allows new slug (no existing)", () => {
    expect(() => assertNoVersionRegression(undefined, entry(), false)).not.toThrow();
  });
  it("allows full content match (idempotent re-run)", () => {
    expect(() => assertNoVersionRegression(entry({ updatedAt: "A" }), entry({ updatedAt: "B" }), false)).not.toThrow();
  });
  it("allows a version increase", () => {
    expect(() => assertNoVersionRegression(entry({ version: 1 }), entry({ version: 2 }), false)).not.toThrow();
  });
  it("rejects a non-increasing version with differing content without force", () => {
    expect(() => assertNoVersionRegression(entry({ version: 2 }), entry({ version: 1 }), false)).toThrow(/version/);
    // 同 version で内容（url）が違うケースも reject
    expect(() =>
      assertNoVersionRegression(entry({ version: 2 }), entry({ version: 2, url: "https://qiita.com/u/items/other" }), false)
    ).toThrow(/version/);
  });
  it("allows the regression with force", () => {
    expect(() => assertNoVersionRegression(entry({ version: 2 }), entry({ version: 1 }), true)).not.toThrow();
  });
});
