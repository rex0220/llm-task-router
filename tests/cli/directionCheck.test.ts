import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectDirectionCheckData,
  directionGateStatus,
  extractOutline,
  mergeDirectionCheck,
  renderDirectionCheck,
  type DirectionCheckData,
} from "../../src/cli/directionCheck";
import { RunStore } from "../../src/storage/RunStore";

async function newStore(): Promise<RunStore> {
  return new RunStore(await mkdtemp(join(tmpdir(), "dc-runs-")));
}

const ARTICLE = [
  "# 記事タイトル",
  "導入の文。",
  "## 背景",
  "本文。",
  "```ts",
  "# これはコード内コメント（見出しに拾わない）",
  "## これもコード内",
  "```",
  "## 手順",
  "### 手順1",
  "### 手順2",
  "## まとめ",
  "",
].join("\n");

describe("directionGateStatus", () => {
  it("maps ok→done (gate passed) and revise→error (not passed, blocks factcheck)", () => {
    // revise を done にすると aggregate が完了扱いし status が factcheck へ進む＝stale gate。
    expect(directionGateStatus("ok")).toBe("done");
    expect(directionGateStatus("revise")).toBe("error");
  });
});

describe("extractOutline", () => {
  it("takes the H1 title and ##/### headings, ignoring fenced code", () => {
    const o = extractOutline(ARTICLE);
    expect(o.title).toBe("記事タイトル");
    expect(o.headings.map((h) => h.text)).toEqual(["背景", "手順", "手順1", "手順2", "まとめ"]);
    expect(o.headings.every((h) => h.level === 2 || h.level === 3)).toBe(true);
    expect(o.chars).toBeGreaterThan(0);
  });

  it("returns no headings for a flat document", () => {
    expect(extractOutline("# T\n本文だけ\n").headings).toEqual([]);
  });
});

describe("collectDirectionCheckData", () => {
  it("reads final.md by default and carries topic/profile and verdict", async () => {
    const store = await newStore();
    const runId = "2026-06-21-dc";
    await store.create(runId, "テーマX", ["create"], "Qiita", undefined, "qiita");
    await store.save(runId, "final.md", ARTICLE);
    const data = await collectDirectionCheckData(store, runId, "final", "ok", undefined);
    expect(data.source).toBe("final");
    expect(data.title).toBe("記事タイトル");
    expect(data.topic).toBe("テーマX");
    expect(data.profile).toBe("qiita");
    expect(data.verdict).toBe("ok");
  });

  it("reads draft.md when source=draft", async () => {
    const store = await newStore();
    const runId = "2026-06-21-dcd";
    await store.create(runId, "T", ["create"]);
    await store.save(runId, "draft.md", "# ドラフト\n## 節\n");
    const data = await collectDirectionCheckData(store, runId, "draft", "revise", "節を増やす");
    expect(data.title).toBe("ドラフト");
    expect(data.note).toBe("節を増やす");
  });

  it("errors clearly when the target md is missing", async () => {
    const store = await newStore();
    const runId = "2026-06-21-dcmiss";
    await store.create(runId, "T", ["create"]);
    // final.md なし
    await expect(collectDirectionCheckData(store, runId, "final", "ok", undefined)).rejects.toThrow(/final\.md/);
  });
});

function makeData(over: Partial<DirectionCheckData> = {}): DirectionCheckData {
  return {
    runId: "r",
    source: "final",
    title: "タイトル",
    headings: [
      { level: 2, text: "背景" },
      { level: 3, text: "詳細" },
    ],
    chars: 1234,
    verdict: "ok",
    ...over,
  };
}

describe("renderDirectionCheck", () => {
  it("puts verdict/outline in the auto block and 所感 in the editor block", () => {
    const md = renderDirectionCheck(makeData({ verdict: "revise", note: "導入が長い" }));
    expect(md).toContain("<!-- auto:begin -->");
    expect(md).toContain("- verdict: revise");
    expect(md).toContain("- 指示: 導入が長い");
    expect(md).toContain("## アウトライン");
    expect(md).toContain("- ## 背景");
    expect(md).toContain("  - ### 詳細");
    expect(md).toContain("## 所感（編集長）");
    expect(md).toContain("<!-- editor:");
  });
});

describe("mergeDirectionCheck (marker protection)", () => {
  it("refreshes verdict/outline (auto) but keeps the 所感 editor section", () => {
    const initial = renderDirectionCheck(makeData({ verdict: "revise" }));
    const edited = initial.replace(
      "<!-- editor: 方向性の所感・OK の理由・気になる点をここに。verdict は上の auto 欄（--verdict）が権威 -->",
      "構成は良い。導入だけ詰める。"
    );
    const { content, recovered } = mergeDirectionCheck(makeData({ verdict: "ok" }), edited);
    expect(recovered).toBe(false);
    expect(content).toContain("構成は良い。導入だけ詰める。"); // 所感は残る
    expect(content).toContain("- verdict: ok"); // verdict は最新
    expect(content).not.toContain("- verdict: revise");
  });

  it("flags recovered on malformed markers", () => {
    expect(mergeDirectionCheck(makeData(), "手書きでマーカーなし\n").recovered).toBe(true);
  });
});
