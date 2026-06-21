import { ModelRouter } from "../router/ModelRouter";
import { RunStore } from "../storage/RunStore";
import type { RefineMeta, RefineRoundMeta, RefineStoppedReason } from "../storage/RunStore";
import type { ModelTask } from "../router/types";
import { detectWrapText, stripWrappingCodeFence } from "../utils/text";
import { DEFAULT_PLATFORM, qiitaSteps, toModelRequest, type QiitaStepName } from "./qiitaSteps";

export type QiitaWorkflowResult = {
  runId: string;
  finalText?: string;
};

export type WorkflowEvent =
  | { type: "step:start"; index: number; total: number; name: string; task: ModelTask }
  | { type: "step:skip"; index: number; total: number; name: string }
  | {
      type: "step:done";
      index: number;
      total: number;
      name: string;
      provider: string;
      model: string;
      elapsedMs: number;
      costUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
      truncated?: boolean;
      warnings?: string[];
    };

export type WorkflowReporter = (event: WorkflowEvent) => void;

const noop: WorkflowReporter = () => undefined;

export async function createQiitaArticle(
  router: ModelRouter,
  store: RunStore,
  topic: string,
  options: { runId?: string; platform?: string; style?: string; profile?: string } = {},
  onEvent: WorkflowReporter = noop
): Promise<QiitaWorkflowResult> {
  const runId = options.runId ?? createRunId(topic);
  await store.create(
    runId,
    topic,
    qiitaSteps.map((step) => step.name),
    options.platform ?? DEFAULT_PLATFORM,
    options.style,
    options.profile
  );
  return runQiitaArticle(router, store, runId, undefined, onEvent);
}

export async function resumeQiitaArticle(
  router: ModelRouter,
  store: RunStore,
  runId: string,
  onEvent: WorkflowReporter = noop
): Promise<QiitaWorkflowResult> {
  await assertNotImported(store, runId, "resume");
  return runQiitaArticle(router, store, runId, undefined, onEvent);
}

// import run は brief〜review の生成系成果物を持たないため、resume/review を実行すると
// import 元と無関係な中間成果物を作る/draft.md 不在で失敗する。明示的に拒否して誘導する。
async function assertNotImported(store: RunStore, runId: string, command: string): Promise<void> {
  const meta = await store.readMeta(runId);
  if (meta.imported) {
    throw new Error(
      `Run ${runId} は import run です（${command} は使えません）。article:evaluate / article:refine / article:revise を使ってください。`
    );
  }
}

export type ReviseResult = QiitaWorkflowResult & {
  provider: string;
  model: string;
  elapsedMs: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  truncated?: boolean;
  warnings?: string[];
};

export async function reviseQiitaFinal(
  router: ModelRouter,
  store: RunStore,
  runId: string,
  instruction: string,
  onEvent: WorkflowReporter = noop,
  options: { backupTo?: string | null } = {}
): Promise<ReviseResult> {
  const meta = await store.readMeta(runId);
  const platform = meta.platform ?? DEFAULT_PLATFORM;
  const current = await store.read(runId, "final.md");
  // backupTo: 既定は final.bak.md。null を渡すと退避をスキップ（refine は事前に before スナップショットを取る）。
  const backupTo = options.backupTo === undefined ? "final.bak.md" : options.backupTo;
  if (backupTo !== null) {
    await store.save(runId, backupTo, current);
  }

  const input = [
    `次の${platform}記事を、以下の修正指示に従って改善してください。`,
    "Markdown本文だけを返してください。説明やコードフェンスで全体を囲まないでください。",
    "記事の先頭にタイトルの見出し（レベル1の \"# \"）がある場合は、修正指示で明示されない限り保持してください。",
    ...(meta.style ? ["", "作法:", meta.style] : []),
    "",
    "修正指示:",
    instruction,
    "",
    "現在の記事:",
    current,
  ].join("\n");

  onEvent({ type: "step:start", index: 1, total: 1, name: "revise", task: "rewrite" });
  const response = await router.run({ task: "rewrite", input });
  const text = stripWrappingCodeFence(response.text);
  await store.save(runId, "final.md", text);
  await store.markDone(runId, "final", "final.md");
  // final.md を書いたモデルを記録（markDone の後。編集レビューの独立性に使う）。
  await store.setFinalAuthorModel(runId, { provider: response.provider, model: response.model });
  const warnings = detectWrapText(text);
  onEvent({
    type: "step:done",
    index: 1,
    total: 1,
    name: "revise",
    provider: response.provider,
    model: response.model,
    elapsedMs: response.elapsedMs,
    costUsd: response.usage?.costUsd,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
    truncated: response.truncated,
    warnings,
  });
  return {
    runId,
    finalText: text,
    provider: response.provider,
    model: response.model,
    elapsedMs: response.elapsedMs,
    costUsd: response.usage?.costUsd,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
    truncated: response.truncated,
    warnings,
  };
}

