import { describe, expect, it } from "vitest";
import { RunLogger } from "../../src/logger/RunLogger";
import type { ModelProvider, ProviderRequest, ProviderResponse } from "../../src/providers/ModelProvider";
import { ModelRouter } from "../../src/router/ModelRouter";
import type { ModelTask, RouterConfig } from "../../src/router/types";
import { RunStore } from "../../src/storage/RunStore";
import { tmpLogPath, tmpRunRoot } from "../helpers/tmp";
import {
  createQiitaArticle,
  evaluateQiitaFinal,
  refineQiitaFinal,
  rerunQiitaReview,
  resumeQiitaArticle,
  reviseQiitaFinal,
  runFinalEvaluation,
} from "../../src/workflows/createQiitaArticle";

describe("Qiita workflow", () => {
  it("creates an article run and skips completed steps on resume", async () => {
    const provider = new WorkflowProvider();
    const runId = `test-workflow-${Date.now()}`;
    const router = new ModelRouter(
      { mock: provider },
      workflowConfig(),
      new RunLogger(tmpLogPath())
    );
    const store = new RunStore(tmpRunRoot());

    await createQiitaArticle(router, store, "topic", { runId });
    const firstCallCount = provider.calls.length;
    await resumeQiitaArticle(router, store, runId);

    const final = await store.read(runId, "final.md");
    const meta = await store.readMeta(runId);

    expect(final).toContain("# Final");
    expect(meta.steps.final.status).toBe("done");
    expect(provider.calls).toHaveLength(firstCallCount);
  });

  it("rejects resume and review on an imported run", async () => {
    const router = new ModelRouter({ mock: new WorkflowProvider() }, workflowConfig(), new RunLogger(tmpLogPath()));
    const store = new RunStore(tmpRunRoot());
    const runId = `test-imported-${Date.now()}`;

    const meta = await store.create(runId, "topic", ["final"]);
    meta.imported = true;
    await store.writeMeta(meta);
    await store.save(runId, "final.md", "# Imported\n本文\n");

    await expect(resumeQiitaArticle(router, store, runId)).rejects.toThrow(/import run/);
    await expect(rerunQiitaReview(router, store, runId)).rejects.toThrow(/import run/);
  });

  it("uses the configured platform in step prompts and persists it in meta", async () => {
    const provider = new WorkflowProvider();
    const runId = `test-platform-${Date.now()}`;
    const router = new ModelRouter({ mock: provider }, workflowConfig(), new RunLogger(tmpLogPath()));
    const store = new RunStore(tmpRunRoot());

    await createQiitaArticle(router, store, "topic", { runId, platform: "Zenn" });

    const meta = await store.readMeta(runId);
    expect(meta.platform).toBe("Zenn");

    // brief プロンプトに platform 名が反映されている
    const briefPrompt = provider.calls[0]?.input ?? "";
    expect(briefPrompt).toContain("Zenn記事");
    expect(briefPrompt).not.toContain("Qiita");
  });

  it("injects the profile style into the draft prompt and persists it in meta", async () => {
    const provider = new WorkflowProvider();
    const runId = `test-style-${Date.now()}`;
    const router = new ModelRouter({ mock: provider }, workflowConfig(), new RunLogger(tmpLogPath()));
    const store = new RunStore(tmpRunRoot());

    await createQiitaArticle(router, store, "topic", {
      runId,
      platform: "Zenn",
      style: "Zennの作法に従う。:::message を使う。",
      profile: "zenn",
    });

    const meta = await store.readMeta(runId);
    expect(meta.style).toContain(":::message");
    expect(meta.profile).toBe("zenn");

    // draft 工程（schemaName 無し）のプロンプトに作法が注入されている
    const draftCall = provider.calls.find((c) => c.input.includes("向けMarkdown本文"));
    expect(draftCall?.input).toContain("作法:");
    expect(draftCall?.input).toContain(":::message");
  });

  it("defaults platform to Qiita when not specified", async () => {
    const provider = new WorkflowProvider();
    const runId = `test-platform-default-${Date.now()}`;
    const router = new ModelRouter({ mock: provider }, workflowConfig(), new RunLogger(tmpLogPath()));
    const store = new RunStore(tmpRunRoot());

    await createQiitaArticle(router, store, "topic", { runId });

    const meta = await store.readMeta(runId);
    expect(meta.platform).toBe("Qiita");
    expect(provider.calls[0]?.input ?? "").toContain("Qiita記事");
  });

  it("revises final.md, backs up the previous version, and keeps meta consistent", async () => {
    const provider = new WorkflowProvider();
    const runId = `test-revise-${Date.now()}`;
    const router = new ModelRouter(
      { mock: provider },
      workflowConfig(),
      new RunLogger(tmpLogPath())
    );
    const store = new RunStore(tmpRunRoot());

    await createQiitaArticle(router, store, "topic", { runId });
    const before = await store.read(runId, "final.md");

    provider.nextRewrite = "# Final v2\n";
    const result = await reviseQiitaFinal(router, store, runId, "アインシュタインのトピックを追加");

    const after = await store.read(runId, "final.md");
    const backup = await store.read(runId, "final.bak.md");
    const meta = await store.readMeta(runId);

    expect(after).toContain("# Final v2");
    expect(backup).toBe(before);
    expect(result.finalText).toContain("# Final v2");
    expect(meta.steps.final.status).toBe("done");
  });

  it("strips a whole-document code fence from revised final.md", async () => {
    const provider = new WorkflowProvider();
    const runId = `test-fence-${Date.now()}`;
    const router = new ModelRouter({ mock: provider }, workflowConfig(), new RunLogger(tmpLogPath()));
    const store = new RunStore(tmpRunRoot());

    await createQiitaArticle(router, store, "topic", { runId });

    provider.nextRewrite = "```markdown\n# Final v2\n\nbody\n```";
    const result = await reviseQiitaFinal(router, store, runId, "fix it");

    const final = await store.read(runId, "final.md");
    expect(final).not.toContain("```");
    expect(final).toContain("# Final v2");
    expect(result.finalText).not.toContain("```");
  });

  it("evaluates final.md and writes a severity-filtered revision instruction", async () => {
    const provider = new WorkflowProvider();
    const runId = `test-evaluate-${Date.now()}`;
    const router = new ModelRouter(
      { mock: provider },
      workflowConfig(),
      new RunLogger(tmpLogPath())
    );
    const store = new RunStore(tmpRunRoot());

    await createQiitaArticle(router, store, "topic", { runId });

    provider.nextReview = JSON.stringify({
      summary: "needs work",
      issues: [
        { severity: "major", problem: "P-major", recommendation: "R-major" },
        { severity: "suggestion", problem: "P-suggestion", recommendation: "R-suggestion" },
      ],
      approved: false,
    });

    const result = await evaluateQiitaFinal(router, store, runId, { minSeverity: "major" });

    expect(result.issueCount).toBe(1);
    expect(result.approved).toBe(false);
    expect(result.instructionFile).toBe("revise-instruction.md");

    const instruction = await store.read(runId, "revise-instruction.md");
    expect(instruction).toContain("P-major");
    expect(instruction).not.toContain("P-suggestion");

    const review = JSON.parse(await store.read(runId, "final-review.json"));
    expect(review.issues).toHaveLength(2);

    // 人が読むサマリは全指摘（フィルタ前）を含む
    expect(result.reviewSummaryFile).toBe("final-review.md");
    const summary = await store.read(runId, "final-review.md");
    expect(summary).toContain("# レビューサマリ");
    expect(summary).toContain("要修正 ⚠️");
    expect(summary).toContain("P-major");
    expect(summary).toContain("P-suggestion");
  });

  it("removes a stale revise-instruction.md when a later evaluation has no in-scope issues", async () => {
    const provider = new WorkflowProvider();
    const runId = `test-eval-stale-${Date.now()}`;
    const router = new ModelRouter(
      { mock: provider },
      workflowConfig(),
      new RunLogger(tmpLogPath())
    );
    const store = new RunStore(tmpRunRoot());

    await createQiitaArticle(router, store, "topic", { runId });

    provider.nextReview = JSON.stringify({
      summary: "x",
      issues: [{ severity: "major", problem: "P", recommendation: "R" }],
      approved: false,
    });

    // 1回目: major を含め、major フィルタ → 指示ファイル生成
    const first = await evaluateQiitaFinal(router, store, runId, { minSeverity: "major" });
    expect(first.instructionFile).toBe("revise-instruction.md");
    await expect(store.read(runId, "revise-instruction.md")).resolves.toContain("P");

    // 2回目: 同じ issues だが critical フィルタ → 対象0件 → 古い指示は削除される
    const second = await evaluateQiitaFinal(router, store, runId, { minSeverity: "critical" });
    expect(second.issueCount).toBe(0);
    expect(second.instructionFile).toBeUndefined();
    await expect(store.read(runId, "revise-instruction.md")).rejects.toThrow();
  });

  it("routes final_review to its configured judge provider", async () => {
    const writer = new WorkflowProvider();
    const judge = new WorkflowProvider();
    const runId = `test-eval-judge-${Date.now()}`;
    const config = workflowConfig();
    config.tasks.final_review = { primary: { provider: "judge", model: "j" } };
    const router = new ModelRouter(
      { mock: writer, judge },
      config,
      new RunLogger(tmpLogPath())
    );
    const store = new RunStore(tmpRunRoot());

    await createQiitaArticle(router, store, "topic", { runId });
    judge.nextReview = JSON.stringify({ summary: "x", issues: [], approved: true });

    await evaluateQiitaFinal(router, store, runId);

    expect(judge.calls).toHaveLength(1);
    expect(writer.calls.length).toBeGreaterThan(0);
  });
});

