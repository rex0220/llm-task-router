import type { RunStore } from "../storage/RunStore";
import { RunProgress } from "../progress/RunProgress";
import type { ProgressEvent, ProgressStepStatus } from "../progress/types";
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
import { AUTO_BEGIN, AUTO_END, mergeMarkered, type MergeResult } from "./markerMerge";
import { collectUnsettledWeaknesses, type EditorialGateInput } from "../workflows/editorialReview";

// 完成報告（runs/<id>/completion-report.md）の生成。
// - 機械由来（ゲート結果・コスト・GO/NO-GO 転記）はコードが <!-- auto:begin/end --> 内に書く。
// - 構成/上申/総評は編集長が埋める editor 欄。再生成では auto 範囲だけ差し替え、editor 欄は保持する。
// - 公開台帳（export/index.json）には一切触れない。完成報告は runs/<id>/ に閉じる。

export const COMPLETION_REPORT_FILE = "completion-report.md";
export const COMPLETION_REPORT_BAK = "completion-report.bak.md";

export type GateInfo = { state: GateState; summary?: string };

export type CompletionReportData = {
  runId: string;
  title: string;
  profile?: string;
  finalAuthorModel?: string;
  reviewerModel?: string;
  progress: { complete: boolean; currentIndex?: number; canonicalTotal: number };
  toolVersion?: string;
  totalCostUsd?: number;
  goNoGo?: string;
  reason?: string;
  refine?: { stoppedReason?: string; finalScore?: number; finalApproved?: boolean };
  factcheck: GateInfo;
  buildVerify: GateInfo;
  // 構文/型チェックの実施対象か（作成時に固定）。false＝対象外（既定オフ）、true＝対象、undefined＝旧 run（未刻印）。
  codeCheckRequested?: boolean;
  editorial: GateInfo;
  // editorial-ledger の未確定（未解決 or 上申中）集計。GO/NO-GO 転記とは別軸の machine gate として表示する。
  editorialGate: EditorialGateInput;
  // verify-artifacts は publication-check に状態が出ない（exit code を読めない）ため、progress
  // snapshot の最新イベント由来で表示する。未実施なら status="pending"。
  verifyArtifacts: { status: ProgressStepStatus; note?: string };
  // export（公開相当）の実行状態。完成報告が export 前（GO/NO-GO レポート）に生成されたか、
  // export 後に再生成されたかを読み手が判別できるようにする。未実行なら null。
  exported: { status: ProgressStepStatus; output?: string; note?: string } | null;
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

// readEvents は at 昇順なので、該当 step の末尾要素が最新イベント（同時刻は append 順で安定）。
function lastEventOf(events: ProgressEvent[], step: string): ProgressEvent | undefined {
  let found: ProgressEvent | undefined;
  for (const e of events) {
    if (e.step === step) {
      found = e;
    }
  }
  return found;
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

  const progress = new RunProgress(store);
  const snapshot = await progress.readSnapshot(runId);
  // verify-artifacts / export は「最後のイベント」で表示する。snapshot の集約 status は done>error の
  // 優先度（リトライ成功向け）なので、done→error の最新失敗を隠す。完成報告の gate は現在地が重要なため
  // raw events から該当 step の末尾イベントを採る。
  const events = await progress.readEvents(runId);
  const verifyEvent = lastEventOf(events, "verify-artifacts");
  const exportEvent = lastEventOf(events, "export");

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
    progress: {
      complete: snapshot.complete,
      currentIndex: snapshot.currentIndex,
      canonicalTotal: snapshot.canonicalTotal,
    },
    toolVersion: snapshot.toolVersion,
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
    codeCheckRequested: snapshot.codeCheck,
    editorial: { state: gateState(pc, "editorial-review"), summary: parseGateSummary(pc, "editorial-review") },
    editorialGate: await collectUnsettledWeaknesses(store, runId),
    verifyArtifacts: { status: verifyEvent?.status ?? "pending", note: verifyEvent?.note },
    // export イベントが無ければ「未実行」として null（completion-report は既定で export 前に生成される）。
    exported: exportEvent
      ? { status: exportEvent.status, output: exportEvent.output, note: exportEvent.note }
      : null,
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

function stepStatusLabel(status: ProgressStepStatus): string {
  return status === "pending" ? "未実施" : status;
}

// export 行の表示。完成報告は既定で export 前（GO/NO-GO レポート）に生成されるため、未実行が通常。
// export 後に再生成すると done と出力先が出る（公開前/後を読み手が判別できる）。
function exportLabel(exported: CompletionReportData["exported"]): string {
  if (exported === null) {
    return "未実行（完成報告は公開前の GO/NO-GO レポート。export 後に再生成すると反映）";
  }
  if (exported.status === "done") {
    return joinParts(["done", exported.output, exported.note]);
  }
  return joinParts([stepStatusLabel(exported.status), exported.note]);
}

function joinParts(parts: (string | undefined)[]): string {
  return parts.filter((p) => p !== undefined && p !== "").join(" / ");
}

// editorial-ledger の未確定（未解決 or 上申中）を機械集計したゲート結果。
// publication-check 由来の GO/NO-GO は転記が正本のため、これは「別軸の machine gate」として併記する
// （GO を黙って NO-GO に上書きしない）。major/minor の未確定があれば BLOCK。
function editorialMachineGate(
  gate: EditorialGateInput,
  editorialState: GateState
): { ok: boolean; label: string; detail?: string } {
  if (!gate.hasLedger) {
    // editorial-review=done を宣言しているのに台帳が無いのは verify-artifacts と同じく BLOCK。
    // skip/未宣言の run は台帳なしが正常なので n/a。
    if (editorialState === "done") {
      return { ok: false, label: "BLOCK（editorial-ledger.json なし）" };
    }
    return { ok: true, label: "n/a（台帳なし）" };
  }
  const blocking = [...gate.major, ...gate.minor];
  const counts = joinParts([
    gate.major.length ? `major ${gate.major.length}` : undefined,
    gate.minor.length ? `minor ${gate.minor.length}` : undefined,
    gate.preference.length ? `preference ${gate.preference.length}` : undefined,
  ]);
  if (blocking.length > 0) {
    const ids = blocking.map((w) => `${w.id}(${w.severity}/${w.reason})`).join(", ");
    return { ok: false, label: `BLOCK（未確定 ${counts}）`, detail: ids };
  }
  if (gate.preference.length > 0) {
    return { ok: true, label: `OK（preference ${gate.preference.length} 件は warn）` };
  }
  return { ok: true, label: "OK（未確定 0）" };
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
      ? `${data.progress.currentIndex} / ${data.progress.canonicalTotal} 工程目`
      : `${data.progress.canonicalTotal} 工程`;

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
  // 構文/型チェックが既定オフ（作成時に非指定）のときは、publication-check の未宣言ではなく「対象外」と明示する。
  // ただし誰かが手動で build-verify を回し build-verify-report.json を残していれば、それは要約に出す。
  const buildVerifyOptedOut = data.codeCheckRequested === false && data.buildReport === null;
  const buildSummary = buildVerifyOptedOut
    ? "作成時にコードチェック非指定（既定オフ）"
    : joinParts([
        data.buildVerify.summary,
        data.buildReport
          ? `status ${data.buildReport.status} / checkedBlocks ${data.buildReport.checkedBlocks} / unverified ${data.buildReport.unverified}`
          : undefined,
      ]);
  const buildVerifyStateLabel = buildVerifyOptedOut ? "対象外" : gateStateLabel(data.buildVerify.state);
  const machineGate = editorialMachineGate(data.editorialGate, data.editorial.state);
  // 未確定があれば editorial 行にも併記（要 editorial-resolve を読み手に促す）。
  const editorialSummary = joinParts([
    data.editorial.summary,
    machineGate.ok ? undefined : `machine gate: ${machineGate.label} — 要 editorial-resolve`,
    data.reviewerModel,
  ]);
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
    // 生成ツール版は progress.md と同じく「あるときだけ」出す（既存 run は省略）。
    ...(data.toolVersion ? [`- 生成ツール: llm-task-router ${data.toolVersion}`] : []),
    `- 最終モデル: ${data.finalAuthorModel ?? "n/a"}`,
    `- 進捗: ${position}`,
    `- 概算コスト合計: ${cost}`,
    `- GO/NO-GO: ${data.goNoGo ?? "（publication-check 未記入）"}`,
    `- reason: ${data.reason ?? "（publication-check 未記入）"}`,
    // GO/NO-GO は publication-check 転記が正本。machine gate は editorial-ledger の機械集計を別軸で併記する
    // （両者が食い違う＝転記 GO だが未確定あり、のときに編集長へ publication-check 更新を促すため）。
    `- machine gate（editorial）: ${escapeCell(machineGate.label)}${
      machineGate.detail ? `（${escapeCell(machineGate.detail)}）` : ""
    }`,
    `- export: ${escapeCell(exportLabel(data.exported))}`,
    "",
    "## ゲート結果",
    "| ゲート | 状態 | 要約 |",
    "|---|---|---|",
    `| refine | ${escapeCell(data.refine?.stoppedReason ?? "n/a")} | ${escapeCell(refineSummary || "n/a")} |`,
    `| factcheck | ${gateStateLabel(data.factcheck.state)} | ${escapeCell(factcheckSummary || "n/a")} |`,
    `| build-verify | ${escapeCell(buildVerifyStateLabel)} | ${escapeCell(buildSummary || "n/a")} |`,
    `| editorial-review | ${gateStateLabel(data.editorial.state)} | ${escapeCell(editorialSummary || "n/a")} |`,
    `| claims-normalize | ${escapeCell(claimsState)} | ${escapeCell(claimsSummary)} |`,
    `| verify-artifacts | ${escapeCell(stepStatusLabel(data.verifyArtifacts.status))} | ${escapeCell(data.verifyArtifacts.note ?? "n/a")} |`,
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

// 再生成: auto 範囲だけを最新 data で差し替え、auto:end 以降（editor 欄）は既存を残す（共通実装）。
export function mergeCompletionReport(data: CompletionReportData, existing: string | null): MergeResult {
  return mergeMarkered(renderHead(data), renderCompletionReport(data), existing);
}
