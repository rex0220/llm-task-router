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
});