export type Severity = "critical" | "major" | "minor" | "suggestion";

type ReviewIssue = {
  severity: Severity;
  location?: string;
  problem: string;
  recommendation: string;
};

type ReviewResultJson = {
  summary?: string;
  approved?: boolean;
  issues: ReviewIssue[];
};

type EvaluationResult = {
  runId: string;
  approved?: boolean;
  issueCount: number;
  reviewFile: string;
  reviewSummaryFile: string;
  instructionFile?: string;
};

const severityRank: Record<Severity, number> = {
  suggestion: 0,
  minor: 1,
  major: 2,
  critical: 3,
};

// refine の品質スコア用 severity 重み（2 ** severityRank: suggestion=1, minor=2, major=4, critical=8）。
const severityWeight: Record<Severity, number> = {
  suggestion: 1,
  minor: 2,
  major: 4,
  critical: 8,
};

// refine ループのヒステリシス定数（CLI フラグにはしない。実運用ログを見て調整）。
const REFINE_IMPROVE_REL = 0.05; // 改善とみなす相対しきい値
const REFINE_IMPROVE_ABS = 1; // 改善とみなす絶対しきい値
const REFINE_REGRESS_REL = 0.25; // 悪化（regressed）とみなす相対しきい値
const REFINE_REGRESS_ABS = 2; // 悪化（regressed）とみなす絶対しきい値
const REFINE_STALL_STREAK = 2; // 改善なしが連続したら stalled

// レビュー結果の severity 重み付きスコア（低いほど良い）。§5.1。
export function scoreReview(review: ReviewResultJson): number {
  return review.issues.reduce((sum, issue) => sum + (severityWeight[issue.severity] ?? 0), 0);
}

// 副作用なしの評価コア。モデル呼び出し＋parse＋score のみを行い、ファイルは一切書かない。
// article:evaluate（下のラッパ）と refine の両方から使う。
export type FinalEvaluation = {
  provider: string;
  model: string;
  elapsedMs: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  truncated?: boolean;
  rawReviewJson: string; // response.text（生）。保存はそのまま store.save する
  review: ReviewResultJson; // parse 済み
  score: number; // 重み付きスコア（全指摘）
  approved?: boolean;
  issueCount: number; // minSeverity 以上
};

export async function runFinalEvaluation(
  router: ModelRouter,
  store: RunStore,
  runId: string,
  options: { minSeverity: Severity; criteria?: string }
): Promise<FinalEvaluation> {
  const meta = await store.readMeta(runId);
  const platform = meta.platform ?? DEFAULT_PLATFORM;
  const final = await store.read(runId, "final.md");

  const input = [
    `次の${platform}記事を技術レビューしてください。`,
    "問題点・改善案・修正すべき箇所をJSONで返してください。",
    ...(options.criteria ? ["", "特に次の評価観点を重視してください:", options.criteria] : []),
    "",
    "記事:",
    final,
  ].join("\n");

  const response = await router.run({ task: "final_review", input, schemaName: "ReviewResult" });
  const review = JSON.parse(response.text) as ReviewResultJson;
  const issueCount = review.issues.filter(
    (issue) => severityRank[issue.severity] >= severityRank[options.minSeverity]
  ).length;

  return {
    provider: response.provider,
    model: response.model,
    elapsedMs: response.elapsedMs,
    costUsd: response.usage?.costUsd,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
    truncated: response.truncated,
    rawReviewJson: response.text,
    review,
    score: scoreReview(review),
    approved: review.approved,
    issueCount,
  };
}

