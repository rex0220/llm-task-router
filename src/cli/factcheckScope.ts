import { createHash } from "node:crypto";
import type { RunStore } from "../storage/RunStore";
import { ClaimsSchema, type Claim } from "../schemas/ClaimsSchema";
import { generateUpdateDiff, type ChangedSection } from "./updateDiff";
import {
  normalizeHeading,
  selectDiscoverySections,
  selectRecheckClaims,
  type RecheckCandidate,
} from "./claimsRecheck";
import { CLAIMS_FILE } from "./claimsNormalize";

// 優先度4: 再 factcheck の二度手間を避ける。前回 factcheck baseline（factcheck.snapshot.md）と
// 現 final.md の差分で「再検証が要るか・どこを見るか」を判定する。
// - 差分計算は generateUpdateDiff（heading 単位 changed sections）を再利用（全文ハッシュ単独は使わない）。
// - 影響 claim / 新規抽出セクションは claims-recheck の関数を流用。
// - baseline 受理（stamp）は信頼状態を変えるので CLI 側で強くガードする（必須フラグ＋プロンプト維持）。

export const FACTCHECK_SNAPSHOT_FILE = "factcheck.snapshot.md";
export const FACTCHECK_SNAPSHOT_META_FILE = "factcheck.snapshot.meta.json";
export const FACTCHECK_SCOPE_FILE = "factcheck-scope.md";
export const FACTCHECK_SCOPE_JSON = "factcheck-scope.json";

export type AcceptedAfter = "factcheck" | "non-factual-diff";

export type SnapshotMeta = {
  runId: string;
  acceptedAfter: AcceptedAfter;
  note: string;
  at: string; // ISO8601
  finalHash: string; // sha256(final.md)
};

export type FactcheckScope =
  | { mode: "full" }
  | { mode: "skip" }
  | {
      mode: "diff";
      changedSections: ChangedSection[];
      recheckClaims: RecheckCandidate[];
      discoverySections: string[];
      lowRiskSections: ChangedSection[];
      claimsAvailable: boolean;
      claimsSourceRunId?: string; // claims を current 以外（lineage の前版）から読んだ場合にその runId
    };

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function readOrNull(store: RunStore, runId: string, file: string): Promise<string | null> {
  return store.read(runId, file).then(
    (c) => c,
    () => null
  );
}

// baseline スナップショットを読む（無ければ null＝初回判定）。
export async function readSnapshot(store: RunStore, runId: string): Promise<string | null> {
  return readOrNull(store, runId, FACTCHECK_SNAPSHOT_FILE);
}

// 現 final.md を factcheck baseline として受理する（受理メタつき）。
// acceptedAfter/note は呼び出し側（CLI）で必須化する。final.md 不在はエラー。
export async function stampSnapshot(
  store: RunStore,
  runId: string,
  acceptedAfter: AcceptedAfter,
  note: string
): Promise<SnapshotMeta> {
  const final = await store.read(runId, "final.md"); // 無ければここで失敗
  await store.save(runId, FACTCHECK_SNAPSHOT_FILE, final);
  const meta: SnapshotMeta = {
    runId,
    acceptedAfter,
    note,
    at: new Date().toISOString(),
    finalHash: sha256(final),
  };
  await store.save(runId, FACTCHECK_SNAPSHOT_META_FILE, JSON.stringify(meta, null, 2));
  return meta;
}

// 1 run の claims.json を読む。**不在は null（許容）／存在するが JSON・schema 不正は throw**。
// 破損 artifact を「claims なし」に畳んで見落とさないため（不在と破損を区別する）。
async function readClaimsStrict(store: RunStore, runId: string): Promise<Claim[] | null> {
  const raw = await readOrNull(store, runId, CLAIMS_FILE);
  if (raw === null) {
    return null;
  }
  const json = safeJson(raw);
  if (json === undefined) {
    throw new Error(`claims.json が JSON として不正です（runs/${runId}/${CLAIMS_FILE}）。破損していないか確認してください。`);
  }
  const parsed = ClaimsSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`claims.json がスキーマ不適合です（runs/${runId}/${CLAIMS_FILE}）。article:claims-normalize を再実行してください。`);
  }
  return parsed.data;
}

