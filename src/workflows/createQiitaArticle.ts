import { ModelRouter } from "../router/ModelRouter";
import { RunStore } from "../storage/RunStore";
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
  return runQiitaArticle(router, store, runId, undefined, onEvent);
}

export async function reviseQiitaFinal(
  router: ModelRouter,
  store: RunStore,
  runId: string,
  instruction: string,
  onEvent: WorkflowReporter = noop
): Promise<QiitaWorkflowResult> {
  const meta = await store.readMeta(runId);
  const platform = meta.platform ?? DEFAULT_PLATFORM;
  const current = await store.read(runId, "final.md");
  await store.save(runId, "final.bak.md", current);

  const input = [
    `次の${platform}記事を、以下の修正指示に従って改善してください。`,
    "Markdown本文だけを返してください。説明やコードフェンスで全体を囲まないでください。",
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
  onEvent({
    type: "step:done",
    index: 1,
    total: 1,
    name: "revise",
    provider: response.provider,
    model: response.model,
    elapsedMs: response.elapsedMs,
    costUsd: response.usage?.costUsd,
    truncated: response.truncated,
    warnings: detectWrapText(text),
  });
  return { runId, finalText: text };
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

export async function evaluateQiitaFinal(
  router: ModelRouter,
  store: RunStore,
  runId: string,
  options: { minSeverity?: Severity; criteria?: string } = {},
  onEvent: WorkflowReporter = noop
): Promise<EvaluationResult> {
  const minSeverity = options.minSeverity ?? "suggestion";
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

  onEvent({ type: "step:start", index: 1, total: 1, name: "evaluate", task: "final_review" });
  const response = await router.run({ task: "final_review", input, schemaName: "ReviewResult" });
  await store.save(runId, "final-review.json", response.text);
  onEvent({
    type: "step:done",
    index: 1,
    total: 1,
    name: "evaluate",
    provider: response.provider,
    model: response.model,
    elapsedMs: response.elapsedMs,
    costUsd: response.usage?.costUsd,
    truncated: response.truncated,
  });

  const review = JSON.parse(response.text) as ReviewResultJson;

  // 人が読むための全指摘サマリ（severityフィルタなし）。
  await store.save(runId, "final-review.md", buildReviewSummary(review));

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
    onEvent({
      type: "step:done",
      index: position,
      total,
      name: step.name,
      provider: response.provider,
      model: response.model,
      elapsedMs: response.elapsedMs,
      costUsd: response.usage?.costUsd,
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
