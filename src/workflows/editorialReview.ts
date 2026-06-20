import { createHash } from "node:crypto";
import { generateUpdateDiff } from "../cli/updateDiff";
import { ModelRouter } from "../router/ModelRouter";
import type { ModelCandidate } from "../router/types";
import type { ModelStamp, RunStore } from "../storage/RunStore";
import { DEFAULT_PLATFORM } from "./qiitaSteps";

// editorial-review-spec §5.2 のスキーマ（raw）。weakness に id は無い。
type WeaknessSeverity = "major" | "minor" | "preference";
type WeaknessStatus = "open" | "partial" | "resolved";

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

type PublicWeakness = { id: string; severity: WeaknessSeverity; location?: string; problem: string; recommendation: string; status: WeaknessStatus };

function toPublic(w: LedgerWeakness): PublicWeakness {
  return { id: w.id, severity: w.severity, location: w.location, problem: w.problem, recommendation: w.recommendation, status: w.status };
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
      lines.push(`- [${w.id}] (${w.status}) **${w.problem}**${loc}`);
      lines.push(`  - 推奨: ${w.recommendation}`);
    }
    lines.push("");
  }
  lines.push("## 総評", "", head.summary, "");
  return lines.join("\n");
}

// ② 候補（severity major|minor かつ status open|partial。preference・resolved 除外）。
function buildCandidates(weaknesses: PublicWeakness[]): { text: string; count: number } {
  const applicable = weaknesses.filter(
    (w) => (w.severity === "major" || w.severity === "minor") && (w.status === "open" || w.status === "partial")
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
  const finalAuthor = meta.finalAuthorModel;
  const exempt = finalAuthor === "external" || meta.imported === true;
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

  const weaknesses = ledger.weaknesses.map(toPublic);
  const reviewJson = buildReviewJson(head, weaknesses);
  const reviewMd = buildSummary(head, weaknesses);
  const candidates = buildCandidates(weaknesses);

  // ラウンド別成果物
  await store.save(runId, `editorial-r${round}-review.json`, reviewJson);
  await store.save(runId, `editorial-r${round}-review.md`, reviewMd);
  // 最新 alias（編集長が読む。継続でも現ラウンドで上書き）
  await store.save(runId, "editorial-review.json", reviewJson);
  await store.save(runId, "editorial-review.md", reviewMd);
  await store.save(runId, "editorial-instruction.candidates.md", candidates.text);

  return { runId, mode, round, reviewerModel, verdict: head.verdict, candidateCount: candidates.count };
}