export async function evaluateQiitaFinal(
  router: ModelRouter,
  store: RunStore,
  runId: string,
  options: { minSeverity?: Severity; criteria?: string } = {},
  onEvent: WorkflowReporter = noop
): Promise<EvaluationResult> {
  const minSeverity = options.minSeverity ?? "suggestion";

  onEvent({ type: "step:start", index: 1, total: 1, name: "evaluate", task: "final_review" });
  const evaluation = await runFinalEvaluation(router, store, runId, { minSeverity, criteria: options.criteria });
  // 生テキストをそのまま保存（parse→再 stringify しない。store.save の末尾改行正規化は従来どおり）。
  await store.save(runId, "final-review.json", evaluation.rawReviewJson);
  onEvent({
    type: "step:done",
    index: 1,
    total: 1,
    name: "evaluate",
    provider: evaluation.provider,
    model: evaluation.model,
    elapsedMs: evaluation.elapsedMs,
    costUsd: evaluation.costUsd,
    inputTokens: evaluation.inputTokens,
    outputTokens: evaluation.outputTokens,
    truncated: evaluation.truncated,
  });

  const review = evaluation.review;

  // 人が読むための全指摘サマリ（severityフィルタなし）。
  await store.save(runId, "final-review.md", buildReviewSummary(review));

  // フィルタは呼び出し側（このラッパ）の責務。buildRevisionInstruction はフィルタ済み配列を整形するだけ。
  const filtered = review.issues.filter((issue) => severityRank[issue.severity] >= severityRank[minSeverity]);

  let instructionFile: string | undefined;
  if (filtered.length > 0) {
    await store.save(runId, "revise-instruction.md", buildRevisionInstruction(filtered));
    instructionFile = "revise-instruction.md";
  } else {
    // 対象指摘が無いときは、前回評価で生成された古い指示を残さない（誤適用防止）。
    await store.remove(runId, "revise-instruction.md");
  }

  return {
    runId,
    approved: review.approved,
    issueCount: filtered.length,
    reviewFile: "final-review.json",
    reviewSummaryFile: "final-review.md",
    instructionFile,
  };
}

export type RefineEvent =
  | { type: "round:start"; round: number; maxRounds: number }
  | {
      type: "eval:done";
      round: number;
      provider: string;
      model: string;
      elapsedMs: number;
      costUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
      truncated?: boolean;
      issueCount: number;
      score: number;
      minSeverity: Severity;
    }
  | {
      type: "revise:done";
      round: number;
      provider: string;
      model: string;
      elapsedMs: number;
      costUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
      truncated?: boolean;
      warnings?: string[];
    }
  | { type: "stopped"; reason: RefineStoppedReason; rounds: number; costUsdTotal: number };

export type RefineReporter = (event: RefineEvent) => void;

const noopRefine: RefineReporter = () => undefined;

export type RefineOptions = {
  maxRounds?: number;
  minSeverity?: Severity;
  until?: "clean" | "approved";
  criteria?: string;
};

export type RefineResult = {
  runId: string;
  finalText?: string;
  stoppedReason: RefineStoppedReason;
  rounds: number;
  costUsdTotal: number;
};

// score が「改善」とみなせるか（直前比で相対 5% かつ絶対 1 以上 下がった）。
function isRefineImprovement(prev: number, cur: number): boolean {
  const drop = prev - cur;
  if (drop < REFINE_IMPROVE_ABS) {
    return false;
  }
  return prev === 0 ? drop > 0 : drop / prev >= REFINE_IMPROVE_REL;
}

// score が「有意に悪化」したか（直前比で相対 25% かつ絶対 2 以上 上がった）。
function isRefineRegression(prev: number, cur: number): boolean {
  const rise = cur - prev;
  if (rise < REFINE_REGRESS_ABS) {
    return false;
  }
  return prev === 0 ? rise > 0 : rise / prev >= REFINE_REGRESS_REL;
}