// claims を解決する。current run に無ければ meta.lineage.supersedesRunId（更新前の版）へ fallback。
// claims-recheck と同じく、import/update run で current claims が無くても前版の台帳で enrich を効かせる
// （黙って enrich が落ちないように）。どちらにも無ければ null（claimsAvailable=false）。
async function resolveClaims(store: RunStore, runId: string): Promise<{ claims: Claim[]; sourceRunId: string } | null> {
  const own = await readClaimsStrict(store, runId);
  if (own) {
    return { claims: own, sourceRunId: runId };
  }
  const meta = await store.readMeta(runId).catch(() => null);
  const prev = meta?.lineage?.supersedesRunId;
  if (prev) {
    const prior = await readClaimsStrict(store, prev);
    if (prior) {
      return { claims: prior, sourceRunId: prev };
    }
  }
  return null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// snapshot（前回 baseline）と現 final から再 factcheck のスコープを決める純関数。
// snapshot 無し→full / 差分ゼロ→skip / 差分あり→diff。claims の有無で enrich を分岐。
export function decideFactcheckScope(
  snapshot: string | null,
  final: string,
  claims: Claim[] | null,
  claimsSourceRunId?: string
): FactcheckScope {
  if (snapshot === null) {
    return { mode: "full" };
  }
  const diff = generateUpdateDiff(snapshot, final);
  if (diff.added === 0 && diff.removed === 0) {
    return { mode: "skip" };
  }

  const claimsAvailable = claims !== null;
  const recheckClaims = claims ? selectRecheckClaims(claims, diff.changedSections) : [];
  const discoverySections = selectDiscoverySections(diff.changedSections);

  // 低リスク（削除/文体のみ・present claim 無し）は claims があるときだけ算出する。
  // claims 不在時は「claim が無い」のか「台帳が無いだけ」か区別できないため空にし、
  // 全 changed section を通常の検証対象として残す（誤って低リスク扱いしない）。
  let lowRiskSections: ChangedSection[] = [];
  if (claimsAvailable) {
    const claimHeadings = new Set(recheckClaims.map((c) => c.heading)); // 既に normalize 済み
    lowRiskSections = diff.changedSections.filter(
      (s) => s.added === 0 && !claimHeadings.has(normalizeHeading(s.heading))
    );
  }

  return {
    mode: "diff",
    changedSections: diff.changedSections,
    recheckClaims,
    discoverySections,
    lowRiskSections,
    claimsAvailable,
    claimsSourceRunId: claimsAvailable ? claimsSourceRunId : undefined,
  };
}

// 収集（snapshot/final/claims を読み）→ 判定。final.md 不在はエラー。claims 破損もエラー（readClaimsStrict）。
export async function collectFactcheckScope(store: RunStore, runId: string): Promise<FactcheckScope> {
  const final = await store.read(runId, "final.md"); // 無ければここで失敗
  const snapshot = await readSnapshot(store, runId);
  const resolved = await resolveClaims(store, runId);
  return decideFactcheckScope(snapshot, final, resolved?.claims ?? null, resolved?.sourceRunId);
}

// scope → factchecker が読む markdown。claims-recheck.md とは見出しを分ける（混同回避）。
export function renderFactcheckScope(scope: FactcheckScope, runId: string): string {
  const lines = [`# 再 factcheck スコープ: ${runId}`, ""];

  if (scope.mode === "full") {
    lines.push(
      "- 判定: **full**（baseline スナップショットが無い＝初回 factcheck）。",
      "- 対応: final.md 全文を factcheck する。完了後 `article:factcheck-stamp` で baseline を受理する。",
      ""
    );
    return lines.join("\n");
  }

  if (scope.mode === "skip") {
    lines.push(
      "- 判定: **skip**（前回 baseline と差分なし）。",
      "- 対応: 再 factcheck は不要。前回結果を流用する（編集長が progress:event で skip を記録）。",
      ""
    );
    return lines.join("\n");
  }

  lines.push(
    "- 判定: **diff**（前回 baseline から変更あり。変更箇所に絞って再検証）。",
    `- 変更セクション: ${scope.changedSections.length}`,
    ...(scope.claimsAvailable
      ? [
          `- 影響 claim: ${scope.recheckClaims.length}`,
          ...(scope.claimsSourceRunId && scope.claimsSourceRunId !== runId
            ? [`- claims 台帳の参照元: ${scope.claimsSourceRunId}（更新前の版）`]
            : []),
        ]
      : ["- claims.json なし: claim 突き合わせ・低リスク判定は省略。全変更セクションを通常の検証対象とする。"]),
    "",
    "> factchecker は下記の変更セクションと claim だけを再検証する（全文再検証しない）。",
    "> 完了後（または非事実差分として受理する場合）、編集長が `article:factcheck-stamp --accepted-after <factcheck|non-factual-diff> --note ...` で baseline を更新する。",
    ""
  );

  pushSection(lines, "再検証 claim（変更セクションに属する既存 claim）", scope.recheckClaims.map(claimLine));
  pushSection(lines, "新規 claim 抽出対象セクション（追加行あり）", scope.discoverySections.map((h) => `- ${h}`));
  if (scope.claimsAvailable) {
    pushSection(
      lines,
      "低リスク変更（削除/文体のみ・claim 紐づきなし。編集長が非事実差分として受理判断の材料に）",
      scope.lowRiskSections.map((s) => `- ${normalizeHeading(s.heading)}（+${s.added} / -${s.removed}）`)
    );
  }
  pushSection(
    lines,
    "全変更セクション",
    scope.changedSections.map((s) => `- ${normalizeHeading(s.heading)}（+${s.added} / -${s.removed}）`)
  );

  return lines.join("\n");
}

function claimLine(c: RecheckCandidate): string {
  return `- [${c.id}] (${c.type}/${c.status}/${c.severity}) ${c.claim}（${c.heading}）`;
}

function pushSection(lines: string[], title: string, items: string[]): void {
  lines.push(`## ${title}`, "");
  lines.push(items.length > 0 ? items.join("\n") : "（なし）", "");
}
