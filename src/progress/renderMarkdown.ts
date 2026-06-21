import type { ProgressSnapshot, ProgressStepStatus } from "./types";

const STATUS_LABEL: Record<ProgressStepStatus, string> = {
  done: "✅ done",
  skip: "⏭ skip",
  error: "❌ error",
  start: "🔄 進行中",
  pending: "・未着手",
};

// ProgressSnapshot → 表示用 Markdown（runs/<id>/progress.md）。
// 時刻はローカルタイム表示（正本の events / progress.json は UTC のまま）。
export function renderProgressMarkdown(snapshot: ProgressSnapshot): string {
  const lines: string[] = [];
  lines.push(`# 進捗: ${snapshot.runId}`);
  lines.push("");

  // 現在地の分母は canonical 工程数（非 canonical の追加工程で膨らませない）。
  const position = snapshot.complete
    ? "完了（全工程 done/skip）"
    : snapshot.currentIndex !== undefined
      ? `${snapshot.currentIndex} / ${snapshot.canonicalTotal} 工程目`
      : `${snapshot.canonicalTotal} 工程`;
  lines.push(`- 現在地: ${position}`);
  if (snapshot.totalCostUsd !== undefined) {
    lines.push(`- 概算コスト合計: ~$${snapshot.totalCostUsd.toFixed(4)}（概算 / 不明分は除外）`);
  }
  lines.push(`- 更新: ${fmtDateTime(snapshot.updatedAt)}`);
  if (snapshot.toolVersion !== undefined) {
    lines.push(`- 生成ツール: llm-task-router ${snapshot.toolVersion}`);
  }
  lines.push("");
  lines.push("> 時刻はローカルタイム表示（events / progress.json は UTC）。");
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

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// ローカルタイムの HH:MM:SS。UTC との取り違えを避けるため表示はローカルに寄せる
// （正本は UTC のまま。ランタイム TZ 依存なのでテストは TZ 固定で確認する）。
export function formatLocalTime(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

// ローカル日時 YYYY-MM-DD HH:MM:SS +HH:MM（UTC と区別できるようオフセットを併記）。
export function formatLocalDateTime(date: Date): string {
  const ymd = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  // getTimezoneOffset は「UTC より何分遅れているか」（UTC+9 なら -540）。表示は符号反転。
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const offset = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  return `${ymd} ${formatLocalTime(date)} ${offset}`;
}

// ISO(UTC) → ローカル HH:MM:SS（表の開始/終了用）。
function fmtTime(iso?: string): string {
  if (!iso) {
    return "";
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  return formatLocalTime(d);
}

// ISO(UTC) → ローカル日時（更新行用）。
function fmtDateTime(iso?: string): string {
  if (!iso) {
    return "";
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  return formatLocalDateTime(d);
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
