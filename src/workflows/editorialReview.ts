import { createHash } from "node:crypto";
import { generateUpdateDiff } from "../cli/updateDiff";
import { ModelRouter } from "../router/ModelRouter";
import type { ModelCandidate } from "../router/types";
import type { ModelStamp, RunStore } from "../storage/RunStore";
import { DEFAULT_PLATFORM } from "./qiitaSteps";

// editorial-review-spec §5.2 のスキーマ（raw）。weakness に id は無い。
type WeaknessSeverity = "major" | "minor" | "preference";
// reviewer が返す状態（機械レビュー視点）。継続レビューの trackedWeaknesses もこの3値。
type WeaknessStatus = "open" | "partial" | "resolved";
// 編集長の採否（人間の編集判断）。reviewer の status とは別軸で記録する。
// - accepted: 採用して revise 済み / waived: 不採用（媒体適性・preference 等で見送り）
// - escalated: ユーザーへ上申中 / user-approved: 上申に対しユーザー承認が下りた
export type WeaknessResolution = "accepted" | "waived" | "escalated" | "user-approved";

const WEAKNESS_RESOLUTIONS: WeaknessResolution[] = ["accepted", "waived", "escalated", "user-approved"];

export function parseWeaknessResolution(value: string): WeaknessResolution {
  if ((WEAKNESS_RESOLUTIONS as string[]).includes(value)) {
    return value as WeaknessResolution;
  }
  throw new Error(`Invalid resolution: ${value}（${WEAKNESS_RESOLUTIONS.join(" | ")}）`);
}

type RawWeakness = {
  severity: WeaknessSeverity;
  location?: string;
  problem: string;
  recommendation: string;
};

type RawEditorialReview = {
  verdict: "publication-candidate" | "needs-revision" | "rework";
  scores: { axis: string; score: number }[];
  strengths: string[];
  weaknesses: RawWeakness[];
  summary: string;
};

type TrackedWeakness = { id: string; status: WeaknessStatus; evidence?: string };
type RawContinuationReview = {
  verdict: RawEditorialReview["verdict"];
  scores: { axis: string; score: number }[];
  strengths: string[];
  trackedWeaknesses: TrackedWeakness[];
  newWeaknesses: RawWeakness[];
  summary: string;
};

// run 内の weakness 台帳（editorial-ledger.json）。id はパイプライン採番（spec §5.5/§8-3）。
type LedgerWeakness = RawWeakness & {
  id: string;
  hash: string;
  status: WeaknessStatus;
  firstRound: number;
  lastRound: number;
  evidence?: string;
  // 編集長の採否（status とは別軸。article:editorial-resolve で書き戻す）。
  resolution?: WeaknessResolution;
  resolutionEvidence?: string;
  resolvedAt?: string; // ISO8601
  resolvedRound?: number;
};
type EditorialLedger = { round: number; lastSeq: number; weaknesses: LedgerWeakness[] };

export type EditorialReviewMode = "independent" | "continuation";
export type EditorialReviewOptions = {
  mode?: EditorialReviewMode;
  allowSameProvider?: boolean;
  allowSameModel?: boolean;
  criteria?: string;
};

export type EditorialReviewResult = {
  runId: string;
  mode: EditorialReviewMode;
  round: number;
  reviewerModel: ModelStamp;
  verdict: string;
  candidateCount: number;
};

const LEDGER_FILE = "editorial-ledger.json";
const HASH_LEN = 8;
const SEVERITY_ORDER: WeaknessSeverity[] = ["major", "minor", "preference"];

// --- 独立性（spec §5.1） ---

function computeExclusions(
  finalAuthor: ModelStamp,
  options: EditorialReviewOptions
): { excludeProviders?: string[]; excludeCandidates?: ModelCandidate[] } {
  if (options.allowSameModel) {
    return {};
  }
  if (options.allowSameProvider) {
    return { excludeCandidates: [{ provider: finalAuthor.provider, model: finalAuthor.model }] };
  }
  return { excludeProviders: [finalAuthor.provider] };
}

