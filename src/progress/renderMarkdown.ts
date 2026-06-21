import type { ProgressSnapshot, ProgressStepStatus } from "./types";
import { formatDuration } from "../utils/duration";

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
  // トークン合計（LLM 工程のみ。料金とは別に「使用量」を把握できるように出す。不明分は除外）。
  if (snapshot.totalInputTokens !== undefined || snapshot.totalOutputTokens !== undefined) {
    const inTok = snapshot.totalInputTokens ?? 0;
    const outTok = snapshot.totalOutputTokens ?? 0;
    lines.push(
      `- トークン合計: 入力 ${fmtTokens(inTok)} / 出力 ${fmtTokens(outTok)}（合計 ${fmtTokens(inTok + outTok)} / LLM工程のみ）`
    );
  }
  lines.push(`- 更新: ${fmtDateTime(snapshot.updatedAt)}`);
  if (snapshot.editorModel !== undefined) {
    // 自己申告値（自動検出ではなく作成時に編集長が宣言）。監査値ではない旨を表記で明示する。
    lines.push(`- 編集長（AIモデル・自己申告）: ${snapshot.editorModel}`);
  }
  if (snapshot.toolVersion !== undefined) {
    lines.push(`- 生成ツール: llm-task-router ${snapshot.toolVersion}`);
  }
  lines.push("");
  lines.push("> 時刻はローカルタイム表示（events / progress.json は UTC）。");
  lines.push("");

  // トークン列はトークンを記録した工程が1つでもあるときだけ出す（未記録の旧 run は従来の列構成を保つ）。
  const showTokens = snapshot.totalInputTokens !== undefined || snapshot.totalOutputTokens !== undefined;
  const head = ["#", "工程", "状態", "開始", "終了", "所要", "概算$", ...(showTokens ? ["トークン(in/out)"] : []), "根拠/補足"];
  lines.push(`| ${head.join(" | ")} |`);
  lines.push(`|${head.map(() => "---").join("|")}|`);
  const firstExtra = snapshot.steps.find((s) => !s.canonical);
  let dividerEmitted = false;
  for (const s of snapshot.steps) {
    // canonical 工程と「工程外の追加アクション」の境目に区切り行を1本入れる（A）。列数は head に追従。
    if (!s.canonical && !dividerEmitted) {
      const cells = head.map((_, i) => (i === 1 ? "**— 追加アクション（工程外・実行時刻順）—**" : ""));
      lines.push(`| ${cells.join(" | ")} |`);
      dividerEmitted = true;
    }
    const elapsed = s.elapsedMs !== undefined ? formatDuration(s.elapsedMs) : "";
    const cost = s.costUsd !== undefined ? `~$${s.costUsd.toFixed(4)}` : "";
    const tokens =
      s.inputTokens !== undefined || s.outputTokens !== undefined
        ? `${fmtTokens(s.inputTokens ?? 0)}/${fmtTokens(s.outputTokens ?? 0)}`
        : "";
    const note = [s.output, s.note].filter((v) => v !== undefined && v !== "").join(" / ");
    const cells = [
      String(s.index),
      s.label,
      STATUS_LABEL[s.status],
      fmtTime(s.startedAt),
      fmtTime(s.finishedAt),
      elapsed,
      cost,
      ...(showTokens ? [tokens] : []),
      escapeCell(note),
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("");
  // 追加アクションがあるときだけ注記（C）。表の位置＝工程順で、実行時刻順ではない旨。
  if (firstExtra) {
    lines.push(
      `> ※ #${firstExtra.index} 以降は工程ではない追加アクション（revise 等は複数工程に跨るため末尾にまとめています）。表の位置は工程順で、実行時刻順ではありません。`
    );
    lines.push("");
  }
  return lines.join("\n");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// トークン数を桁区切りで表示（ランタイム locale 非依存に固定）。
function fmtTokens(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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
