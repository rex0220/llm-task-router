import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { recordPublication, type RecordPublicationOptions } from "../../src/cli/record-publication";
import { ExportIndex } from "../../src/storage/ExportIndex";
import { RunStore } from "../../src/storage/RunStore";

async function setup(): Promise<{ store: RunStore; index: ExportIndex; runId: string }> {
  const store = new RunStore(await mkdtemp(join(tmpdir(), "rp-runs-")));
  const index = new ExportIndex(join(await mkdtemp(join(tmpdir(), "rp-idx-")), "index.json"));
  const runId = "2026-06-19-article";
  await store.create(runId, "T", ["final"], "Qiita");
  await store.save(runId, "final.md", "# T\n本文\n");
  return { store, index, runId };
}

function opts(runId: string, over: Partial<RecordPublicationOptions> = {}): RecordPublicationOptions {
  return {
    runId,
    slug: "my-article",
    url: "https://qiita.com/u/items/abc123",
    articleId: "abc123",
    version: 1,
    ...over,
  };
}

describe("recordPublication", () => {
  it("updates meta.published and export/index.json together", async () => {
    const { store, index, runId } = await setup();
    const result = await recordPublication(store, index, opts(runId, { version: 2 }));

    expect(result.noop).toBe(false);
    const meta = await store.readMeta(runId);
    expect(meta.published).toMatchObject({ url: "https://qiita.com/u/items/abc123", articleId: "abc123", version: 2 });
    expect(meta.published?.updatedAt).toBeTruthy();

    const entry = await index.resolve("my-article");
    expect(entry).toMatchObject({ runId, version: 2 });
    // index と meta の updatedAt は同一
    expect(entry?.updatedAt).toBe(meta.published?.updatedAt);
  });

  it("rejects invalid url, version, and slug", async () => {
    const { store, index, runId } = await setup();
    await expect(recordPublication(store, index, opts(runId, { url: "ftp://x" }))).rejects.toThrow(/url/);
    await expect(recordPublication(store, index, opts(runId, { version: 0 }))).rejects.toThrow(/version/);
    await expect(recordPublication(store, index, opts(runId, { version: 1.5 }))).rejects.toThrow(/version/);
    await expect(recordPublication(store, index, opts(runId, { slug: "../escape" }))).rejects.toThrow(/slug/);
    await expect(recordPublication(store, index, opts(runId, { slug: "__proto__" }))).rejects.toThrow(/slug/);
  });

  it("is a no-op on identical re-run and does not change updatedAt", async () => {
    const { store, index, runId } = await setup();
    const first = await recordPublication(store, index, opts(runId, { version: 2 }));
    expect(first.noop).toBe(false);
    const t1 = (await store.readMeta(runId)).published?.updatedAt;

    const second = await recordPublication(store, index, opts(runId, { version: 2 }));
    expect(second.noop).toBe(true);
    expect((await store.readMeta(runId)).published?.updatedAt).toBe(t1);
    expect((await index.resolve("my-article"))?.updatedAt).toBe(t1);
  });

  it("rejects a version regression and a same-version content change without force", async () => {
    const { store, index, runId } = await setup();
    await recordPublication(store, index, opts(runId, { version: 2 }));

    // version 退行
    await expect(recordPublication(store, index, opts(runId, { version: 1 }))).rejects.toThrow(/version/);
    // 同 version だが URL が違う
    await expect(
      recordPublication(store, index, opts(runId, { version: 2, url: "https://qiita.com/u/items/other" }))
    ).rejects.toThrow(/version/);
  });

  it("allows a forced version regression", async () => {
    const { store, index, runId } = await setup();
    await recordPublication(store, index, opts(runId, { version: 2 }));
    const result = await recordPublication(store, index, opts(runId, { version: 1, force: true }));
    expect(result.noop).toBe(false);
    expect((await index.resolve("my-article"))?.version).toBe(1);
  });

  it("warns when the index points to a different run for the same slug", async () => {
    const { store, index, runId } = await setup();
    await recordPublication(store, index, opts(runId, { version: 2 }));

    // 台帳を別 run 指しに改竄（不整合状態を再現）。
    await index.write("my-article", {
      runId: "2026-01-01-other",
      url: "https://qiita.com/u/items/abc123",
      articleId: "abc123",
      version: 2,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const warnings: string[] = [];
    await recordPublication(store, index, opts(runId, { version: 3 }), (m) => warnings.push(m));
    expect(warnings.some((w) => /別 run \(2026-01-01-other\)/.test(w))).toBe(true);
    expect((await index.resolve("my-article"))?.runId).toBe(runId); // 上書きで修復
  });

  it("warns about a meta/index mismatch even when the version guard then rejects", async () => {
    const { store, index, runId } = await setup();
    await recordPublication(store, index, opts(runId, { version: 2 }));

    // 台帳だけ先に進める（meta v2 / index v5 の食い違い）。
    await index.write("my-article", {
      runId,
      url: "https://qiita.com/u/items/abc123",
      articleId: "abc123",
      version: 5,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const warnings: string[] = [];
    // version 2 を記録しようとすると退行 reject されるが、警告は先に出る。
    await expect(
      recordPublication(store, index, opts(runId, { version: 2 }), (m) => warnings.push(m))
    ).rejects.toThrow(/version/);
    expect(warnings.some((w) => /食い違って/.test(w))).toBe(true);
  });

  it("repairs a missing index entry by reusing meta.published.updatedAt after a failed write", async () => {
    const { store, index, runId } = await setup();

    // index 書き込みを1回だけ失敗させる（meta.published は書かれ、index は欠落する状況）。
    const spy = vi.spyOn(index, "write").mockRejectedValueOnce(new Error("disk full"));
    await expect(recordPublication(store, index, opts(runId, { version: 2 }))).rejects.toThrow(/disk full/);
    spy.mockRestore();

    const metaAfterFailure = await store.readMeta(runId);
    expect(metaAfterFailure.published?.version).toBe(2); // meta は進んだ
    expect(await index.resolve("my-article")).toBeUndefined(); // index は欠落

    // 同一引数で再実行 → 既存 updatedAt を再利用して index を修復、時刻はブレない。
    const repair = await recordPublication(store, index, opts(runId, { version: 2 }));
    expect(repair.noop).toBe(false);
    const entry = await index.resolve("my-article");
    expect(entry?.version).toBe(2);
    expect(entry?.updatedAt).toBe(metaAfterFailure.published?.updatedAt);
  });
});
