import type { ProgressSnapshot, ProgressStepStatus } from "./types";

const STATUS_LABEL: Record<ProgressStepStatus, string> = {
  done: "✅ done",
  skip: "⏭ skip",
  error: "❌ error",
  start: "🔄 進行中",
  pending: "・未着手",
};

// ProgressSnapshot → 表示用 Markdown（runs/<id>/progress.md）。
export function renderProgressMarkdown(snapshot: ProgressSnapshot): string {
  const lines: string[] = [];
  lines.push(`# 進捗: ${snapshot.runId}`);
  lines.push("");

  const position = snapshot.complete
    ? "完了（全工程 done/skip）"
    : snapshot.currentIndex !== undefined
      ? `${snapshot.currentIndex} / ${snapshot.total} 工程目`
      : `${snapshot.total} 工程`;
  lines.push(`- 現在地: ${position}`);
  if (snapshot.totalCostUsd !== undefined) {
    lines.push(`- 概算コスト合計: ~$${snapshot.totalCostUsd.toFixed(4)}（概算 / 不明分は除外）`);
  }
  lines.push(`- 更新: ${snapshot.updatedAt}`);
  lines.push("");

  lines.push("| # | 工程 | 状態 | 開始 | 終了 | 所要 | 概算$ | 根拠/補足 |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const s of snapshot.steps) {
    const elapsed = s.elapsedMs !== undefined ? `${s.elapsedMs}ms` : "";
    const cost = s.costUsd !== undefined ? `~$${s.costUsd.toFixed(4)}` : "";
    const note = [s.output, s.note].filter((v) => v !== undefined && v !== "").join(" / ");
    lines.push(
      `| ${s.index} | ${s.label} | ${STATUS_LABEL[s.status]} | ${fmtTime(s.startedAt)} | ${fmtTime(s.finishedAt)} | ${elapsed} | ${cost} | ${escapeCell(note)} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ISO → HH:MM:SS（表示用。日付は更新時刻に集約し、表は時刻だけで詰める）。
function fmtTime(iso?: string): string {
  if (!iso) {
    return "";
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  return d.toISOString().slice(11, 19);
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