describe("refine loop", () => {
  const issue = (severity: string) => ({ severity, problem: `P-${severity}`, recommendation: `R-${severity}` });
  const review = (issues: unknown[], approved?: boolean) => JSON.stringify({ summary: "s", issues, approved });

  async function setupRun(store: RunStore, runId: string, finalText = "# Article\n"): Promise<void> {
    await store.create(runId, "topic", ["final"], "Qiita");
    await store.save(runId, "final.md", finalText);
    await store.markDone(runId, "final", "final.md");
  }

  function makeRouter(provider: WorkflowProvider): ModelRouter {
    return new ModelRouter({ mock: provider }, workflowConfig(), new RunLogger(tmpLogPath()));
  }

  const reviewCalls = (provider: WorkflowProvider) =>
    provider.calls.filter((c) => c.responseFormat?.schemaName === "ReviewResult").length;
  const rewriteCalls = (provider: WorkflowProvider) => provider.calls.length - reviewCalls(provider);

  it("refines until clean, records meta, and keeps per-revise artifacts", async () => {
    const provider = new WorkflowProvider();
    provider.reviewQueue.push(review([issue("major")], false), review([], true));
    const runId = `refine-clean-${Date.now()}`;
    const store = new RunStore(tmpRunRoot());
    await setupRun(store, runId);

    const result = await refineQiitaFinal(makeRouter(provider), store, runId, { maxRounds: 3, minSeverity: "major" });

    expect(result.stoppedReason).toBe("clean");
    expect(result.rounds).toBe(2);
    expect(reviewCalls(provider)).toBe(2);
    expect(rewriteCalls(provider)).toBe(1);

    // round1 は revise したので before/instruction が残り、round2 は eval-only なので残らない
    await expect(store.read(runId, "refine-r1-before.md")).resolves.toContain("# Article");
    await expect(store.read(runId, "refine-r1-instruction.md")).resolves.toContain("P-major");
    await expect(store.read(runId, "refine-r2-before.md")).rejects.toThrow();
    await expect(store.read(runId, "refine-r2-instruction.md")).rejects.toThrow();

    // raw 保存: refine-r1-review.json は parse→再 stringify せず response.text をそのまま保存
    expect(JSON.parse(await store.read(runId, "refine-r1-review.json")).issues[0].problem).toBe("P-major");

    // meta（完了）
    const meta = await store.readMeta(runId);
    expect(meta.refine?.stoppedReason).toBe("clean");
    expect(meta.refine?.rounds).toHaveLength(2);
    expect(meta.refine?.rounds[0].revision).not.toBeNull();
    expect(meta.refine?.rounds[1].revision).toBeNull();
    expect(meta.refine?.finalScore).toBe(0);

    // 完了 ⟹ 成果物が揃う。トップレベル revise-instruction.md は作らない
    await expect(store.read(runId, "final-review.json")).resolves.toContain("issues");
    const summary = await store.read(runId, "refine-summary.md");
    expect(summary).toContain("停止理由: clean");
    // 価格未設定モデル（mock は usage 無し）では概算コストは n/a 表示（$0.0000 と誤読させない）
    expect(summary).toContain("概算コスト合計（実額のみ）: n/a");
    await expect(store.read(runId, "revise-instruction.md")).rejects.toThrow();
  });

  it("saves review json identically to article:evaluate (no re-stringify by refine)", async () => {
    const reviewStr = review([issue("major")], false);
    const store = new RunStore(tmpRunRoot());

    const pEval = new WorkflowProvider();
    pEval.reviewQueue.push(reviewStr);
    const runEval = `refine-eq-eval-${Date.now()}`;
    await setupRun(store, runEval);
    await evaluateQiitaFinal(makeRouter(pEval), store, runEval, { minSeverity: "major" });

    const pRefine = new WorkflowProvider();
    pRefine.reviewQueue.push(reviewStr, review([], true)); // round1 同一、round2 で clean 停止
    const runRefine = `refine-eq-refine-${Date.now()}`;
    await setupRun(store, runRefine);
    await refineQiitaFinal(makeRouter(pRefine), store, runRefine, { maxRounds: 3, minSeverity: "major" });

    const fromEval = await store.read(runEval, "final-review.json");
    const fromRefine = await store.read(runRefine, "refine-r1-review.json");
    expect(fromRefine).toBe(fromEval);
  });

  it("stops immediately when the first evaluation is already clean (no revise)", async () => {
    const provider = new WorkflowProvider();
    provider.reviewQueue.push(review([], true));
    const runId = `refine-initial-clean-${Date.now()}`;
    const store = new RunStore(tmpRunRoot());
    await setupRun(store, runId);

    const result = await refineQiitaFinal(makeRouter(provider), store, runId, { maxRounds: 3, minSeverity: "major" });

    expect(result.stoppedReason).toBe("clean");
    expect(result.rounds).toBe(1);
    expect(rewriteCalls(provider)).toBe(0);
  });

  it("stops at max-rounds when never clean", async () => {
    const provider = new WorkflowProvider();
    provider.reviewQueue.push(review([issue("major")], false), review([issue("major")], false));
    const runId = `refine-max-${Date.now()}`;
    const store = new RunStore(tmpRunRoot());
    await setupRun(store, runId);

    const result = await refineQiitaFinal(makeRouter(provider), store, runId, { maxRounds: 2, minSeverity: "major" });

    expect(result.stoppedReason).toBe("max-rounds");
    expect(result.rounds).toBe(2);
    expect(reviewCalls(provider)).toBe(2);
    expect(rewriteCalls(provider)).toBe(1);
  });

  it("stops with stalled when score does not improve for two rounds", async () => {
    const provider = new WorkflowProvider();
    provider.reviewQueue.push(
      review([issue("major")], false),
      review([issue("major")], false),
      review([issue("major")], false)
    );
    const runId = `refine-stalled-${Date.now()}`;
    const store = new RunStore(tmpRunRoot());
    await setupRun(store, runId);

    const result = await refineQiitaFinal(makeRouter(provider), store, runId, { maxRounds: 5, minSeverity: "major" });

    expect(result.stoppedReason).toBe("stalled");
    expect(result.rounds).toBe(3);
  });

  it("stops with regressed when score worsens significantly", async () => {
    const provider = new WorkflowProvider();
    provider.reviewQueue.push(
      review([issue("major")], false),
      review([issue("major"), issue("major"), issue("major")], false)
    );
    const runId = `refine-regressed-${Date.now()}`;
    const store = new RunStore(tmpRunRoot());
    await setupRun(store, runId);

    const result = await refineQiitaFinal(makeRouter(provider), store, runId, { maxRounds: 5, minSeverity: "major" });

    expect(result.stoppedReason).toBe("regressed");
    expect(result.rounds).toBe(2);
  });

  it("prefers a success stop (clean) over regressed when min-severity issues hit zero", async () => {
    const provider = new WorkflowProvider();
    provider.reviewQueue.push(
      review([issue("major")], false), // r1 score 4, 1 major
      review(Array.from({ length: 10 }, () => issue("suggestion")), false) // r2 score 10, 0 major → clean wins
    );
    const runId = `refine-prefer-clean-${Date.now()}`;
    const store = new RunStore(tmpRunRoot());
    await setupRun(store, runId);

    const result = await refineQiitaFinal(makeRouter(provider), store, runId, { maxRounds: 5, minSeverity: "major" });

    expect(result.stoppedReason).toBe("clean");
    expect(result.rounds).toBe(2);
  });

  it("stops with no-instruction in approved mode when the judge gives no issues", async () => {
    const provider = new WorkflowProvider();
    provider.reviewQueue.push(review([], false));
    const runId = `refine-no-instr-${Date.now()}`;
    const store = new RunStore(tmpRunRoot());
    await setupRun(store, runId);

    const result = await refineQiitaFinal(makeRouter(provider), store, runId, {
      maxRounds: 3,
      minSeverity: "major",
      until: "approved",
    });

    expect(result.stoppedReason).toBe("no-instruction");
    expect(result.rounds).toBe(1);
    expect(rewriteCalls(provider)).toBe(0);
  });

  it("cleans up stale refine artifacts beyond the current max-rounds", async () => {
    const provider = new WorkflowProvider();
    provider.reviewQueue.push(review([], true));
    const runId = `refine-cleanup-${Date.now()}`;
    const store = new RunStore(tmpRunRoot());
    await setupRun(store, runId);
    // 前回 maxRoundsAtRun=5 の名残（meta 追記前クラッシュ相当の orphan）
    await store.save(runId, "refine-r4-review.json", "old");
    const m = await store.readMeta(runId);
    m.refine = { rounds: [], minSeverity: "major", until: "clean", maxRoundsAtRun: 5 };
    await store.writeMeta(m);

    await refineQiitaFinal(makeRouter(provider), store, runId, { maxRounds: 3 });

    await expect(store.read(runId, "refine-r4-review.json")).rejects.toThrow();
  });

  it("removes a stale top-level revise-instruction.md at start and never recreates it", async () => {
    const provider = new WorkflowProvider();
    provider.reviewQueue.push(review([], true));
    const runId = `refine-stale-instr-${Date.now()}`;
    const store = new RunStore(tmpRunRoot());
    await setupRun(store, runId);
    await store.save(runId, "revise-instruction.md", "STALE");

    await refineQiitaFinal(makeRouter(provider), store, runId, { maxRounds: 3 });

    await expect(store.read(runId, "revise-instruction.md")).rejects.toThrow();
  });

  it("runFinalEvaluation writes no files and returns raw json, score, and truncated", async () => {
    const provider = new WorkflowProvider();
    provider.reviewQueue.push(review([issue("major")], false));
    provider.reviewTruncated = true;
    const runId = `refine-eval-core-${Date.now()}`;
    const store = new RunStore(tmpRunRoot());
    await setupRun(store, runId);

    const ev = await runFinalEvaluation(makeRouter(provider), store, runId, { minSeverity: "major" });

    expect(ev.truncated).toBe(true);
    expect(ev.issueCount).toBe(1);
    expect(ev.score).toBe(4);
    expect(ev.rawReviewJson).toContain("P-major");
    // 副作用なし
    await expect(store.read(runId, "final-review.json")).rejects.toThrow();
    await expect(store.read(runId, "refine-r1-review.json")).rejects.toThrow();
  });

  it("reviseQiitaFinal returns truncated/warnings and skips backup when backupTo is null", async () => {
    const provider = new WorkflowProvider();
    provider.nextRewrite = "以下は改稿版です\n\n# X\n";
    provider.rewriteTruncated = true;
    const runId = `refine-revise-return-${Date.now()}`;
    const store = new RunStore(tmpRunRoot());
    await setupRun(store, runId);

    const rev = await reviseQiitaFinal(makeRouter(provider), store, runId, "fix", () => undefined, {
      backupTo: null,
    });

    expect(rev.truncated).toBe(true);
    expect(rev.warnings?.length ?? 0).toBeGreaterThan(0);
    await expect(store.read(runId, "final.bak.md")).rejects.toThrow();
  });

  it("persists meta incrementally: start is empty, mid is in-progress, end has stoppedReason", async () => {
    const provider = new WorkflowProvider();
    provider.reviewQueue.push(review([issue("major")], false), review([], true));
    const runId = `refine-persist-${Date.now()}`;
    const store = new RunStore(tmpRunRoot());
    await setupRun(store, runId);

    const states: Array<{ rounds: unknown[]; stoppedReason?: string }> = [];
    const orig = store.writeMeta.bind(store);
    store.writeMeta = async (meta) => {
      if (meta.refine) {
        states.push(JSON.parse(JSON.stringify(meta.refine)));
      }
      return orig(meta);
    };

    await refineQiitaFinal(makeRouter(provider), store, runId, { maxRounds: 3, minSeverity: "major" });

    expect(states[0].rounds).toHaveLength(0);
    expect(states[0].stoppedReason).toBeUndefined();
    expect(states.some((s) => s.rounds.length > 0 && s.stoppedReason === undefined)).toBe(true);
    expect(states[states.length - 1].stoppedReason).toBe("clean");
  });
});

