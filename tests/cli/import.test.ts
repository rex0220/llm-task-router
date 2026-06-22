import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { importArticle } from "../../src/cli/import";
import { RunStore } from "../../src/storage/RunStore";
import { RunProgress } from "../../src/progress/RunProgress";

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
    // import 由来は外部/人間作 → finalAuthorModel は "external"（編集レビューの独立性チェック免除）。
    expect(meta.finalAuthorModel).toBe("external");
  });

  it("stamps codeCheck=false by default (build-verify opted out, same as create)", async () => {
    const store = await newStore();
    const from = await writeArticle("# T\n本文\n");
    const { runId } = await importArticle(store, { from, profile: "qiita" });
    const snap = await new RunProgress(store).readSnapshot(runId);
    expect(snap.codeCheck).toBe(false);
    // build-verify は対象外（skip 合成）として現在地を塞がない。
    expect(snap.steps.find((s) => s.step === "build-verify")?.status).toBe("skip");
  });

  it("stamps codeCheck=true when --code-check is requested at import", async () => {
    const store = await newStore();
    const from = await writeArticle("# T\n本文\n");
    const { runId } = await importArticle(store, { from, profile: "qiita", codeCheck: true });
    const snap = await new RunProgress(store).readSnapshot(runId);
    expect(snap.codeCheck).toBe(true);
    // 指定時は build-verify を実施対象として pending のまま残す。
    expect(snap.steps.find((s) => s.step === "build-verify")?.status).toBe("pending");
  });

  it("resets the progress ledger on --force re-import so a new --code-check takes effect (no stale first-write-wins)", async () => {
    const store = await newStore();
    const from = await writeArticle("# T\n本文\n");
    const { runId } = await importArticle(store, { from, profile: "qiita" }); // codeCheck=false（既定オフ）
    expect((await new RunProgress(store).readSnapshot(runId)).codeCheck).toBe(false);

    // --force で再 import。今度は --code-check ありで、旧 codeCheck=false に引きずられないこと。
    await importArticle(store, { from, runId, profile: "qiita", codeCheck: true, force: true });
    const snap = await new RunProgress(store).readSnapshot(runId);
    expect(snap.codeCheck).toBe(true);
    expect(snap.steps.find((s) => s.step === "build-verify")?.status).toBe("pending");
    // 旧 import イベントが残っていないこと（import 工程は1件だけ）。
    const events = await new RunProgress(store).readEvents(runId);
    expect(events.filter((e) => e.step === "import").length).toBe(1);
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

  it("force replace removes stale editorial-review artifacts, the ledger, and round artifacts (incl. N>20)", async () => {
    const store = await newStore();
    const from = await writeArticle("# T\n本文\n");

    const { runId } = await importArticle(store, { from, profile: "qiita" });
    // 別本文向けの編集レビュー成果物・台帳・ラウンド成果物が残っている状況を再現
    await store.save(runId, "editorial-review.json", "{}");
    await store.save(runId, "editorial-review.md", "古い講評");
    await store.save(runId, "editorial-instruction.candidates.md", "古い候補");
    await store.save(runId, "editorial-instruction.md", "古い確定指示");
    await store.save(runId, "editorial-ledger.json", '{"round":21}');
    await store.save(runId, "editorial-r1-before.md", "r1");
    await store.save(runId, "editorial-r21-review.json", "{}"); // 20 を超えるラウンド
    await store.save(runId, "refine-r25-before.md", "old refine");

    await importArticle(store, { from, runId, profile: "qiita", force: true });
    for (const f of [
      "editorial-review.json",
      "editorial-review.md",
      "editorial-instruction.candidates.md",
      "editorial-instruction.md",
      "editorial-ledger.json",
      "editorial-r1-before.md",
      "editorial-r21-review.json",
      "refine-r25-before.md",
    ]) {
      await expect(store.read(runId, f)).rejects.toThrow();
    }
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