export async function refineQiitaFinal(
  router: ModelRouter,
  store: RunStore,
  runId: string,
  options: RefineOptions = {},
  onEvent: RefineReporter = noopRefine
): Promise<RefineResult> {
  const maxRounds = options.maxRounds ?? 3;
  const minSeverity = options.minSeverity ?? "major";
  const until = options.until ?? "clean";

  // refine 状態を保持し、毎回 fresh な meta に貼り直して永続化する。
  // （reviseQiitaFinal が markDone で meta を別途更新するため、古い meta を上書きしないよう fresh read する。）
  const refineState: RefineMeta = { rounds: [], minSeverity, until, maxRoundsAtRun: maxRounds };
  const persist = async (state: RefineMeta): Promise<void> => {
    const meta = await store.readMeta(runId);
    meta.refine = state;
    await store.writeMeta(meta);
  };

  // 開始処理: 旧 refine 成果物の掃除（既知 suffix を列挙。中断耐性のため上限を広めに取る）。
  const oldMeta = await store.readMeta(runId);
  const cleanupTo = Math.max(
    oldMeta.refine?.maxRoundsAtRun ?? 0,
    oldMeta.refine?.rounds.length ?? 0,
    maxRounds
  );
  for (let n = 1; n <= cleanupTo; n++) {
    await store.remove(runId, `refine-r${n}-review.json`);
    await store.remove(runId, `refine-r${n}-review.md`);
    await store.remove(runId, `refine-r${n}-instruction.md`);
    await store.remove(runId, `refine-r${n}-before.md`);
  }
  await store.remove(runId, "refine-summary.md");
  await store.remove(runId, "revise-instruction.md");
  await persist(refineState);

  let stoppedReason: RefineStoppedReason | undefined;

  // 停止時の確定処理: ローカル算出 → 成果物生成 → 完了 meta(派生)を最後に write。
  const finalize = async (reason: RefineStoppedReason): Promise<void> => {
    const lastRound = refineState.rounds.length;
    const lastEval = refineState.rounds[lastRound - 1]?.evaluation;
    const costUsdTotal = refineState.rounds.reduce((sum, r) => sum + r.costUsdTotal, 0);

    // 成果物を先に生成（最終ラウンドの評価をトップレベルへ複製）。
    if (lastRound > 0) {
      const rawJson = await store.read(runId, `refine-r${lastRound}-review.json`);
      await store.save(runId, "final-review.json", rawJson);
      const reviewMd = await store.read(runId, `refine-r${lastRound}-review.md`);
      await store.save(runId, "final-review.md", reviewMd);
    }
    await store.save(runId, "refine-summary.md", buildRefineSummary(refineState, reason));

    // 完了 meta は派生オブジェクトを最後に write（生きている refineState には stoppedReason を付けない）。
    const completed: RefineMeta = {
      ...refineState,
      stoppedReason: reason,
      finalIssueCount: lastEval?.issueCount,
      finalScore: lastEval?.score,
      finalApproved: lastEval?.approved,
      costUsdTotal,
    };
    await persist(completed);
    stoppedReason = reason;
    onEvent({ type: "stopped", reason, rounds: lastRound, costUsdTotal });
  };

  let noImproveStreak = 0;

  for (let round = 1; round <= maxRounds; round++) {
    onEvent({ type: "round:start", round, maxRounds });

    const ev = await runFinalEvaluation(router, store, runId, { minSeverity, criteria: options.criteria });
    await store.save(runId, `refine-r${round}-review.json`, ev.rawReviewJson);
    await store.save(runId, `refine-r${round}-review.md`, buildReviewSummary(ev.review));

    const roundMeta: RefineRoundMeta = {
      round,
      evaluation: {
        provider: ev.provider,
        model: ev.model,
        elapsedMs: ev.elapsedMs,
        costUsd: ev.costUsd,
        truncated: ev.truncated,
        issueCount: ev.issueCount,
        score: ev.score,
        approved: ev.approved,
      },
      revision: null,
      costUsdTotal: ev.costUsd ?? 0,
    };
    refineState.rounds.push(roundMeta);
    await persist(refineState);
    onEvent({
      type: "eval:done",
      round,
      provider: ev.provider,
      model: ev.model,
      elapsedMs: ev.elapsedMs,
      costUsd: ev.costUsd,
      inputTokens: ev.inputTokens,
      outputTokens: ev.outputTokens,
      truncated: ev.truncated,
      issueCount: ev.issueCount,
      score: ev.score,
      minSeverity,
    });

    // 停止判定（順序厳守: 成功条件 > regressed > stalled > max-rounds）。
    if (until === "clean" && ev.issueCount === 0) {
      await finalize("clean");
      break;
    }
    if (until === "approved" && ev.approved === true) {
      await finalize("approved");
      break;
    }
    if (round >= 2) {
      const prevScore = refineState.rounds[round - 2].evaluation.score;
      if (isRefineRegression(prevScore, ev.score)) {
        await finalize("regressed");
        break;
      }
      if (isRefineImprovement(prevScore, ev.score)) {
        noImproveStreak = 0;
      } else {
        noImproveStreak += 1;
        if (noImproveStreak >= REFINE_STALL_STREAK) {
          await finalize("stalled");
          break;
        }
      }
    }
    if (round === maxRounds) {
      await finalize("max-rounds");
      break;
    }

    // 次ラウンドの instruction を生成（approved モードは全指摘、clean モードは minSeverity）。
    const sev: Severity = until === "approved" ? "suggestion" : minSeverity;
    const filtered = ev.review.issues.filter((issue) => severityRank[issue.severity] >= severityRank[sev]);
    if (filtered.length === 0) {
      await finalize("no-instruction");
      break;
    }
    const instruction = buildRevisionInstruction(filtered);
    await store.save(runId, `refine-r${round}-instruction.md`, instruction);

    // 修正前スナップショットを退避してから revise（revise 側の final.bak.md 退避はスキップ）。
    const beforeFile = `refine-r${round}-before.md`;
    await store.save(runId, beforeFile, await store.read(runId, "final.md"));
    const rev = await reviseQiitaFinal(router, store, runId, instruction, noop, { backupTo: null });

    roundMeta.revision = {
      provider: rev.provider,
      model: rev.model,
      elapsedMs: rev.elapsedMs,
      costUsd: rev.costUsd,
      truncated: rev.truncated,
      warnings: rev.warnings,
      beforeFile,
    };
    roundMeta.costUsdTotal = (ev.costUsd ?? 0) + (rev.costUsd ?? 0);
    await persist(refineState);
    onEvent({
      type: "revise:done",
      round,
      provider: rev.provider,
      model: rev.model,
      elapsedMs: rev.elapsedMs,
      costUsd: rev.costUsd,
      inputTokens: rev.inputTokens,
      outputTokens: rev.outputTokens,
      truncated: rev.truncated,
      warnings: rev.warnings,
    });
  }

  let finalText: string | undefined;
  try {
    finalText = await store.read(runId, "final.md");
  } catch {
    finalText = undefined;
  }

  return {
    runId,
    finalText,
    // ループは必ず finalize を通って break するため stoppedReason は確定している。
    stoppedReason: stoppedReason ?? "max-rounds",
    rounds: refineState.rounds.length,
    costUsdTotal: refineState.rounds.reduce((sum, r) => sum + r.costUsdTotal, 0),
  };
}

