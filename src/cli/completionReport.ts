import type { RunStore } from "../storage/RunStore";
import { RunProgress } from "../progress/RunProgress";
import { BuildVerifyReportSchema, ClaimsSchema, SourcesSchema } from "../schemas/ClaimsSchema";
import { CLAIMS_FILE, SOURCES_FILE, isBlocking } from "./claimsNormalize";
import { firstH1 } from "./export";
import {
  gateState,
  parseGateSummary,
  parseGoNoGo,
  parseReason,
  type GateState,
} from "./publicationCheck";

// 完成報告（runs/<id>/completion-report.md）の生成。
// - 機械由来（ゲート結果・コスト・GO/NO-GO 転記）はコードが <!-- auto:begin/end --> 内に書く。
// - 構成/上申/総評は編集長が埋める editor 欄。再生成では auto 範囲だけ差し替え、editor 欄は保持する。
// - 公開台帳（export/index.json）には一切触れない。完成報告は runs/<id>/ に閉じる。

export const COMPLETION_REPORT_FILE = "completion-report.md";
export const COMPLETION_REPORT_BAK = "completion-report.bak.md";

const AUTO_BEGIN = "<!-- auto:begin -->";
const AUTO_END = "<!-- auto:end -->";

export type GateInfo = { state: GateState; summary?: string };

export type CompletionReportData = {
  runId: string;
  title: string;
  profile?: string;
  finalAuthorModel?: string;
  reviewerModel?: string;
  progress: { complete: boolean; currentIndex?: number; total: number };
  totalCostUsd?: number;
  goNoGo?: string;
  reason?: string;
  refine?: { stoppedReason?: string; finalScore?: number; finalApproved?: boolean };
  factcheck: GateInfo;
  buildVerify: GateInfo;
  editorial: GateInfo;
  // claims.json があれば件数、無ければ null（factcheck=done なら verify-artifacts が別途弾く）。
  claims: { total: number; sources: number; blocking: number } | null;
  // build-verify-report.json があれば status と件数、無ければ null。
  buildReport: { status: string; checkedBlocks: number; unverified: number } | null;
};