function assertIndependentResponse(
  finalAuthor: ModelStamp,
  reviewer: ModelStamp,
  options: EditorialReviewOptions
): void {
  if (options.allowSameModel) {
    return;
  }
  const sameProvider = reviewer.provider === finalAuthor.provider;
  const sameModel = sameProvider && reviewer.model === finalAuthor.model;
  if (options.allowSameProvider) {
    if (sameModel) {
      throw new Error(
        `Editorial reviewer (${reviewer.provider}/${reviewer.model}) is the exact final-author model; independence violated`
      );
    }
    return;
  }
  if (sameProvider) {
    throw new Error(
      `Editorial reviewer provider (${reviewer.provider}) matches the final author; pass --allow-same-provider to override`
    );
  }
}

// --- 台帳 ---

function weaknessHash(w: RawWeakness): string {
  const norm = [w.severity, w.location ?? "", w.problem, w.recommendation]
    .map((s) => s.replace(/\s+/g, " ").trim())
    .join("|");
  return createHash("sha256").update(norm).digest("hex").slice(0, HASH_LEN);
}

async function readLedger(store: RunStore, runId: string): Promise<EditorialLedger | null> {
  return store.read(runId, LEDGER_FILE).then(
    (content) => JSON.parse(content) as EditorialLedger,
    () => null
  );
}

// 既知 id の status を更新する（継続モード。返ってこなかった id は触らない＝open のまま残す）。
function applyTracked(ledger: EditorialLedger, tracked: TrackedWeakness[], round: number): void {
  for (const t of tracked) {
    const entry = ledger.weaknesses.find((w) => w.id === t.id);
    if (entry) {
      entry.status = t.status;
      entry.evidence = t.evidence;
      entry.lastRound = round;
    }
  }
}

// 独立フル読みは authoritative。今回再検出されなかった既存 open/partial は resolved にする
// （定期的に独立読みを挟む運用で、修正済みの古い指摘が候補に残り続けないように）。spec §5.5。
function closeMissing(ledger: EditorialLedger, foundHashes: Set<string>, round: number): void {
  for (const w of ledger.weaknesses) {
    if ((w.status === "open" || w.status === "partial") && !foundHashes.has(w.hash)) {
      w.status = "resolved";
      w.evidence = "independent full read で再検出されず";
      w.lastRound = round;
    }
  }
}

// 新規 weakness を台帳へマージ（同内容 hash の再出現は既存 id を再利用し、新規だけ採番）。
function mergeFound(ledger: EditorialLedger, found: RawWeakness[], round: number): void {
  for (const fw of found) {
    const hash = weaknessHash(fw);
    const existing = ledger.weaknesses.find((w) => w.hash === hash);
    if (existing) {
      // 同じ指摘が再び挙がった → open に戻し、内容と round を更新（新 id は増やさない）。
      existing.status = "open";
      existing.severity = fw.severity;
      existing.location = fw.location;
      existing.problem = fw.problem;
      existing.recommendation = fw.recommendation;
      existing.lastRound = round;
      // reviewer が同じ問題を再検出した＝前回の編集判断（accepted 等）は陳腐化。resolution を消して
      // 候補へ戻す（「採用済み」のラベルで未解決を隠さない）。再度の採否は編集長が打ち直す。
      delete existing.resolution;
      delete existing.resolutionEvidence;
      delete existing.resolvedAt;
      delete existing.resolvedRound;
    } else {
      ledger.lastSeq += 1;
      ledger.weaknesses.push({
        ...fw,
        id: `W${String(ledger.lastSeq).padStart(3, "0")}-${hash}`,
        hash,
        status: "open",
        firstRound: round,
        lastRound: round,
      });
    }
  }
}

// --- 出力整形 ---

type PublicWeakness = { id: string; severity: WeaknessSeverity; location?: string; problem: string; recommendation: string; status: WeaknessStatus; resolution?: WeaknessResolution };

function toPublic(w: LedgerWeakness): PublicWeakness {
  return { id: w.id, severity: w.severity, location: w.location, problem: w.problem, recommendation: w.recommendation, status: w.status, resolution: w.resolution };
}

