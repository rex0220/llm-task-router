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
  resumeQiitaArticle,
  reviseQiitaFinal,
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

class WorkflowProvider implements ModelProvider {
  readonly calls: ProviderRequest[] = [];
  nextRewrite?: string;
  nextReview?: string;

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(request);
    const task = inferTask(request);
    if (task === "rewrite" && this.nextRewrite !== undefined) {
      return { text: this.nextRewrite };
    }
    if (task === "technical_review" && this.nextReview !== undefined) {
      return { text: this.nextReview };
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