async function readOrNull(store: RunStore, runId: string, file: string): Promise<string | null> {
  return store.read(runId, file).then(
    (c) => c,
    () => null
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function modelLabel(model: { provider: string; model: string } | "external" | undefined): string | undefined {
  if (model === undefined) {
    return undefined;
  }
  return model === "external" ? "external" : `${model.provider}/${model.model}`;
}

// run の各成果物を読み、完成報告データに集約する（収集と整形を分離）。
// publication-check.md は必須（無ければ呼び出し側が先に弾く）。それ以外の欠損は "未実施/なし" として扱う。
export async function collectCompletionReportData(
  store: RunStore,
  runId: string,
  publicationCheck: string
): Promise<CompletionReportData> {
  const meta = await store.readMeta(runId).catch(() => undefined);
  const finalMd = await readOrNull(store, runId, "final.md");
  const title =
    (finalMd ? firstH1(finalMd) : undefined) ?? meta?.articleTitle?.trim() ?? runId;

  const snapshot = await new RunProgress(store).readSnapshot(runId);

  const claimsRaw = await readOrNull(store, runId, CLAIMS_FILE);
  let claims: CompletionReportData["claims"] = null;
  if (claimsRaw !== null) {
    const parsed = ClaimsSchema.safeParse(safeJson(claimsRaw));
    if (parsed.success) {
      const sourcesRaw = await readOrNull(store, runId, SOURCES_FILE);
      const sources = sourcesRaw !== null ? SourcesSchema.safeParse(safeJson(sourcesRaw)) : undefined;
      claims = {
        total: parsed.data.length,
        sources: sources?.success ? sources.data.length : 0,
        blocking: parsed.data.filter(isBlocking).length,
      };
    }
  }

  const reportRaw = await readOrNull(store, runId, "build-verify-report.json");
  let buildReport: CompletionReportData["buildReport"] = null;
  if (reportRaw !== null) {
    const parsed = BuildVerifyReportSchema.safeParse(safeJson(reportRaw));
    if (parsed.success) {
      buildReport = {
        status: parsed.data.status,
        checkedBlocks: parsed.data.checkedBlocks.length,
        unverified: parsed.data.unverified.length,
      };
    }
  }

  const pc = publicationCheck;
  return {
    runId,
    title,
    profile: meta?.profile,
    finalAuthorModel: modelLabel(meta?.finalAuthorModel),
    reviewerModel: modelLabel(meta?.reviewerModel),
    progress: { complete: snapshot.complete, currentIndex: snapshot.currentIndex, total: snapshot.total },
    totalCostUsd: snapshot.totalCostUsd,
    goNoGo: parseGoNoGo(pc),
    reason: parseReason(pc),
    refine: meta?.refine
      ? {
          stoppedReason: meta.refine.stoppedReason,
          finalScore: meta.refine.finalScore,
          finalApproved: meta.refine.finalApproved,
        }
      : undefined,
    factcheck: { state: gateState(pc, "factcheck"), summary: parseGateSummary(pc, "factcheck") },
    buildVerify: { state: gateState(pc, "build-verify"), summary: parseGateSummary(pc, "build-verify") },
    editorial: { state: gateState(pc, "editorial-review"), summary: parseGateSummary(pc, "editorial-review") },
    claims,
    buildReport,
  };
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function gateStateLabel(state: GateState): string {
  return state === "missing" ? "未宣言" : state;
}

function joinParts(parts: (string | undefined)[]): string {
  return parts.filter((p) => p !== undefined && p !== "").join(" / ");
}

// 機械由来セクション（<!-- auto:begin/end --> を含む見出し直下のヘッダ＋ゲート表）。
function renderAutoSection(data: CompletionReportData): string {
  const cost =
    data.totalCostUsd !== undefined
      ? `~$${data.totalCostUsd.toFixed(4)}（概算 / 価格表依存 / 不明分は除外）`
      : "n/a";
  const position = data.progress.complete
    ? "全工程完了"
    : data.progress.currentIndex !== undefined
      ? `${data.progress.currentIndex} / ${data.progress.total} 工程目`
      : `${data.progress.total} 工程`;

  const refineSummary = data.refine
    ? joinParts([
        data.refine.stoppedReason,
        data.refine.finalScore !== undefined ? `score ${data.refine.finalScore}` : undefined,
        data.refine.finalApproved !== undefined ? `approved ${data.refine.finalApproved}` : undefined,
      ])
    : "";
  const factcheckSummary = joinParts([
    data.factcheck.summary,
    data.claims ? `claims ${data.claims.total} / sources ${data.claims.sources} / blocking ${data.claims.blocking}` : undefined,
  ]);
  const buildSummary = joinParts([
    data.buildVerify.summary,
    data.buildReport
      ? `status ${data.buildReport.status} / checkedBlocks ${data.buildReport.checkedBlocks} / unverified ${data.buildReport.unverified}`
      : undefined,
  ]);
  const editorialSummary = joinParts([data.editorial.summary, data.reviewerModel]);
  const claimsState = data.claims ? `claims.json あり` : `claims.json なし`;
  const claimsSummary = data.claims
    ? `claims ${data.claims.total} / sources ${data.claims.sources} / blocking ${data.claims.blocking}`
    : "n/a";

  return [
    AUTO_BEGIN,
    "<!-- ここは自動生成です。再生成で上書きされます（手で編集しない）。編集は下の各セクションへ。 -->",
    "",
    `- 記事: ${escapeCell(data.title)}`,
    "- ファイル: final.md",
    `- profile: ${data.profile ?? "n/a"}`,
    `- 最終モデル: ${data.finalAuthorModel ?? "n/a"}`,
    `- 進捗: ${position}`,
    `- 概算コスト合計: ${cost}`,
    `- GO/NO-GO: ${data.goNoGo ?? "（publication-check 未記入）"}`,
    `- reason: ${data.reason ?? "（publication-check 未記入）"}`,
    "",
    "## ゲート結果",
    "| ゲート | 状態 | 要約 |",
    "|---|---|---|",
    `| refine | ${escapeCell(data.refine?.stoppedReason ?? "n/a")} | ${escapeCell(refineSummary || "n/a")} |`,
    `| factcheck | ${gateStateLabel(data.factcheck.state)} | ${escapeCell(factcheckSummary || "n/a")} |`,
    `| build-verify | ${gateStateLabel(data.buildVerify.state)} | ${escapeCell(buildSummary || "n/a")} |`,
    `| editorial-review | ${gateStateLabel(data.editorial.state)} | ${escapeCell(editorialSummary || "n/a")} |`,
    `| claims-normalize | ${escapeCell(claimsState)} | ${escapeCell(claimsSummary)} |`,
    `| verify-artifacts | publication-check では判定不可 | exit code を別途確認（推奨） |`,
    AUTO_END,
  ].join("\n");
}

// タイトル行＋auto セクション（再生成で差し替える「head」部分）。AUTO_END で終わる。
function renderHead(data: CompletionReportData): string {
  return `# 完成報告: ${data.runId}\n\n${renderAutoSection(data)}`;
}

// 編集長が埋める既定テンプレ（auto:end より後ろ。初回生成・reset 時に使う）。
function renderEditorTemplate(): string {
  return [
    "",
    "## 構成",
    "<!-- editor: 記事の構成ナラティブ（導入→…→まとめ）。編集長が記入 -->",
    "",
    "## 上申事項（ユーザー判断を要する論点）",
    "<!-- editor: 企画方針との衝突・preference・大改変など。無ければ「なし」 -->",
    "",
    "## 総評",
    "<!-- editor: 補足総評 -->",
    "",
  ].join("\n");
}

// 完成報告の全文（初回生成 / reset 用）。head ＋ 既定 editor テンプレ。
export function renderCompletionReport(data: CompletionReportData): string {
  return `${renderHead(data)}\n${renderEditorTemplate()}`;
}

export type MergeResult = { content: string; recovered: boolean };

// 再生成: auto 範囲だけを最新 data で差し替え、auto:end 以降（editor 欄）は既存をそのまま残す。
// 既存にマーカーが無い/壊れている場合は recovered=true を返す（呼び出し側で bak を残してから書く）。
export function mergeCompletionReport(data: CompletionReportData, existing: string | null): MergeResult {
  if (existing === null) {
    return { content: renderCompletionReport(data), recovered: false };
  }
  const endIdx = existing.indexOf(AUTO_END);
  if (endIdx < 0) {
    // マーカー破損: 安全側に倒して全面再生成（呼び出し側で bak 退避）。
    return { content: renderCompletionReport(data), recovered: true };
  }
  const editorTail = existing.slice(endIdx + AUTO_END.length);
  return { content: `${renderHead(data)}${editorTail}`, recovered: false };
}