type RoundHead = { round: number; verdict: string; scores: { axis: string; score: number }[]; strengths: string[]; summary: string };

function buildReviewJson(head: RoundHead, weaknesses: PublicWeakness[]): string {
  return JSON.stringify({ ...head, weaknesses }, null, 2);
}

function buildSummary(head: RoundHead, weaknesses: PublicWeakness[]): string {
  const lines = [
    "# 編集レビュー",
    "",
    `- ラウンド: ${head.round}`,
    `- 判定(verdict): ${head.verdict}`,
    "",
    "## スコア",
    "",
    "| 軸 | スコア |",
    "| --- | --- |",
    ...head.scores.map((s) => `| ${s.axis} | ${s.score} |`),
    "",
    "## 強み",
    "",
    ...(head.strengths.length ? head.strengths.map((s) => `- ${s}`) : ["（なし）"]),
    "",
    "## 弱み（台帳・status つき）",
    "",
  ];
  for (const sev of SEVERITY_ORDER) {
    const items = weaknesses.filter((w) => w.severity === sev);
    if (items.length === 0) {
      continue;
    }
    lines.push(`### ${sev}${sev === "preference" ? "（好みレベル・自動適用しない）" : ""}`);
    for (const w of items) {
      const loc = w.location ? `（${w.location}）` : "";
      const decided = w.resolution ? ` / 採否: ${w.resolution}` : "";
      lines.push(`- [${w.id}] (${w.status}${decided}) **${w.problem}**${loc}`);
      lines.push(`  - 推奨: ${w.recommendation}`);
    }
    lines.push("");
  }
  lines.push("## 総評", "", head.summary, "");
  return lines.join("\n");
}

// ② 候補（severity major|minor かつ status open|partial。preference・resolved 除外）。
function buildCandidates(weaknesses: PublicWeakness[]): { text: string; count: number } {
  // 編集長が採否を決めた weakness（resolution あり）は候補から外す（再生成で蒸し返さない）。
  const applicable = weaknesses.filter(
    (w) =>
      (w.severity === "major" || w.severity === "minor") &&
      (w.status === "open" || w.status === "partial") &&
      w.resolution === undefined
  );
  const lines = [
    "# 編集レビュー 修正候補（②機械フィルタ / 未確定）",
    "",
    "> これは候補です。③編集長が取捨して `editorial-instruction.md` に確定したものだけを `article:revise` で適用します。",
    "> preference と resolved は除外済み。",
    "",
  ];
  for (const sev of ["major", "minor"] as const) {
    const items = applicable.filter((w) => w.severity === sev);
    if (items.length === 0) {
      continue;
    }
    lines.push(`## ${sev}`);
    for (const w of items) {
      const loc = w.location ? `（${w.location}）` : "";
      lines.push(`- [${w.id}] (${w.status}) 問題${loc}: ${w.problem}`);
      lines.push(`  - 推奨: ${w.recommendation}`);
    }
    lines.push("");
  }
  if (applicable.length === 0) {
    lines.push("（適用候補はありません）", "");
  }
  return { text: lines.join("\n"), count: applicable.length };
}

function buildIndependentInput(platform: string, final: string, criteria?: string): string {
  return [
    `次の${platform}記事を、読者・編集視点でレビューしてください。`,
    "内容の事実正誤の確定はしないでください（別系統のファクトチェックの担当）。構成・読みやすさ・専門性の届き方を評価します。",
    "weakness に id は付けないでください（id は後段で採番します）。",
    ...(criteria ? ["", "評価観点:", criteria] : []),
    "",
    "記事:",
    final,
  ].join("\n");
}