class WorkflowProvider implements ModelProvider {
  readonly calls: ProviderRequest[] = [];
  nextRewrite?: string;
  nextReview?: string;
  // refine 用: ラウンドごとに異なる review を返す。先頭から消費する。
  readonly reviewQueue: string[] = [];
  reviewTruncated = false;
  rewriteTruncated = false;

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(request);
    const task = inferTask(request);
    if (task === "rewrite") {
      const text = this.nextRewrite ?? responseForTask(task);
      return { text, truncated: this.rewriteTruncated || undefined };
    }
    if (task === "technical_review") {
      const text = this.reviewQueue.length > 0 ? (this.reviewQueue.shift() as string) : this.nextReview ?? responseForTask(task);
      return { text, truncated: this.reviewTruncated || undefined };
    }
    return { text: responseForTask(task) };
  }
}

function inferTask(request: ProviderRequest): ModelTask {
  if (request.responseFormat?.schemaName === "ArticleBrief") {
    return "article_brief";
  }
  if (request.responseFormat?.schemaName === "ArticleOutline") {
    return "outline";
  }
  if (request.responseFormat?.schemaName === "ReviewResult") {
    return "technical_review";
  }
  if (request.input.includes("レビュー:") || request.input.includes("修正指示:")) {
    return "rewrite";
  }
  return "draft_markdown";
}

function responseForTask(task: ModelTask): string {
  switch (task) {
    case "article_brief":
      return JSON.stringify({
        title: "Brief",
        targetReaders: ["reader"],
        goal: ["goal"],
        mainClaim: "claim",
        sections: [{ heading: "H", points: ["P"] }],
        codeExamples: [{ language: "ts", purpose: "demo" }],
      });
    case "outline":
      return JSON.stringify({
        title: "Outline",
        sections: [{ heading: "H", points: ["P"] }],
      });
    case "technical_review":
      return JSON.stringify({
        summary: "ok",
        issues: [],
        approved: true,
      });
    case "rewrite":
      return "# Final\n";
    default:
      return "# Draft\n";
  }
}

function workflowConfig(): RouterConfig {
  const task = { primary: { provider: "mock", model: "m" } };
  return {
    providers: {},
    prices: {},
    defaults: { timeout_ms: 1000 },
    tasks: {
      article_brief: task,
      outline: task,
      draft_markdown: task,
      technical_review: task,
      final_review: task,
      rewrite: task,
      markdown_format: task,
      title_suggestions: task,
    },
  };
}
