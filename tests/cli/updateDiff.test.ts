import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateUpdateDiff, writeUpdateDiff } from "../../src/cli/updateDiff";
import { RunStore } from "../../src/storage/RunStore";

describe("generateUpdateDiff", () => {
  it("returns no diff when base and final are identical", () => {
    const text = "# T\n\n## A\n本文\n";
    const result = generateUpdateDiff(text, text);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.diffText).toBe("");
    expect(result.changedSections).toHaveLength(0);
  });

  it("attributes a changed line to its nearest heading", () => {
    const base = "# T\n\n## 導入\n古い文\n\n## まとめ\n結び\n";
    const final = "# T\n\n## 導入\n新しい文\n\n## まとめ\n結び\n";
    const result = generateUpdateDiff(base, final);

    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    const intro = result.changedSections.find((s) => s.heading === "導入");
    expect(intro).toBeDefined();
    expect(intro?.added).toBe(1);
    expect(intro?.removed).toBe(1);
    // 変更の無いセクションは含まない
    expect(result.changedSections.some((s) => s.heading === "まとめ")).toBe(false);
    // diff テキストに +/- 行が出る
    expect(result.diffText).toMatch(/^-古い文$/m);
    expect(result.diffText).toMatch(/^\+新しい文$/m);
  });

  it("records a removed heading as its own changed section", () => {
    const base = "# T\n\n## 残る\nA\n\n## 消える\nB\n";
    const final = "# T\n\n## 残る\nA\n";
    const result = generateUpdateDiff(base, final);
    const removed = result.changedSections.find((s) => s.heading === "消える");
    expect(removed).toBeDefined();
    expect(removed?.removed).toBeGreaterThanOrEqual(1);
  });

  it("attributes a fully removed section's body to that section, not the previous one", () => {
    // 区切り空行を挟まず帰属の本質だけを見る（空行の帰属は LCS 依存で別問題）。
    const base = "## Keep\nA\n## Gone\nB\nC\n";
    const final = "## Keep\nA\n";
    const result = generateUpdateDiff(base, final);

    // Keep には変更が無い（削除本文が誤って寄らない）。
    expect(result.changedSections.find((s) => s.heading === "Keep")).toBeUndefined();
    // Gone に見出し＋本文（B, C）の3行ぶんが寄る。
    const gone = result.changedSections.find((s) => s.heading === "Gone");
    expect(gone?.removed).toBe(3);
    expect(gone?.added).toBe(0);
  });

  it("attributes changes before any heading to (前文)", () => {
    const base = "前置きA\n\n# T\n本文\n";
    const final = "前置きB\n\n# T\n本文\n";
    const result = generateUpdateDiff(base, final);
    const preface = result.changedSections.find((s) => s.heading === "(前文)");
    expect(preface).toBeDefined();
    expect(preface?.level).toBe(0);
  });
});

describe("writeUpdateDiff", () => {
  async function newStore(): Promise<RunStore> {
    return new RunStore(await mkdtemp(join(tmpdir(), "ud-runs-")));
  }

  it("writes update-diff.md and changed-sections.json", async () => {
    const store = await newStore();
    const runId = "2026-06-19-x";
    await store.create(runId, "T", ["final"], "Qiita");
    await store.save(runId, "update-base.md", "# T\n\n## A\n古い\n");
    await store.save(runId, "final.md", "# T\n\n## A\n新しい\n");

    const result = await writeUpdateDiff(store, runId);
    expect(result.added).toBe(1);

    const diffMd = await store.read(runId, "update-diff.md");
    expect(diffMd).toContain("```diff");
    expect(diffMd).toMatch(/\+新しい/);

    const sections = JSON.parse(await store.read(runId, "changed-sections.json")) as Array<{ heading: string }>;
    expect(sections.some((s) => s.heading === "A")).toBe(true);
  });

  it("fails when update-base.md is missing (non-import run)", async () => {
    const store = await newStore();
    const runId = "2026-06-19-y";
    await store.create(runId, "T", ["final"], "Qiita");
    await store.save(runId, "final.md", "# T\n本文\n");
    await expect(writeUpdateDiff(store, runId)).rejects.toThrow();
  });
});