function buildContinuationInput(
  platform: string,
  final: string,
  diff: string,
  openPrior: LedgerWeakness[],
  criteria?: string
): string {
  const priorLines = openPrior.map((w) => {
    const loc = w.location ? `（${w.location}）` : "";
    return `- [${w.id}] (${w.severity}${loc}) ${w.problem} / 推奨: ${w.recommendation}`;
  });
  return [
    `次の${platform}記事の改訂版を、前回の指摘と今回の変更点に基づいて再レビューしてください。`,
    "前回の未解決指摘が解消されたかを trackedWeaknesses で id ごとに status(open/partial/resolved) と evidence で返してください。",
    "今回の変更で新たに生じた問題だけを newWeaknesses に（id は付けない）。前回指摘の蒸し返しは newWeaknesses に入れないでください。",
    ...(criteria ? ["", "評価観点:", criteria] : []),
    "",
    "前回までの未解決の指摘:",
    ...(priorLines.length ? priorLines : ["（なし）"]),
    "",
    "今回の変更（前回レビュー時点 → 現在の差分）:",
    diff || "（差分なし）",
    "",
    "記事（現在）:",
    final,
  ].join("\n");
}

// --- 本体 ---

export async function runEditorialReview(
  router: ModelRouter,
  store: RunStore,
  runId: string,
  options: EditorialReviewOptions = {}
): Promise<EditorialReviewResult> {
  const mode: EditorialReviewMode = options.mode ?? "independent";
  const meta = await store.readMeta(runId);
  const platform = meta.platform ?? DEFAULT_PLATFORM;
  const final = await store.read(runId, "final.md");

  // 独立性の前提（spec §5.1）。
  // 免除は「現 final.md を外部/人間が書いた」場合のみ。import 直後は finalAuthorModel="external" で免除されるが、
  // その後 article:revise がモデル印を記録したら（imported は残っていても）独立性チェックを復活させる。
  // 後方互換: finalAuthorModel を持たない古い import run（imported のみ）は救済する。
  const finalAuthor = meta.finalAuthorModel;
  const exempt = finalAuthor === "external" || (meta.imported === true && !finalAuthor);
  if (!exempt && !finalAuthor) {
    throw new Error(
      `Run ${runId} の finalAuthorModel が未記録です。一度 article:revise で final.md を改稿（または article:review で再生成）して記録してから editorial review を回してください。（article:resume は完了 step をスキップするため記録されません）`
    );
  }
  const exclusions = exempt || !finalAuthor ? {} : computeExclusions(finalAuthor, options);

  const existing = await readLedger(store, runId);
  if (mode === "continuation" && !existing) {
    throw new Error(`Run ${runId} に編集レビュー台帳がありません。先に --mode independent で初回レビューを回してください。`);
  }
  const round = (existing?.round ?? 0) + 1;
  // 今ラウンドがレビューした本文のスナップショット（次ラウンドの since-last 差分の起点）。
  await store.save(runId, `editorial-r${round}-before.md`, final);

  const ledger: EditorialLedger = existing ?? { round: 0, lastSeq: 0, weaknesses: [] };
  let head: RoundHead;

  if (mode === "independent") {
    const response = await router.run({
      task: "editorial_review",
      input: buildIndependentInput(platform, final, options.criteria),
      schemaName: "EditorialReview",
      ...exclusions,
    });
    const reviewerModel: ModelStamp = { provider: response.provider, model: response.model };
    await store.setReviewerModel(runId, reviewerModel);
    if (!exempt && finalAuthor) {
      assertIndependentResponse(finalAuthor, reviewerModel, options);
    }
    const raw = JSON.parse(response.text) as RawEditorialReview;
    const foundHashes = new Set(raw.weaknesses.map(weaknessHash));
    mergeFound(ledger, raw.weaknesses, round);
    closeMissing(ledger, foundHashes, round); // 独立フル読みで再検出されなかった既存 open/partial を閉じる
    head = { round, verdict: raw.verdict, scores: raw.scores, strengths: raw.strengths, summary: raw.summary };
    return finalize(store, runId, mode, ledger, round, head, reviewerModel);
  }

  // continuation
  const prevBefore = await store.read(runId, `editorial-r${round - 1}-before.md`);
  const diff = generateUpdateDiff(prevBefore, final).diffText;
  const openPrior = ledger.weaknesses.filter((w) => w.status === "open" || w.status === "partial");

  const response = await router.run({
    task: "editorial_review",
    input: buildContinuationInput(platform, final, diff, openPrior, options.criteria),
    schemaName: "EditorialReviewContinuation",
    ...exclusions,
  });
  const reviewerModel: ModelStamp = { provider: response.provider, model: response.model };
  await store.setReviewerModel(runId, reviewerModel);
  if (!exempt && finalAuthor) {
    assertIndependentResponse(finalAuthor, reviewerModel, options);
  }
  const raw = JSON.parse(response.text) as RawContinuationReview;
  applyTracked(ledger, raw.trackedWeaknesses, round);
  mergeFound(ledger, raw.newWeaknesses, round);
  head = { round, verdict: raw.verdict, scores: raw.scores, strengths: raw.strengths, summary: raw.summary };
  return finalize(store, runId, mode, ledger, round, head, reviewerModel);
}

