import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { exportFinalArticle, LINK_GATE_STAMP_FILE, MARKDOWN_LINT_STAMP_FILE } from "../../src/cli/export";
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

  it("prefers the body H1 over a stale meta.articleTitle (revise updated the H1)", async () => {
    // revise で H1（タイトル）を変更したが meta.articleTitle は create 時の旧値のまま、という状況。
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { store, runId } = await makeRun("Qiita", "# 新しいタイトル（3要素）\n\n本文\n", {
      articleTitle: "古いタイトル（5要素）",
      tags: ["Tag"],
    });
    const out = join(await mkdtemp(join(tmpdir(), "exp-out-")), "a.md");

    await exportFinalArticle(store, runId, out, { frontMatter: true });
    const written = await readFile(out, "utf8");
    // front-matter は revise 後の新 H1 を採用し、旧 articleTitle は捨てる
    expect(written).toContain('title: "新しいタイトル（3要素）"');
    expect(written).not.toContain("古いタイトル（5要素）");
    // 食い違いは silent にせず warn する
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("本文 H1 と meta.articleTitle が異なります"));
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

  // Phase 3: 強調 ** レンダリング不備の export 直前ゲート＋監査スタンプ。
  describe("strong-emphasis export gate", () => {
    async function makeBrokenRun(): Promise<{ store: RunStore; runId: string }> {
      const store = new RunStore(await mkdtemp(join(tmpdir(), "exp-runs-")));
      const runId = "run-broken";
      await store.create(runId, "topic", ["final"], "Qiita");
      await store.save(runId, "final.md", "# T\n\n小惑星は、**「太陽系の化石」**のような存在です。\n");
      return { store, runId };
    }

    it("refuses to export when final.md has broken strong emphasis (and does not write the file)", async () => {
      const { store, runId } = await makeBrokenRun();
      const out = join(await mkdtemp(join(tmpdir(), "exp-out-")), "a.md");
      await expect(exportFinalArticle(store, runId, out)).rejects.toThrow(/開閉できない強調/);
      await expect(readFile(out, "utf8")).rejects.toThrow(); // 書き出していない
      // result:"fail" のスタンプは残る（監査用）
      const stamp = JSON.parse(await store.read(runId, MARKDOWN_LINT_STAMP_FILE));
      expect(stamp.result).toBe("fail");
      expect(stamp.severityMode).toBe("error");
      expect(stamp.ruleVersion).toBe("strong-emphasis-v1");
    });

    it("exports with allowBrokenMarkdown and records the bypass reason in the stamp", async () => {
      const { store, runId } = await makeBrokenRun();
      const out = join(await mkdtemp(join(tmpdir(), "exp-out-")), "a.md");
      await exportFinalArticle(store, runId, out, {
        allowBrokenMarkdown: true,
        allowBrokenMarkdownReason: "明示承認（既知の崩れ）",
      });
      expect(await readFile(out, "utf8")).toContain("太陽系の化石");
      const stamp = JSON.parse(await store.read(runId, MARKDOWN_LINT_STAMP_FILE));
      expect(stamp.result).toBe("fail");
      expect(stamp.allowedBroken).toBe(true);
      expect(stamp.reason).toBe("明示承認（既知の崩れ）");
    });

    it("lints the raw final.md (front-matter is not what gets linted)", async () => {
      // 健全な本文。frontMatter:true でも raw を lint するので pass し、スタンプは pass。
      const { store, runId } = await makeRun("Qiita", "# 月編\n\n「**太陽系の化石**」のような存在。\n", {
        tags: ["Tag"],
      });
      const out = join(await mkdtemp(join(tmpdir(), "exp-out-")), "a.md");
      await exportFinalArticle(store, runId, out, { frontMatter: true });
      const stamp = JSON.parse(await store.read(runId, MARKDOWN_LINT_STAMP_FILE));
      expect(stamp.result).toBe("pass");
      expect(stamp.allowedBroken).toBeUndefined();
    });

    it("writes a pass stamp on a healthy export", async () => {
      const { store, runId } = await makeRunWithFinal();
      const out = join(await mkdtemp(join(tmpdir(), "exp-out-")), "a.md");
      await exportFinalArticle(store, runId, out);
      const stamp = JSON.parse(await store.read(runId, MARKDOWN_LINT_STAMP_FILE));
      expect(stamp.result).toBe("pass");
      expect(stamp.finalHash).toMatch(/^sha256:/);
    });
  });

  // 提案B: 公開前の到達性ゲート（cited な参考リンクの未検証/未解決/死リンクで export を止める）。
  describe("link reachability export gate", () => {
    const CITED_CLAIMS = JSON.stringify([
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
    function sourceJson(over: Record<string, unknown>): string {
      return JSON.stringify([
        {
          id: "S001",
          url: "https://example.com/s1",
          title: "S1",
          retrievedAt: "2026-06-01",
          sourceType: "primary",
          summary: "",
          cited: true,
          ...over,
        },
      ]);
    }
    // createdAt をゲート導入後に固定して legacyGrace を無効化する（未検証を FAIL にする）。
    async function newRun(createdAt = "2026-06-25T00:00:00.000Z"): Promise<{ store: RunStore; runId: string }> {
      const store = new RunStore(await mkdtemp(join(tmpdir(), "exp-runs-")));
      const runId = "run-linkgate";
      await store.create(runId, "topic", ["final"]);
      await store.save(runId, "final.md", "# T\n\nbody\n");
      const m = await store.readMeta(runId);
      m.createdAt = createdAt;
      await store.writeMeta(m);
      return { store, runId };
    }

    it("blocks export when a cited source is unverified (no checkedAt) and writes a fail stamp", async () => {
      const { store, runId } = await newRun();
      await store.save(runId, "claims.json", CITED_CLAIMS);
      await store.save(runId, "sources.json", sourceJson({ reachable: "ok" })); // checkedAt 無し
      const out = join(await mkdtemp(join(tmpdir(), "exp-out-")), "a.md");
      await expect(exportFinalArticle(store, runId, out)).rejects.toThrow(/未検証\/未解決\/死リンク/);
      await expect(readFile(out, "utf8")).rejects.toThrow(); // 書き出していない
      const stamp = JSON.parse(await store.read(runId, LINK_GATE_STAMP_FILE));
      expect(stamp.result).toBe("fail");
      expect(stamp.fails[0].category).toBe("unverified");
    });

    it("exports with allowUnverifiedLinks override", async () => {
      const { store, runId } = await newRun();
      await store.save(runId, "claims.json", CITED_CLAIMS);
      await store.save(runId, "sources.json", sourceJson({ reachable: "ok" }));
      const out = join(await mkdtemp(join(tmpdir(), "exp-out-")), "a.md");
      await exportFinalArticle(store, runId, out, {
        allowUnverifiedLinks: true,
        allowUnverifiedLinksReason: "offline",
      });
      expect(await readFile(out, "utf8")).toContain("body");
      const stamp = JSON.parse(await store.read(runId, LINK_GATE_STAMP_FILE));
      expect(stamp.result).toBe("fail"); // 客観結果は fail のまま（override は export イベントの --note に残す）
    });

    it("passes when cited sources are http-verified and fresh", async () => {
      const { store, runId } = await newRun();
      await store.save(runId, "claims.json", CITED_CLAIMS);
      await store.save(runId, "sources.json", sourceJson({ reachable: "ok", checkedAt: "2026-06-20" }));
      const out = join(await mkdtemp(join(tmpdir(), "exp-out-")), "a.md");
      await exportFinalArticle(store, runId, out);
      expect(await readFile(out, "utf8")).toContain("body");
      const stamp = JSON.parse(await store.read(runId, LINK_GATE_STAMP_FILE));
      expect(stamp.result).toBe("pass");
    });

    it("downgrades unverified to a warning for a legacy run (created before the gate)", async () => {
      const { store, runId } = await newRun("2026-06-01T00:00:00.000Z"); // ゲート導入前
      await store.save(runId, "claims.json", CITED_CLAIMS);
      await store.save(runId, "sources.json", sourceJson({ reachable: "ok" })); // checkedAt 無し
      const out = join(await mkdtemp(join(tmpdir(), "exp-out-")), "a.md");
      await exportFinalArticle(store, runId, out); // FAIL せず通る
      expect(await readFile(out, "utf8")).toContain("body");
      const stamp = JSON.parse(await store.read(runId, LINK_GATE_STAMP_FILE));
      expect(stamp.result).toBe("pass");
      expect(stamp.warnings[0].category).toBe("unverified");
      expect(stamp.legacyGrace).toBe(true);
    });

    it("skips the gate when claims/sources are absent (backward compat)", async () => {
      const { store, runId } = await newRun();
      const out = join(await mkdtemp(join(tmpdir(), "exp-out-")), "a.md");
      await exportFinalArticle(store, runId, out);
      expect(await readFile(out, "utf8")).toContain("body");
      await expect(store.read(runId, LINK_GATE_STAMP_FILE)).rejects.toThrow(); // スタンプ無し
    });
  });
});
