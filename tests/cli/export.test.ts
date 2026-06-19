import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { exportFinalArticle } from "../../src/cli/export";
import { RunStore } from "../../src/storage/RunStore";

describe("exportFinalArticle", () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function makeRunWithFinal(): Promise<{ store: RunStore; runId: string }> {
    const store = new RunStore(await mkdtemp(join(tmpdir(), "exp-runs-")));
    const runId = "run-export";
    await store.create(runId, "topic", ["final"]);
    await store.save(runId, "final.md", "# Title\n\nbody\n");
    return { store, runId };
  }

  it("writes final.md to the destination path", async () => {
    const { store, runId } = await makeRunWithFinal();
    const outDir = await mkdtemp(join(tmpdir(), "exp-out-"));
    const out = join(outDir, "article.md");

    const dest = await exportFinalArticle(store, runId, out);
    expect(dest).toBe(join(outDir, "article.md"));
    expect(await readFile(out, "utf8")).toContain("# Title");
  });

  it("creates parent directories", async () => {
    const { store, runId } = await makeRunWithFinal();
    const outDir = await mkdtemp(join(tmpdir(), "exp-out-"));
    const out = join(outDir, "nested", "deep", "article.md");

    await exportFinalArticle(store, runId, out);
    expect(await readFile(out, "utf8")).toContain("body");
  });

  it("refuses to overwrite an existing file without force", async () => {
    const { store, runId } = await makeRunWithFinal();
    const outDir = await mkdtemp(join(tmpdir(), "exp-out-"));
    const out = join(outDir, "article.md");
    await writeFile(out, "existing", "utf8");

    await expect(exportFinalArticle(store, runId, out)).rejects.toThrow(/already exists/);
    expect(await readFile(out, "utf8")).toBe("existing");
  });

  it("overwrites with force", async () => {
    const { store, runId } = await makeRunWithFinal();
    const outDir = await mkdtemp(join(tmpdir(), "exp-out-"));
    const out = join(outDir, "article.md");
    await writeFile(out, "existing", "utf8");

    await exportFinalArticle(store, runId, out, { force: true });
    expect(await readFile(out, "utf8")).toContain("# Title");
  });

  it("refuses to write to a secret file name", async () => {
    const { store, runId } = await makeRunWithFinal();
    const outDir = await mkdtemp(join(tmpdir(), "exp-out-"));

    await expect(exportFinalArticle(store, runId, join(outDir, ".env"))).rejects.toThrow(/secret file/);
  });

  it("throws when the run has no final.md", async () => {
    const store = new RunStore(await mkdtemp(join(tmpdir(), "exp-runs-")));
    await store.create("empty", "topic", ["final"]);
    const outDir = await mkdtemp(join(tmpdir(), "exp-out-"));

    await expect(exportFinalArticle(store, "empty", join(outDir, "a.md"))).rejects.toThrow();
  });

  async function makeRun(
    platform: string,
    body: string,
    meta: { articleTitle?: string; tags?: string[] } = {}
  ): Promise<{ store: RunStore; runId: string }> {
    const store = new RunStore(await mkdtemp(join(tmpdir(), "exp-runs-")));
    const runId = "run-fm";
    await store.create(runId, "topic", ["final"], platform);
    await store.save(runId, "final.md", body);
    const m = await store.readMeta(runId);
    m.articleTitle = meta.articleTitle;
    m.tags = meta.tags;
    await store.writeMeta(m);
    return { store, runId };
  }

  it("prepends qiita-cli front-matter and moves the body H1 into title (Qiita)", async () => {
    const { store, runId } = await makeRun("Qiita", "# 月編\n\n本文\n", {
      articleTitle: "月編",
      tags: ["生成AI", "天文学"],
    });
    const out = join(await mkdtemp(join(tmpdir(), "exp-out-")), "a.md");

    await exportFinalArticle(store, runId, out, { frontMatter: true });
    const written = await readFile(out, "utf8");
    expect(written.startsWith("---\n")).toBe(true);
    expect(written).toContain('title: "月編"');
    expect(written).toContain("tags:");
    expect(written).toContain('  - "生成AI"');
    expect(written).toContain('  - "天文学"');
    expect(written).toContain("private: false");
    // 本文先頭の H1 は除去され、重複しない
    expect(written).not.toMatch(/^#\s+月編/m);
    expect(written).toContain("本文");
  });

  it("falls back to the body H1 for the title when meta has none", async () => {
    const { store, runId } = await makeRun("Qiita", "# 本文タイトル\n\nbody\n", { tags: ["Tag"] });
    const out = join(await mkdtemp(join(tmpdir(), "exp-out-")), "a.md");
    await exportFinalArticle(store, runId, out, { frontMatter: true });
    expect(await readFile(out, "utf8")).toContain('title: "本文タイトル"');
  });

  it("does not mistake a '#' comment inside a leading code fence for the title", async () => {
    // 本文に H1 タイトルが無く、先頭がコードフェンス（中に '# ...'）のケース。
    const { store, runId } = await makeRun("Qiita", "```bash\n# install deps\nnpm i\n```\n\nbody\n", { tags: ["Tag"] });
    const out = join(await mkdtemp(join(tmpdir(), "exp-out-")), "a.md");
    await exportFinalArticle(store, runId, out, { frontMatter: true });
    const written = await readFile(out, "utf8");
    // フェンス内コメントをタイトルに採らず、runId にフォールバックする
    expect(written).toContain(`title: "${runId}"`);
    expect(written).not.toContain('title: "install deps"');
    // コードフェンスは壊さない
    expect(written).toContain("```bash");
    expect(written).toContain("# install deps");
  });

  it("warns and writes a clean body when frontMatter is requested for a non-supported platform", async () => {
    const { store, runId } = await makeRun("ブログ", "# T\n\nbody\n", { tags: ["Tag"] });
    const out = join(await mkdtemp(join(tmpdir(), "exp-out-")), "a.md");
    await exportFinalArticle(store, runId, out, { frontMatter: true });
    const written = await readFile(out, "utf8");
    expect(written.startsWith("---")).toBe(false);
    expect(written).toContain("# T"); // clean body, H1 retained
  });

  it("emits Zenn front-matter with topics", async () => {
    const { store, runId } = await makeRun("Zenn", "# Z\n\nbody\n", { articleTitle: "Z", tags: ["TypeScript"] });
    const out = join(await mkdtemp(join(tmpdir(), "exp-out-")), "a.md");
    await exportFinalArticle(store, runId, out, { frontMatter: true });
    const written = await readFile(out, "utf8");
    expect(written).toContain('topics: ["TypeScript"]');
    expect(written).toContain('type: "tech"');
  });

  it("leaves the body clean by default (no front-matter)", async () => {
    const { store, runId } = await makeRun("Qiita", "# T\n\nbody\n", { tags: ["Tag"] });
    const out = join(await mkdtemp(join(tmpdir(), "exp-out-")), "a.md");
    await exportFinalArticle(store, runId, out);
    const written = await readFile(out, "utf8");
    expect(written.startsWith("---")).toBe(false);
    expect(written).toContain("# T");
  });
});