// 台帳更新＋ラウンド成果物＋最新 alias を書く（継続でも最新 alias を現ラウンドで上書き、spec §5.5）。
async function finalize(
  store: RunStore,
  runId: string,
  mode: EditorialReviewMode,
  ledger: EditorialLedger,
  round: number,
  head: RoundHead,
  reviewerModel: ModelStamp
): Promise<EditorialReviewResult> {
  ledger.round = round;
  await store.save(runId, LEDGER_FILE, JSON.stringify(ledger, null, 2));

  const out = renderLedgerOutputs(head, ledger);
  // ラウンド別成果物（その round の reviewer 出力スナップショット）
  await store.save(runId, `editorial-r${round}-review.json`, out.reviewJson);
  await store.save(runId, `editorial-r${round}-review.md`, out.reviewMd);
  // 最新 alias（編集長が読む。継続でも現ラウンドで上書き）
  await writeLatestArtifacts(store, runId, out);

  return { runId, mode, round, reviewerModel, verdict: head.verdict, candidateCount: out.candidates.count };
}

// head（ラウンド情報）＋台帳から、編集長が読む3成果物を1か所で組み立てる（finalize / resolveWeakness で共有）。
function renderLedgerOutputs(
  head: RoundHead,
  ledger: EditorialLedger
): { reviewJson: string; reviewMd: string; candidates: { text: string; count: number } } {
  const weaknesses = ledger.weaknesses.map(toPublic);
  return {
    reviewJson: buildReviewJson(head, weaknesses),
    reviewMd: buildSummary(head, weaknesses),
    candidates: buildCandidates(weaknesses),
  };
}

async function writeLatestArtifacts(
  store: RunStore,
  runId: string,
  out: ReturnType<typeof renderLedgerOutputs>
): Promise<void> {
  await store.save(runId, "editorial-review.json", out.reviewJson);
  await store.save(runId, "editorial-review.md", out.reviewMd);
  await store.save(runId, "editorial-instruction.candidates.md", out.candidates.text);
}

// 最新 alias（editorial-review.json）から head を復元する。resolveWeakness は新ラウンドを回さずに
// 採否を反映するため、直近レビューの head を流用して reader 向け成果物だけ作り直す。
async function readLatestHead(store: RunStore, runId: string): Promise<RoundHead | null> {
  const raw = await store.read(runId, "editorial-review.json").then(
    (c) => JSON.parse(c) as Partial<RoundHead>,
    () => null
  );
  if (!raw || typeof raw.round !== "number") {
    return null;
  }
  return {
    round: raw.round,
    verdict: raw.verdict ?? "",
    scores: raw.scores ?? [],
    strengths: raw.strengths ?? [],
    summary: raw.summary ?? "",
  };
}

export type ResolveWeaknessResult = {
  runId: string;
  id: string;
  resolution: WeaknessResolution;
  severity: WeaknessSeverity;
};

