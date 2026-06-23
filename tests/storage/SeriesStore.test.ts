import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SeriesStore, voiceHash } from "../../src/storage/SeriesStore";

function tmpSeriesRoot(): string {
  return mkdtempSync(join(tmpdir(), "ltr-series-"));
}

describe("voiceHash", () => {
  it("is deterministic and ignores a missing trailing newline (matches save normalization)", () => {
    expect(voiceHash("abc")).toBe(voiceHash("abc\n"));
    expect(voiceHash("abc")).toBe(voiceHash("abc"));
  });
  it("differs for different content", () => {
    expect(voiceHash("abc")).not.toBe(voiceHash("abcd"));
  });
});

describe("SeriesStore.init", () => {
  it("creates series.json (unfrozen) and an empty voice.md", async () => {
    const store = new SeriesStore(tmpSeriesRoot());
    const data = await store.init("kagaku", "qiita");
    expect(data.voice.frozen).toBe(false);
    expect(data.voice.version).toBe(0);
    expect(await store.exists("kagaku")).toBe(true);
    expect(await store.readVoice("kagaku")).toBe("");
  });

  it("refuses to recreate an existing series", async () => {
    const store = new SeriesStore(tmpSeriesRoot());
    await store.init("kagaku", "qiita");
    await expect(store.init("kagaku", "qiita")).rejects.toThrow(/already exists/);
  });

  it("rejects an unsafe slug", async () => {
    const store = new SeriesStore(tmpSeriesRoot());
    await expect(store.init("../escape", "qiita")).rejects.toThrow(/Invalid/);
  });
});

describe("SeriesStore.freezeVoice", () => {
  it("freezes the initial voice as version 1", async () => {
    const store = new SeriesStore(tmpSeriesRoot());
    await store.init("kagaku", "qiita");
    const data = await store.freezeVoice("kagaku", "calm, precise tone");
    expect(data.voice.frozen).toBe(true);
    expect(data.voice.version).toBe(1);
    expect(data.voice.hash).toBe(voiceHash("calm, precise tone"));
    expect(data.voice.history).toEqual([{ version: 1, hash: data.voice.hash, file: "voice.md" }]);
  });

  it("re-freezes with retention order: old voice moved to voice-v1.md, version bumps to 2", async () => {
    const root = tmpSeriesRoot();
    const store = new SeriesStore(root);
    await store.init("kagaku", "qiita");
    await store.freezeVoice("kagaku", "v1 tone");
    const data = await store.freezeVoice("kagaku", "v2 tone");

    expect(data.voice.version).toBe(2);
    expect(data.voice.hash).toBe(voiceHash("v2 tone"));
    // 退避ファイルに旧版が保全されている。
    expect(readFileSync(join(store.seriesPath("kagaku"), "voice-v1.md"), "utf8")).toBe("v1 tone\n");
    // 現行 voice.md は新版。
    expect(await store.readVoice("kagaku")).toBe("v2 tone\n");
    // history は旧版を退避先に付け替え、新版を末尾に積む。
    expect(data.voice.history).toEqual([
      { version: 1, hash: voiceHash("v1 tone"), file: "voice-v1.md" },
      { version: 2, hash: voiceHash("v2 tone"), file: "voice.md" },
    ]);
  });

  it("refuses a no-op re-freeze with identical content", async () => {
    const store = new SeriesStore(tmpSeriesRoot());
    await store.init("kagaku", "qiita");
    await store.freezeVoice("kagaku", "same");
    await expect(store.freezeVoice("kagaku", "same")).rejects.toThrow(/identical/);
  });

  it("throws when the series is not initialized", async () => {
    const store = new SeriesStore(tmpSeriesRoot());
    await expect(store.freezeVoice("ghost", "x")).rejects.toThrow(/not initialized/);
  });

  it("reads back a frozen series and validates the history tail", async () => {
    const root = tmpSeriesRoot();
    const store = new SeriesStore(root);
    await store.init("kagaku", "qiita");
    await store.freezeVoice("kagaku", "v1");
    const reread = await store.read("kagaku");
    expect(reread?.voice.version).toBe(1);
  });
});