// 価格が取れた分（costUsd が定義された evaluation/revision）のみ合算する。
// meta の costUsdTotal は 0 寄せ数値だが、ユーザー向け summary は実額のみ表示し、不明なら n/a（CLI stderr と同方針）。
function knownCost(parts: Array<number | undefined>): { value: number; known: boolean } {
  const defined = parts.filter((c): c is number => c !== undefined);
  return { value: defined.reduce((sum, c) => sum + c, 0), known: defined.length > 0 };
}

function buildRefineSummary(refine: RefineMeta, reason: RefineStoppedReason): string {
  const totalCost = knownCost(refine.rounds.flatMap((r) => [r.evaluation.costUsd, r.revision?.costUsd]));
  const lines = [
    "# refine サマリ",
    "",
    `- 停止理由: ${reason}`,
    `- ラウンド数: ${refine.rounds.length}`,
    `- min-severity: ${refine.minSeverity} / until: ${refine.until}`,
    `- 概算コスト合計（実額のみ）: ${totalCost.known ? `~$${totalCost.value.toFixed(4)}` : "n/a"}`,
    "",
    "## ラウンド推移",
    "",
    "| round | score | issues>=min | approved | revised | cost |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of refine.rounds) {
    const approved = r.evaluation.approved === undefined ? "n/a" : String(r.evaluation.approved);
    const revised = r.revision ? "yes" : "no";
    const cost = knownCost([r.evaluation.costUsd, r.revision?.costUsd]);
    lines.push(
      `| ${r.round} | ${r.evaluation.score} | ${r.evaluation.issueCount} | ${approved} | ${revised} | ${cost.known ? `~$${cost.value.toFixed(4)}` : "n/a"} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}

function buildReviewSummary(review: ReviewResultJson): string {
  const order: Severity[] = ["critical", "major", "minor", "suggestion"];
  const countLine = order.map((sev) => `${sev}: ${review.issues.filter((i) => i.severity === sev).length}`).join(" / ");
  const verdict = review.approved === true ? "approved ✅" : review.approved === false ? "要修正 ⚠️" : "n/a";

  const lines = [
    "# レビューサマリ",
    "",
    `- 判定: ${verdict}`,
    `- 指摘件数: ${countLine}（合計 ${review.issues.length}）`,
    "",
  ];

  if (review.summary) {
    lines.push("## 概要", "", review.summary, "");
  }

  lines.push("## 指摘一覧", "");
  if (review.issues.length === 0) {
    lines.push("指摘はありません。", "");
  } else {
    for (const sev of order) {
      const items = review.issues.filter((issue) => issue.severity === sev);
      if (items.length === 0) {
        continue;
      }
      lines.push(`### ${sev}`);
      for (const issue of items) {
        const loc = issue.location ? `（${issue.location}）` : "";
        lines.push(`- **問題${loc}**: ${issue.problem}`);
        lines.push(`  - 推奨: ${issue.recommendation}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function buildRevisionInstruction(issues: ReviewIssue[]): string {
  const lines = ["# 修正指示（評価結果から自動生成 / 要確認）", ""];
  const order: Severity[] = ["critical", "major", "minor", "suggestion"];

  for (const severity of order) {
    const items = issues.filter((issue) => issue.severity === severity);
    if (items.length === 0) {
      continue;
    }
    lines.push(`## ${severity}`);
    for (const issue of items) {
      const loc = issue.location ? `（${issue.location}）` : "";
      lines.push(`- 問題${loc}: ${issue.problem}`);
      lines.push(`  - 推奨: ${issue.recommendation}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function rerunQiitaReview(
  router: ModelRouter,
  store: RunStore,
  runId: string,
  onEvent: WorkflowReporter = noop
): Promise<QiitaWorkflowResult> {
  await assertNotImported(store, runId, "review");
  const meta = await store.readMeta(runId);
  meta.steps.review = { status: "pending" };
  meta.steps.final = { status: "pending" };
  await store.writeMeta(meta);
  return runQiitaArticle(router, store, runId, "review", onEvent);
}

export async function runQiitaArticle(
  router: ModelRouter,
  store: RunStore,
  runId: string,
  startAt?: QiitaStepName,
  onEvent: WorkflowReporter = noop
): Promise<QiitaWorkflowResult> {
  const meta = await store.readMeta(runId);
  const platform = meta.platform ?? DEFAULT_PLATFORM;
  const style = meta.style;
  const startIndex = startAt ? qiitaSteps.findIndex((step) => step.name === startAt) : 0;
  const total = qiitaSteps.length;

  for (const [index, step] of qiitaSteps.entries()) {
    const position = index + 1;

    if (startIndex > 0 && index < startIndex) {
      onEvent({ type: "step:skip", index: position, total, name: step.name });
      continue;
    }

    const currentMeta = await store.readMeta(runId);
    if (currentMeta.steps[step.name]?.status === "done") {
      onEvent({ type: "step:skip", index: position, total, name: step.name });
      continue;
    }

    onEvent({ type: "step:start", index: position, total, name: step.name, task: step.task });
    const input = await step.buildInput({ topic: meta.topic, platform, style, runId, store });
    const response = await router.run(toModelRequest(step, input));
    // スキーマ無し（本文）工程は、モデルが全体を ``` で囲んだ場合に剥がす。スキーマ工程は検証済みJSONなので対象外。
    const isProse = !step.schemaName;
    const text = isProse ? stripWrappingCodeFence(response.text) : response.text;
    await store.save(runId, step.file, text);
    await store.markDone(runId, step.name, step.file);
    // brief から投稿用メタ（タイトル・タグ）を meta へ写し、export の front-matter 生成に使う。
    if (step.name === "brief") {
      try {
        const brief = JSON.parse(text) as { title?: string; tags?: string[] };
        const briefMeta = await store.readMeta(runId);
        if (brief.title) {
          briefMeta.articleTitle = brief.title;
        }
        if (Array.isArray(brief.tags)) {
          briefMeta.tags = brief.tags;
        }
        await store.writeMeta(briefMeta);
      } catch {
        // schema 検証済みなので通常は到達しない。失敗しても本体フローは止めない。
      }
    }
    // final.md を書いた final step（rewrite）のモデルを記録（markDone の後）。
    if (step.name === "final") {
      await store.setFinalAuthorModel(runId, { provider: response.provider, model: response.model });
    }
    onEvent({
      type: "step:done",
      index: position,
      total,
      name: step.name,
      provider: response.provider,
      model: response.model,
      elapsedMs: response.elapsedMs,
      costUsd: response.usage?.costUsd,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
      truncated: response.truncated,
      warnings: isProse ? detectWrapText(text) : undefined,
    });
  }

  let finalText: string | undefined;
  try {
    finalText = await store.read(runId, "final.md");
  } catch {
    finalText = undefined;
  }

  return { runId, finalText };
}

export function createRunId(topic: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  return `${date}-${slug || "article"}`;
}