// 編集長の採否を台帳へ書き戻す（reviewer の status は触らない）。reviewer の機械状態と
// 編集判断を別軸で残すことで、unresolved の機械集計が「open/partial かつ resolution 未設定」で取れる。
export async function resolveWeakness(
  store: RunStore,
  runId: string,
  id: string,
  resolution: WeaknessResolution,
  evidence: string
): Promise<ResolveWeaknessResult> {
  if (evidence.trim().length === 0) {
    throw new Error("--evidence は空にできません（採否の根拠を監査台帳に残すため）。");
  }
  const ledger = await readLedger(store, runId);
  if (!ledger) {
    throw new Error(
      `Run ${runId} に編集レビュー台帳（${LEDGER_FILE}）がありません。先に article:review-editorial を回してください。`
    );
  }
  const entry = ledger.weaknesses.find((w) => w.id === id);
  if (!entry) {
    const known = ledger.weaknesses.map((w) => w.id).join(", ") || "(なし)";
    throw new Error(`weakness id "${id}" が台帳にありません。既知の id: ${known}`);
  }
  entry.resolution = resolution;
  entry.resolutionEvidence = evidence.trim();
  entry.resolvedAt = new Date().toISOString();
  entry.resolvedRound = ledger.round;
  await store.save(runId, LEDGER_FILE, JSON.stringify(ledger, null, 2));

  // reader 向け成果物（candidates / review.md・json）も即時更新する。これをしないと採用済み
  // weakness が候補に残り続け、次回レビューを回すまで stale になる（直近レビューの head を流用）。
  const head = await readLatestHead(store, runId);
  if (head) {
    await writeLatestArtifacts(store, runId, renderLedgerOutputs(head, ledger));
  }
  return { runId, id, resolution, severity: entry.severity };
}

// --- 未確定（公開ゲート）判定 ---
// 述語を 1 箇所に集約し、countUnresolved / collectUnsettledWeaknesses で共有する（定義のドリフト防止）。

type WeaknessDecision = { status: WeaknessStatus; resolution?: WeaknessResolution };

// 未解決: open/partial かつ編集長の採否が未設定。
function isUnresolved(w: WeaknessDecision): boolean {
  return (w.status === "open" || w.status === "partial") && w.resolution === undefined;
}
// 上申中: ユーザー承認前（user-approved への打ち直し待ち）。判断済みだが公開承認済みではない。
function isEscalated(w: WeaknessDecision): boolean {
  return w.resolution === "escalated";
}
// 公開を止めるべき「未確定」= 未解決 または 上申中。
// 公開可（settled）= status="resolved"、または resolution ∈ {accepted, waived, user-approved}。
function isUnsettled(w: WeaknessDecision): boolean {
  return isUnresolved(w) || isEscalated(w);
}

// 未解決の weakness 数（open/partial かつ編集長の採否が未設定）。preference は除外可。
export function countUnresolved(weaknesses: { status: WeaknessStatus; severity: WeaknessSeverity; resolution?: WeaknessResolution }[]): number {
  return weaknesses.filter(isUnresolved).length;
}

export type UnsettledWeakness = {
  id: string;
  severity: WeaknessSeverity;
  status: WeaknessStatus;
  reason: "unresolved" | "escalated";
  problem: string;
};

// 公開ゲート入力: 台帳の有無と、未確定 weakness を severity 別に分けたもの。
export type EditorialGateInput = {
  hasLedger: boolean;
  major: UnsettledWeakness[];
  minor: UnsettledWeakness[];
  preference: UnsettledWeakness[];
};

// 台帳を読み、未確定（未解決 or 上申中）を severity 別に集計する。
// 台帳が無ければ hasLedger=false（編集レビュー未実施 run。呼び出し側で done 宣言時は必須化する）。
export async function collectUnsettledWeaknesses(
  store: RunStore,
  runId: string
): Promise<EditorialGateInput> {
  const ledger = await readLedger(store, runId);
  const out: EditorialGateInput = { hasLedger: ledger !== null, major: [], minor: [], preference: [] };
  if (!ledger) return out;
  for (const w of ledger.weaknesses) {
    if (!isUnsettled(w)) continue;
    out[w.severity].push({
      id: w.id,
      severity: w.severity,
      status: w.status,
      reason: isEscalated(w) ? "escalated" : "unresolved",
      problem: w.problem,
    });
  }
  return out;
}
