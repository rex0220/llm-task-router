import type { RunStore } from "../storage/RunStore";
import { firstH1 } from "./export";
import { AUTO_BEGIN, AUTO_END, mergeMarkered, type MergeResult } from "./markerMerge";

// 方向性ゲート（runs/<id>/direction-check.md）の生成。
// - factcheck/build など高コスト工程の前に、編集長が方向性 OK/要修正 を判定する軽量ゲート。
// - アウトライン・分量 ＋ verdict/指示（CLI 駆動）＝ auto ブロック、所感＝編集長の editor 欄。
// - 正確性ゲートではない（事実=factcheck・品質=refine/editorial）。runs/<id>/ に閉じる。

export const DIRECTION_CHECK_FILE = "direction-check.md";
export const DIRECTION_CHECK_BAK = "direction-check.bak.md";

export type Verdict = "ok" | "revise";
export type DirectionSource = "final" | "draft";
export type Heading = { level: number; text: string };

export type DirectionCheckData = {
  runId: string;
  source: DirectionSource;
  title?: string;
  headings: Heading[];
  chars: number;
  verdict: Verdict;
  note?: string;
  profile?: string;
  topic?: string;
};

// canonical `direction` の進捗状態: ok=done（通過）、revise=error（未通過）。
// error にするのは、aggregate が done を完了扱いにするため。revise を done で記録すると status が
// factcheck へ進み、その後 final を revise しても direction=done が残って stale gate になる。
// error なら currentIndex は direction に留まり、再判定 ok（done）が error を上書きする（retry 成功）。
export function directionGateStatus(verdict: Verdict): "done" | "error" {
  return verdict === "ok" ? "done" : "error";
}

// 本文から見出しアウトラインと分量を抽出する。コードフェンス内の "#" は見出しに拾わない。
export function extractOutline(markdown: string): { title?: string; headings: Heading[]; chars: number } {
  const title = firstH1(markdown);
  const headings: Heading[] = [];
  let inFence = false;
  let fenceMarker = "";
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const fence = /^(```+|~~~+)/.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0]; // ` か ~
      } else if (line.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (inFence) {
      continue;
    }
    // ## / ### のみ拾う（# はタイトル、#### 以下は粒度が細かすぎるので除外）。
    const m = /^(#{2,3})\s+(\S.*)$/.exec(line);
    if (m) {
      headings.push({ level: m[1].length, text: m[2].trim() });
    }
  }
  return { title, headings, chars: markdown.trim().length };
}

// run の成果物を読み、方向性ゲートデータに集約する。対象 md 不在は明確にエラー（source 取り違え検出）。
export async function collectDirectionCheckData(
  store: RunStore,
  runId: string,
  source: DirectionSource,
  verdict: Verdict,
  note?: string
): Promise<DirectionCheckData> {
  const meta = await store.readMeta(runId).catch(() => undefined);
  const file = source === "draft" ? "draft.md" : "final.md";
  const markdown = await store.read(runId, file).catch(() => null);
  if (markdown === null) {
    throw new Error(
      `${file} がありません（runs/${runId}/）。--source ${source} の対象が未生成です。source を確認してください。`
    );
  }
  const { title, headings, chars } = extractOutline(markdown);
  return { runId, source, title, headings, chars, verdict, note, profile: meta?.profile, topic: meta?.topic };
}

// 単一行フィールド用に改行を畳む（auto ブロックの行を壊さない）。
function inline(text: string): string {
  return text.replace(/\r?\n/g, " ").trim();
}

function renderOutline(headings: Heading[]): string[] {
  if (headings.length === 0) {
    return ["- （見出しなし）"];
  }
  return headings.map((h) => `${h.level === 3 ? "  - " : "- "}${"#".repeat(h.level)} ${inline(h.text)}`);
}

function renderAutoSection(data: DirectionCheckData): string {
  const file = data.source === "draft" ? "draft.md" : "final.md";
  return [
    AUTO_BEGIN,
    "<!-- 自動生成。再生成で上書きされます（verdict/指示は --verdict/--note が権威）。所感は下の編集欄へ。 -->",
    "",
    `- 対象: ${file}`,
    `- テーマ: ${data.topic ? inline(data.topic) : "n/a"}`,
    `- profile: ${data.profile ?? "n/a"}`,
    `- タイトル: ${data.title ? inline(data.title) : "n/a"}`,
    `- 分量: 約 ${data.chars} 文字 / 見出し ${data.headings.length} 本`,
    `- verdict: ${data.verdict}`,
    `- 指示: ${data.note ? inline(data.note) : data.verdict === "revise" ? "（--note 未指定）" : "n/a"}`,
    "",
    "## アウトライン",
    ...renderOutline(data.headings),
    AUTO_END,
  ].join("\n");
}

// タイトル行 ＋ auto ブロック（AUTO_END で終わる、再生成で差し替える head）。
function renderHead(data: DirectionCheckData): string {
  return `# 方向性ゲート: ${data.runId}\n\n${renderAutoSection(data)}`;
}

// 編集長が埋める所感欄（auto:end より後ろ。初回生成・reset で使う）。
function renderEditorTemplate(): string {
  return [
    "",
    "## 所感（編集長）",
    "<!-- editor: 方向性の所感・OK の理由・気になる点をここに。verdict は上の auto 欄（--verdict）が権威 -->",
    "",
  ].join("\n");
}

// 全文（初回生成 / reset 用）。
export function renderDirectionCheck(data: DirectionCheckData): string {
  return `${renderHead(data)}\n${renderEditorTemplate()}`;
}

// 再生成: auto（アウトライン＋verdict）だけ最新化し、所感（editor）は残す（共通実装）。
export function mergeDirectionCheck(data: DirectionCheckData, existing: string | null): MergeResult {
  return mergeMarkered(renderHead(data), renderDirectionCheck(data), existing);
}
