import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { importArticle } from "../../src/cli/import";
import { RunStore } from "../../src/storage/RunStore";

describe("importArticle", () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function newStore(): Promise<RunStore> {
    return new RunStore(await mkdtemp(join(tmpdir(), "imp-runs-")));
  }

  async function writeArticle(body: string, name = "old-article.md"): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "imp-src-"));
    const path = join(dir, name);
    await writeFile(path, body, "utf8");
    return path;
  }

  it("imports as an import run: final.md, topic from H1, profile style, all steps done", async () => {
    const store = await newStore();
    const from = await writeArticle("# 既存タイトル\n\n本文\n");

    const result = await importArticle(store, { from, profile: "qiita" });

    expect(await store.read(result.runId, "final.md")).toContain("# 既存タイトル");
    const meta = await store.readMeta(result.runId);
    expect(meta.imported).toBe(true);
    expect(meta.topic).toBe("既存タイトル");
    expect(meta.platform).toBe("Qiita");
    expect(meta.style).toBeTruthy(); // profile 由来
    expect(meta.profile).toBe("qiita");
    expect(Object.values(meta.steps).every((s) => s.status === "done")).toBe(true);
    expect(meta.steps.final.file).toBe("final.md");
  });

  it("saves the brush-up brief as brushup-criteria.md", async () => {
    const store = await newStore();
    const from = await writeArticle("# T\n本文\n");

    const { runId } = await importArticle(store, { from, profile: "qiita", criteria: "# 観点\n- 導入を短く\n" });
    expect(await store.read(runId, "brushup-criteria.md")).toContain("導入を短く");
  });

  it("refuses to overwrite an existing run without force", async () => {
    const store = await newStore();
    const from = await writeArticle("# T\n本文\n");

    const { runId } = await importArticle(store, { from, profile: "qiita" });
    await expect(importArticle(store, { from, runId, profile: "qiita" })).rejects.toThrow(/already exists/);
  });

  it("force replace removes a stale brushup-criteria.md when re-imported without criteria", async () => {
    const store = await newStore();
    const from = await writeArticle("# T\n本文\n");

    const { runId } = await importArticle(store, { from, profile: "qiita", criteria: "# 旧観点\n- 旧方針\n" });
    expect(await store.read(runId, "brushup-criteria.md")).toContain("旧方針");

    // criteria 無しで force 再 import → 古い改善方針が残らない（silent 再利用の防止）。
    await importArticle(store, { from, runId, profile: "qiita", force: true });
    await expect(store.read(runId, "brushup-criteria.md")).rejects.toThrow();
  });

  it("force replace removes stale generation artifacts", async () => {
    const store = await newStore();
    const from = await writeArticle("# T\n本文\n");

    const { runId } = await importArticle(store, { from, profile: "qiita" });
    // 生成系成果物が残っている状況を再現
    await store.save(runId, "draft.md", "古い draft");
    await store.save(runId, "review.json", "{}");

    await importArticle(store, { from, runId, profile: "qiita", force: true });
    await expect(store.read(runId, "draft.md")).rejects.toThrow();
    await expect(store.read(runId, "review.json")).rejects.toThrow();
    const meta = await store.readMeta(runId);
    expect(meta.imported).toBe(true);
  });

  it("flags front-matter without removing it", async () => {
    const store = await newStore();
    const from = await writeArticle("---\ntitle: x\n---\n# T\n本文\n");

    const result = await importArticle(store, { from, profile: "qiita" });
    expect(result.frontMatterWarning).toBe(true);
    expect(await store.read(result.runId, "final.md")).toContain("title: x"); // 自動除去しない
  });

  it("throws on an empty article file", async () => {
    const store = await newStore();
    const from = await writeArticle("   \n");
    await expect(importArticle(store, { from, profile: "qiita" })).rejects.toThrow(/empty/);
  });

  it("derives runId from the file name without extension", async () => {
    const store = await newStore();
    const from = await writeArticle("# T\n本文\n", "kintone-plugin.md");
    const { runId } = await importArticle(store, { from, profile: "qiita" });
    expect(runId).toMatch(/-kintone-plugin$/);
  });

  it("saves update-base.md identical to the imported final.md (version baseline)", async () => {
    const store = await newStore();
    const from = await writeArticle("# 既存タイトル\n\n本文\n");

    const { runId } = await importArticle(store, { from, profile: "qiita" });
    const base = await store.read(runId, "update-base.md");
    const final = await store.read(runId, "final.md");
    expect(base).toBe(final);
    expect(base).toContain("# 既存タイトル");
  });

  it("records lineage: sourceExportPath always, supersedes/root when provided", async () => {
    const store = await newStore();
    const from = await writeArticle("# T\n本文\n");

    const { runId } = await importArticle(store, {
      from,
      profile: "qiita",
      supersedesRunId: "2026-06-18-prev",
      rootRunId: "2026-06-01-root",
    });
    const meta = await store.readMeta(runId);
    expect(meta.lineage?.sourceExportPath).toBe(from);
    expect(meta.lineage?.supersedesRunId).toBe("2026-06-18-prev");
    expect(meta.lineage?.rootRunId).toBe("2026-06-01-root");
  });

  it("rejects an unsafe supersedes run id", async () => {
    const store = await newStore();
    const from = await writeArticle("# T\n本文\n");
    await expect(
      importArticle(store, { from, profile: "qiita", supersedesRunId: "../escape" })
    ).rejects.toThrow(/Invalid/);
  });

  it("force re-import regenerates update-base.md from the new source", async () => {
    const store = await newStore();
    const from = await writeArticle("# T\n旧本文\n");
    const { runId } = await importArticle(store, { from, profile: "qiita" });
    expect(await store.read(runId, "update-base.md")).toContain("旧本文");

    const from2 = await writeArticle("# T\n新本文\n");
    await importArticle(store, { from: from2, runId, profile: "qiita", force: true });
    expect(await store.read(runId, "update-base.md")).toContain("新本文");
    expect(await store.read(runId, "update-base.md")).not.toContain("旧本文");
  });
});
