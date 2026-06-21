import "dotenv/config";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { assertSafeInputPath, resolveText } from "./cli/inputs";
import { exportFinalArticle } from "./cli/export";
import { importArticle } from "./cli/import";
import { recordPublication } from "./cli/record-publication";
import { writeUpdateDiff } from "./cli/updateDiff";
import { normalizeClaims } from "./cli/claimsNormalize";
import { verifyArtifacts } from "./cli/verifyArtifacts";
import { writeClaimsRecheck } from "./cli/claimsRecheck";
import { getRunStatus } from "./cli/status";
import {
  collectCompletionReportData,
  mergeCompletionReport,
  renderCompletionReport,
  COMPLETION_REPORT_FILE,
  COMPLETION_REPORT_BAK,
} from "./cli/completionReport";
import {
  collectDirectionCheckData,
  directionGateStatus,
  mergeDirectionCheck,
  DIRECTION_CHECK_FILE,
  DIRECTION_CHECK_BAK,
  type DirectionSource,
  type Verdict,
} from "./cli/directionCheck";
import {
  collectFactcheckScope,
  renderFactcheckScope,
  stampSnapshot,
  FACTCHECK_SCOPE_FILE,
  FACTCHECK_SCOPE_JSON,
  type AcceptedAfter,
  type FactcheckScope,
} from "./cli/factcheckScope";
import {
  prepareReferencesBlock,
  replaceMarkedBlock,
  stripLlmReferenceSections,
  SOURCES_BEGIN,
  SOURCES_END,
} from "./cli/references";
import { runEditorialReview, resolveWeakness, parseWeaknessResolution } from "./workflows/editorialReview";
import { initConfig } from "./cli/init";
import { ExportIndex } from "./storage/ExportIndex";
import { loadProfile } from "./workflows/profile";
import { RunLogger } from "./logger/RunLogger";
import { formatDuration } from "./utils/duration";
import { RunProgress, type ProgressEventInput } from "./progress/RunProgress";
import type { ProgressEventStatus } from "./progress/types";
import { createProviders } from "./providers";
import { ModelRouter } from "./router/ModelRouter";
import { loadRouterConfig } from "./router/config";
import { RunStore } from "./storage/RunStore";
import {
  createQiitaArticle,
  createRunId,
  evaluateQiitaFinal,
  refineQiitaFinal,
  rerunQiitaReview,
  resumeQiitaArticle,
  reviseQiitaFinal,
  type RefineEvent,
  type Severity,
  type WorkflowEvent,
} from "./workflows/createQiitaArticle";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

const program = new Command();

program
  .name("llm-task-router")
  .description("Thin ModelRouter CLI for article workflows")
  .version(pkg.version, "-v, --version", "Show the version")
  .showHelpAfterError("(run with --help for usage)");

program
  .command("init")
  .description("Scaffold config/, .env.example, and the editor-in-chief set (.claude/, CLAUDE.md) into the current directory")
  .option("--force", "Overwrite existing files")
  .action(async (options: { force?: boolean }) => {
    const sourceDir = fileURLToPath(new URL("..", import.meta.url));
    const result = await initConfig(process.cwd(), sourceDir, { force: options.force });

    for (const file of result.created) {
      console.log(`created: ${file}`);
    }
    for (const file of result.skipped) {
      console.log(`skipped (exists): ${file}`);
    }
    if (result.skipped.length > 0) {
      console.log("Some files already exist; re-run with --force to overwrite them.");
    }
    console.log("Next: copy .env.example to .env and set your API keys, then edit config/models.yaml.");
  });

program
  .command("article:create")
  .option("--topic <topic>", "Article topic (inline text)")
  .option("--topic-file <path>", "Path to a text file containing the topic / instructions")
  .option("--profile <name>", "Article profile under config/profiles/ (platform + style)", "qiita")
  .option("--platform <name>", "Override the platform label from the profile")
  .option("--run <runId>", "Run id")
  .option("--editor-model <id>", "Editor-in-chief AI model id (e.g. claude-opus-4-8). Fixed at creation, shown in progress.md header")
  .option("--config <path>", "Path to models.yaml", "config/models.yaml")
  .action(
    async (options: {
      topic?: string;
      topicFile?: string;
      profile: string;
      platform?: string;
      run?: string;
      editorModel?: string;
      config: string;
    }) => {
      const topic = await resolveText(options.topic, options.topicFile, "topic", "--topic", "--topic-file");
      const profile = await loadProfile(options.profile);
      const platform = options.platform ?? profile.platform;
      const runIdSeed = options.topicFile ? basename(options.topicFile).replace(/\.[^.]+$/, "") : topic;
      const runId = options.run ?? createRunId(runIdSeed);
      const { router, store } = await createRuntime(options.config);
      const progress = new RunProgress(store, pkg.version);
      const reporter = createProgressReporter();
      const result = await runWithProgress({
        progress,
        runId,
        step: "create",
        task: "create",
        totals: reporter.totals,
        editorModel: options.editorModel,
        output: (r) => `runs/${r.runId}/final.md`,
        run: () =>
          createQiitaArticle(
            router,
            store,
            topic,
            { runId, platform, style: profile.style, profile: options.profile },
            reporter.report
          ),
      });
      reporter.printTotal();
      console.log(`runId: ${result.runId}`);
      console.log(`final: runs/${result.runId}/final.md`);
    }
  );

program
  .command("article:resume")
  .requiredOption("--run <runId>", "Run id")
  .option("--config <path>", "Path to models.yaml", "config/models.yaml")
  .action(async (options: { run: string; config: string }) => {
    const { router, store } = await createRuntime(options.config);
    const progress = new RunProgress(store, pkg.version);
    const reporter = createProgressReporter();
    const result = await runWithProgress({
      progress,
      runId: options.run,
      step: "create",
      task: "resume",
      totals: reporter.totals,
      output: (r) => `runs/${r.runId}/final.md`,
      ensureRun: () => assertRunExists(store, options.run),
      run: () => resumeQiitaArticle(router, store, options.run, reporter.report),
    });
    reporter.printTotal();
    console.log(`runId: ${result.runId}`);
    console.log(`final: runs/${result.runId}/final.md`);
  });

program
  .command("article:review")
  .requiredOption("--run <runId>", "Run id")
  .option("--config <path>", "Path to models.yaml", "config/models.yaml")
  .action(async (options: { run: string; config: string }) => {
    const { router, store } = await createRuntime(options.config);
    const progress = new RunProgress(store, pkg.version);
    const reporter = createProgressReporter();
    const result = await runWithProgress({
      progress,
      runId: options.run,
      step: "create",
      task: "review",
      totals: reporter.totals,
      output: (r) => `runs/${r.runId}/final.md`,
      ensureRun: () => assertRunExists(store, options.run),
      run: () => rerunQiitaReview(router, store, options.run, reporter.report),
    });
    reporter.printTotal();
    console.log(`runId: ${result.runId}`);
    console.log(`final: runs/${result.runId}/final.md`);
  });

program
  .command("article:revise")
  .requiredOption("--run <runId>", "Run id")
  .option("--instruction <text>", "Revision instruction for final.md (inline text)")
  .option("--instruction-file <path>", "Path to a text file containing the revision instruction")
  .option("--config <path>", "Path to models.yaml", "config/models.yaml")
  .action(async (options: { run: string; instruction?: string; instructionFile?: string; config: string }) => {
    const instruction = await resolveText(
      options.instruction,
      options.instructionFile,
      "instruction",
      "--instruction",
      "--instruction-file"
    );
    const { router, store } = await createRuntime(options.config);
    const progress = new RunProgress(store, pkg.version);
    const reporter = createProgressReporter();
    const result = await runWithProgress({
      progress,
      runId: options.run,
      step: "revise",
      task: "rewrite",
      totals: reporter.totals,
      output: (r) => `runs/${r.runId}/final.md`,
      ensureRun: () => assertRunExists(store, options.run),
      run: () => reviseQiitaFinal(router, store, options.run, instruction, reporter.report),
    });
    reporter.printTotal();
    console.log(`runId: ${result.runId}`);
    console.log(`final: runs/${result.runId}/final.md (previous: runs/${result.runId}/final.bak.md)`);
  });

program
  .command("article:import")
  .description("Import an existing Markdown article into a run so evaluate/refine/revise can brush it up")
  .requiredOption("--from <path>", "Path to the existing Markdown article (becomes final.md)")
  .option("--run <runId>", "Run id (default: derived from the file name)")
  .option("--topic <topic>", "Article topic recorded in meta (default: first H1, else runId)")
  .option("--topic-file <path>", "Path to a text file containing the topic")
  .option("--profile <name>", "Article profile under config/profiles/ (platform + style + criteria)", "qiita")
  .option("--platform <name>", "Override the platform label from the profile")
  .option("--criteria-file <path>", "Brush-up brief saved as runs/<runId>/brushup-criteria.md (auto-used by evaluate)")
  .option("--supersedes <runId>", "Previous run this update supersedes (recorded in meta.lineage)")
  .option("--root <runId>", "Root run of the lineage (first version, recorded in meta.lineage)")
  .option("--tags <list>", "Comma-separated publish tags (else inherited from --supersedes run)")
  .option("--force", "Replace an existing run with the same id as an import run")
  .action(
    async (options: {
      from: string;
      run?: string;
      topic?: string;
      topicFile?: string;
      profile: string;
      platform?: string;
      criteriaFile?: string;
      supersedes?: string;
      root?: string;
      tags?: string;
      force?: boolean;
    }) => {
      const topic =
        options.topic !== undefined || options.topicFile !== undefined
          ? await resolveText(options.topic, options.topicFile, "topic", "--topic", "--topic-file")
          : undefined;
      const criteria =
        options.criteriaFile !== undefined
          ? await resolveText(undefined, options.criteriaFile, "criteria", "--criteria", "--criteria-file")
          : undefined;

      const store = new RunStore();
      const tags = options.tags
        ?.split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const result = await importArticle(store, {
        from: options.from,
        runId: options.run,
        topic,
        profile: options.profile,
        platform: options.platform,
        criteria,
        supersedesRunId: options.supersedes,
        rootRunId: options.root,
        tags,
        force: options.force,
      });

      console.log(`imported: runs/${result.runId}/final.md (from ${options.from}${result.replacedRun ? ", replaced" : ""})`);
      console.log(`runId: ${result.runId}`);
      if (result.frontMatterWarning) {
        process.stderr.write(
          "Warning: front-matter らしきブロックを検出しました。Qiita は本文に front-matter を含めない方針です（自動除去はしていません）。\n"
        );
      }
      console.log(`next: llm-task-router article:evaluate --run ${result.runId} --min-severity minor`);
    }
  );

program
  .command("article:export")
  .requiredOption("--run <runId>", "Run id")
  .requiredOption("--out <path>", "Destination path for the final article")
  .option("--force", "Overwrite the destination if it already exists")
  .option("--front-matter", "Prepend publish front-matter (title/tags) for Qiita/Zenn and move the body H1 into it")
  .option(
    "--note <text>",
    "Approval / condition-resolution note recorded in the export progress event (e.g. user approval, conditional-GO resolution)"
  )
  .action(async (options: { run: string; out: string; force?: boolean; frontMatter?: boolean; note?: string }) => {
    const store = new RunStore();
    const dest = await exportFinalArticle(store, options.run, options.out, {
      force: options.force,
      frontMatter: options.frontMatter,
    });
    // --note は「条件付き GO の条件解決・ユーザー承認」を台帳に残すための監査欄（任意）。
    await recordProgress(store, options.run, { step: "export", status: "done", output: dest, note: options.note });
    console.log(`exported: ${dest}${options.frontMatter ? " (with front-matter)" : ""}`);
  });

program
  .command("article:update-diff")
  .description("Generate update-diff.md / changed-sections.json from update-base.md vs final.md")
  .requiredOption("--run <runId>", "Run id")
  .action(async (options: { run: string }) => {
    const store = new RunStore();
    const result = await writeUpdateDiff(store, options.run);
    console.log(`runId: ${options.run}`);
    console.log(`diff: runs/${options.run}/update-diff.md (+${result.added} / -${result.removed} lines)`);
    console.log(`sections: runs/${options.run}/changed-sections.json (${result.changedSections.length} changed)`);
  });

program
  .command("article:claims-normalize")
  .description("Normalize idless claims.raw.json/sources.raw.json into id-stamped claims.json/sources.json (assigns CNNN/SNNN, updates the ledger)")
  .requiredOption("--run <runId>", "Run id")
  .option("--scope <mode>", "Observation scope: full | diff (full lets missing claims become removed)", "full")
  .action(async (options: { run: string; scope: string }) => {
    const scope = options.scope === "diff" ? "diff" : options.scope === "full" ? "full" : null;
    if (scope === null) {
      throw new Error(`Invalid --scope: ${options.scope} (expected full | diff)`);
    }
    const store = new RunStore();
    const summary = await normalizeClaims(store, options.run, scope);
    await recordProgress(store, summary.runId, {
      step: "claims-normalize",
      status: "done",
      output: `runs/${summary.runId}/claims.json`,
      note: `${summary.present} present, blocking ${summary.blocking} (scope ${summary.scope})`,
    });
    console.log(`runId: ${summary.runId}`);
    console.log(
      `claims: runs/${summary.runId}/claims.json (${summary.present} present, ${summary.removed} removed; round ${summary.round}, scope ${summary.scope})`
    );
    console.log(`sources: runs/${summary.runId}/sources.json (${summary.sources})`);
    console.log(`blocking: ${summary.blocking}`);
  });

program
  .command("article:claims-recheck")
  .description("Select claims in changed sections (update-diff) for focused re-verification, prioritizing stale-prone types")
  .requiredOption("--run <runId>", "Run id")
  .action(async (options: { run: string }) => {
    const store = new RunStore();
    const result = await writeClaimsRecheck(store, options.run);
    console.log(`runId: ${result.runId}`);
    if (result.claimsSourceRunId !== result.runId) {
      console.log(`claims source: ${result.claimsSourceRunId} (supersedes 元の版)`);
    }
    console.log(
      `recheck: runs/${result.runId}/claims-recheck.md (${result.candidates.length} claims in ${result.changedSections} changed sections)`
    );
  });

program
  .command("article:verify-artifacts")
  .description("Check that pre-publication artifacts are present, schema-valid, and free of blocking claims (no network)")
  .requiredOption("--run <runId>", "Run id")
  .action(async (options: { run: string }) => {
    const store = new RunStore();
    const result = await verifyArtifacts(store, options.run);
    await recordProgress(store, result.runId, {
      step: "verify-artifacts",
      status: result.ok ? "done" : "error",
      note: result.ok ? "OK" : `FAIL (${result.errors.length} 件)`,
    });
    console.log(`runId: ${result.runId}`);
    for (const w of result.warnings) {
      console.log(`warn: ${w}`);
    }
    if (result.ok) {
      console.log("verify-artifacts: OK (公開前ゲートを満たしています)");
    } else {
      for (const e of result.errors) {
        console.log(`error: ${e}`);
      }
      console.log(`verify-artifacts: FAIL (${result.errors.length} 件)`);
      process.exitCode = 1;
    }
  });

program
  .command("article:record-publication")
  .description("Record a publication: update meta.published and export/index.json (separate from export)")
  .requiredOption("--run <runId>", "Run id")
  .requiredOption("--slug <slug>", "Article slug (key in export/index.json)")
  .requiredOption("--url <url>", "Published article URL")
  .requiredOption("--article-id <id>", "Published article id")
  // --version は CLI 全体の version フラグ（-v/--version）と衝突するため --article-version にする。
  .requiredOption("--article-version <n>", "Published article version (integer >= 1)")
  .option("--force", "Allow a non-increasing version for the same slug (intentional correction)")
  .action(async (options: { run: string; slug: string; url: string; articleId: string; articleVersion: string; force?: boolean }) => {
    const version = Number(options.articleVersion);
    const store = new RunStore();
    const index = new ExportIndex();
    const result = await recordPublication(store, index, {
      runId: options.run,
      slug: options.slug,
      url: options.url,
      articleId: options.articleId,
      version,
      force: options.force,
    });
    console.log(`runId: ${result.runId}`);
    console.log(
      `published: ${result.slug} v${result.version} -> ${result.url}${result.noop ? " (no-op, already recorded)" : ""}`
    );
    console.log(`index: export/index.json (slug: ${result.slug})`);
  });

// アクションが集約した実績（progress の done イベントに載せる）。cost は判明分のみ。
type ProgressTotals = { costUsd?: number; elapsedMs?: number; inputTokens?: number; outputTokens?: number };

// 進捗は stderr に出す（stdout は runId / final パスのみに保ち、スクリプトでパースしやすくする）。
// コストは usage トークン × models.yaml の prices によるローカル概算（追加APIコールは無し）。
// totals() は progress 記録（アクション側で集約 → flush）用に同じ概算値を返す。
function createProgressReporter(): {
  report: (event: WorkflowEvent) => void;
  printTotal: () => void;
  totals: () => ProgressTotals;
} {
  let totalCostUsd = 0;
  let hasCost = false;
  let totalElapsedMs = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let hasTokens = false;

  const report = (event: WorkflowEvent): void => {
    switch (event.type) {
      case "step:start":
        process.stderr.write(`[${event.index}/${event.total}] ${event.name} (${event.task}) ...\n`);
        break;
      case "step:skip":
        process.stderr.write(`[${event.index}/${event.total}] ${event.name} - skip (done)\n`);
        break;
      case "step:done": {
        if (event.costUsd !== undefined) {
          totalCostUsd += event.costUsd;
          hasCost = true;
        }
        if (event.inputTokens !== undefined || event.outputTokens !== undefined) {
          totalInputTokens += event.inputTokens ?? 0;
          totalOutputTokens += event.outputTokens ?? 0;
          hasTokens = true;
        }
        totalElapsedMs += event.elapsedMs;
        const cost = event.costUsd !== undefined ? `, ~$${event.costUsd.toFixed(4)}` : "";
        process.stderr.write(
          `[${event.index}/${event.total}] ${event.name} - done via ${event.provider}/${event.model} (${formatDuration(event.elapsedMs)}${cost})\n`
        );
        if (event.truncated) {
          process.stderr.write(
            `  ⚠ ${event.name}: 出力が max_tokens で打ち切られた可能性があります。models.yaml の max_tokens を増やして再実行してください。\n`
          );
        }
        for (const warning of event.warnings ?? []) {
          process.stderr.write(`  ⚠ ${event.name}: ${warning}\n`);
        }
        break;
      }
    }
  };

  const printTotal = (): void => {
    if (hasCost) {
      process.stderr.write(`total: ~$${totalCostUsd.toFixed(4)} (estimate)\n`);
    }
  };

  const totals = (): ProgressTotals => ({
    costUsd: hasCost ? Number(totalCostUsd.toFixed(6)) : undefined,
    elapsedMs: totalElapsedMs,
    inputTokens: hasTokens ? totalInputTokens : undefined,
    outputTokens: hasTokens ? totalOutputTokens : undefined,
  });

  return { report, printTotal, totals };
}

// アクション（CLI 1コマンド）を1つの canonical 工程として progress に記録する。
// start を打ち、成功で done（集約した totals と出力パス）、失敗で error を打ってから再送出。
// progress の記録失敗は本処理を止めない（観測性は副作用）。
async function runWithProgress<T>(args: {
  progress: RunProgress;
  runId: string;
  step: string;
  task?: string;
  totals: () => ProgressTotals;
  output?: (result: T) => string | undefined;
  run: () => Promise<T>;
  // create 以外は run の存在を先に確認してから記録する（runId typo で架空 run を作らない）。
  ensureRun?: () => Promise<void>;
  // 編集長（駆動する Claude）の AI モデル。create 等で渡すと start から progress.md に出る。
  editorModel?: string;
}): Promise<T> {
  if (args.ensureRun) {
    await args.ensureRun();
  }
  await safeProgress(() =>
    args.progress.append(args.runId, { step: args.step, status: "start", task: args.task, editorModel: args.editorModel })
  );
  // start 直後に progress.json / progress.md を生成する。create/refine など長い工程でも
  // 「開始時点」で進捗ファイルが出る（done まで待たない＝folder 作成直後に見える）。
  await safeProgress(async () => {
    await args.progress.regenerate(args.runId);
  });
  try {
    const result = await args.run();
    const t = args.totals();
    await safeProgress(() =>
      args.progress.append(args.runId, {
        step: args.step,
        status: "done",
        task: args.task,
        elapsedMs: t.elapsedMs,
        costUsd: t.costUsd,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        output: args.output?.(result),
        editorModel: args.editorModel,
      })
    );
    await safeProgress(async () => {
      await args.progress.regenerate(args.runId);
    });
    return result;
  } catch (error) {
    await safeProgress(() =>
      args.progress.append(args.runId, { step: args.step, status: "error", task: args.task, note: shortMessage(error) })
    );
    await safeProgress(async () => {
      await args.progress.regenerate(args.runId);
    });
    throw error;
  }
}

// run の存在を meta.json で確認する（runId typo で架空 run の progress を作らないため）。
async function assertRunExists(store: RunStore, runId: string): Promise<void> {
  try {
    await store.readMeta(runId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Run ${runId} が見つかりません（runs/${runId}/meta.json なし）。runId を確認してください。`);
    }
    throw error;
  }
}

// WorkflowEvent を持たない CLI（claims-normalize / verify-artifacts / export 等）の終了を1イベント記録する。
// 記録失敗は本処理を止めない。
async function recordProgress(store: RunStore, runId: string, input: ProgressEventInput): Promise<void> {
  const progress = new RunProgress(store, pkg.version);
  await safeProgress(async () => {
    await progress.append(runId, input);
    await progress.regenerate(runId);
  });
}

async function safeProgress(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    process.stderr.write(`  ⚠ progress 記録に失敗しました（本処理は継続）: ${shortMessage(error)}\n`);
  }
}

function shortMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 197)}...` : message;
}

program
  .command("article:evaluate")
  .requiredOption("--run <runId>", "Run id")
  .option("--min-severity <level>", "Minimum severity to include (critical|major|minor|suggestion)", "suggestion")
  .option("--criteria <text>", "Evaluation focus / points (inline text)")
  .option("--criteria-file <path>", "Path to a text file with evaluation focus")
  .option("--config <path>", "Path to models.yaml", "config/models.yaml")
  .action(
    async (options: {
      run: string;
      minSeverity: string;
      criteria?: string;
      criteriaFile?: string;
      config: string;
    }) => {
      const minSeverity = parseSeverity(options.minSeverity);
      const { router, store } = await createRuntime(options.config);
      const criteria = await resolveEvaluationCriteria(store, options);

      const progress = new RunProgress(store, pkg.version);
      const reporter = createProgressReporter();
      const result = await runWithProgress({
        progress,
        runId: options.run,
        step: "evaluate",
        task: "final_review",
        totals: reporter.totals,
        output: (r) => `runs/${r.runId}/${r.reviewSummaryFile}`,
        ensureRun: () => assertRunExists(store, options.run),
        run: () => evaluateQiitaFinal(router, store, options.run, { minSeverity, criteria }, reporter.report),
      });
      reporter.printTotal();

      console.log(`runId: ${result.runId}`);
      console.log(
        `review: runs/${result.runId}/${result.reviewFile} (approved: ${result.approved ?? "n/a"}, issues>=${minSeverity}: ${result.issueCount})`
      );
      console.log(`summary: runs/${result.runId}/${result.reviewSummaryFile}`);
      if (result.instructionFile) {
        console.log(`instruction: runs/${result.runId}/${result.instructionFile}`);
      } else {
        console.log(`instruction: (none — no issues at or above ${minSeverity})`);
      }
    }
  );

program
  .command("article:refine")
  .description("Auto-loop evaluate→revise until the article passes (or max-rounds)")
  .requiredOption("--run <runId>", "Run id")
  .option("--max-rounds <n>", "Maximum number of evaluate rounds (>=1)", "3")
  .option("--min-severity <level>", "Severity that keeps the loop going (critical|major|minor|suggestion)", "major")
  .option("--until <mode>", "Stop condition: clean | approved", "clean")
  .option("--criteria <text>", "Evaluation focus / points (inline text)")
  .option("--criteria-file <path>", "Path to a text file with evaluation focus")
  .option("--config <path>", "Path to models.yaml", "config/models.yaml")
  .action(
    async (options: {
      run: string;
      maxRounds: string;
      minSeverity: string;
      until: string;
      criteria?: string;
      criteriaFile?: string;
      config: string;
    }) => {
      const maxRounds = parseMaxRounds(options.maxRounds);
      const minSeverity = parseSeverity(options.minSeverity);
      const until = parseUntil(options.until);
      const { router, store } = await createRuntime(options.config);
      const criteria = await resolveEvaluationCriteria(store, options);

      const progress = new RunProgress(store, pkg.version);
      const reporter = createRefineReporter(options.run);
      const result = await runWithProgress({
        progress,
        runId: options.run,
        step: "refine",
        task: "refine",
        totals: reporter.totals,
        output: (r) => `runs/${r.runId}/final.md (stopped: ${r.stoppedReason}, ${r.rounds} rounds)`,
        ensureRun: () => assertRunExists(store, options.run),
        run: () =>
          refineQiitaFinal(router, store, options.run, { maxRounds, minSeverity, until, criteria }, reporter.report),
      });

      console.log(`runId: ${result.runId}`);
      console.log(`stopped: ${result.stoppedReason} (${result.rounds} rounds)`);
      console.log(`final: runs/${result.runId}/final.md`);
    }
  );

program
  .command("article:review-editorial")
  .description("Independent editorial review (reader/editor critique) by a model different from the body writer")
  .requiredOption("--run <runId>", "Run id")
  .option("--mode <mode>", "Review mode: independent | continuation", "independent")
  .option("--allow-same-provider", "finalAuthor と同一 provider の別 model を許可")
  .option("--allow-same-model", "完全同一モデルまで許可（same-provider を含む）")
  .option("--config <path>", "Path to models.yaml", "config/models.yaml")
  .action(
    async (options: {
      run: string;
      mode: string;
      allowSameProvider?: boolean;
      allowSameModel?: boolean;
      config: string;
    }) => {
      if (options.mode !== "independent" && options.mode !== "continuation") {
        throw new Error(`Invalid --mode: ${options.mode}（independent | continuation）`);
      }
      const { router, store } = await createRuntime(options.config);
      const criteria = await resolveEditorialCriteria(store, options.run);
      const result = await runEditorialReview(router, store, options.run, {
        mode: options.mode as "independent" | "continuation",
        allowSameProvider: options.allowSameProvider,
        allowSameModel: options.allowSameModel,
        criteria,
      });
      await recordProgress(store, result.runId, {
        step: "editorial",
        status: "done",
        provider: result.reviewerModel.provider,
        model: result.reviewerModel.model,
        output: `runs/${result.runId}/editorial-review.md`,
        note: `${result.verdict} (round ${result.round}, ${result.candidateCount} candidates)`,
      });
      console.log(`runId: ${result.runId} (${result.mode}, round ${result.round})`);
      console.log(`reviewer: ${result.reviewerModel.provider}/${result.reviewerModel.model}`);
      console.log(`verdict: ${result.verdict}`);
      console.log(`review: runs/${result.runId}/editorial-review.md`);
      console.log(
        `candidates: runs/${result.runId}/editorial-instruction.candidates.md (${result.candidateCount} 件・未確定)`
      );
      console.log(
        `next: 編集長が候補を取捨して runs/${result.runId}/editorial-instruction.md を確定 → article:revise --instruction-file で適用`
      );
    }
  );

program
  .command("article:editorial-resolve")
  .description(
    "Record the editor's decision (accepted|waived|escalated|user-approved) on an editorial weakness into editorial-ledger.json (reviewer status untouched)"
  )
  .requiredOption("--run <runId>", "Run id")
  .requiredOption("--id <weaknessId>", "Weakness id (e.g. W001-ab5edbd0)")
  .requiredOption("--resolution <accepted|waived|escalated|user-approved>", "Editor decision")
  .requiredOption("--evidence <text>", "Why (audit; 例: 採用して revise 済み / 媒体適性で見送り / ユーザー承認)")
  .action(async (options: { run: string; id: string; resolution: string; evidence: string }) => {
    const resolution = parseWeaknessResolution(options.resolution);
    const store = new RunStore();
    await assertRunExists(store, options.run);
    const result = await resolveWeakness(store, options.run, options.id, resolution, options.evidence);
    // canonical 工程ではない追加アクション。progress.md だけで採否まで追えるよう1行残す。
    await recordProgress(store, result.runId, {
      step: "editorial-resolve",
      status: "done",
      output: `runs/${result.runId}/editorial-ledger.json`,
      note: `${result.id} (${result.severity}) -> ${result.resolution}`,
    });
    console.log(
      `editorial-resolve: ${result.id} -> ${result.resolution} (runs/${result.runId}/editorial-ledger.json)`
    );
  });

// 固定 rubric の既定パス（profile に editorial_criteria_file が無い場合の fallback。spec §5.3）。
const DEFAULT_EDITORIAL_CRITERIA_FILE = "config/criteria/editorial.md";

// 編集レビュー用 criteria の合成（spec §5.3）。
// 固定 rubric（profile の editorial_criteria_file、無ければ既定、上書き不可）＋ 追加コンテキスト（brushup-criteria.md があれば末尾連結）。
async function resolveEditorialCriteria(store: RunStore, runId: string): Promise<string | undefined> {
  const meta = await store.readMeta(runId);
  // 固定 rubric は profile 未設定/未指定でも落とさない（spec §5.3）。既定は config/criteria/editorial.md。
  let editorialCriteriaFile = DEFAULT_EDITORIAL_CRITERIA_FILE;
  if (meta.profile) {
    const profile = await loadProfile(meta.profile);
    if (profile.editorialCriteriaFile) {
      editorialCriteriaFile = profile.editorialCriteriaFile;
    }
  }
  assertSafeInputPath(editorialCriteriaFile);
  let rubric = (await readFile(editorialCriteriaFile, "utf8")).trim();
  const brushup = await store.read(runId, "brushup-criteria.md").then(
    (content) => content.trim(),
    () => ""
  );
  if (brushup) {
    rubric = rubric ? `${rubric}\n\n## 追加観点（記事固有・補足）\n${brushup}` : brushup;
  }
  return rubric || undefined;
}

function parseMaxRounds(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid --max-rounds: ${value} (use an integer >= 1)`);
  }
  return n;
}

function parseUntil(value: string): "clean" | "approved" {
  if (value !== "clean" && value !== "approved") {
    throw new Error(`Invalid --until: ${value} (use clean|approved)`);
  }
  return value;
}

// refine 専用の進捗表示。round 境界・評価/改稿の各行・打ち切り/wrap-text 警告・停止理由を stderr に出す。
// 合計コスト表示は実額のみ（cost が取れた分だけ加算）。
function createRefineReporter(runId: string): {
  report: (event: RefineEvent) => void;
  totals: () => ProgressTotals;
} {
  let total = 0;
  let hasCost = false;
  let totalElapsedMs = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let hasTokens = false;

  const accrue = (costUsd?: number, elapsedMs?: number, inputTokens?: number, outputTokens?: number): string => {
    if (elapsedMs !== undefined) {
      totalElapsedMs += elapsedMs;
    }
    if (inputTokens !== undefined || outputTokens !== undefined) {
      totalInputTokens += inputTokens ?? 0;
      totalOutputTokens += outputTokens ?? 0;
      hasTokens = true;
    }
    if (costUsd !== undefined) {
      total += costUsd;
      hasCost = true;
      return `, ~$${costUsd.toFixed(4)}`;
    }
    return "";
  };

  const report = (event: RefineEvent): void => {
    switch (event.type) {
      case "round:start":
        process.stderr.write(`[refine] round ${event.round}/${event.maxRounds}\n`);
        break;
      case "eval:done": {
        const cost = accrue(event.costUsd, event.elapsedMs, event.inputTokens, event.outputTokens);
        process.stderr.write(
          `  evaluate - done via ${event.provider}/${event.model} (${formatDuration(event.elapsedMs)}${cost}) — issues>=${event.minSeverity}: ${event.issueCount}, score: ${event.score}\n`
        );
        if (event.truncated) {
          process.stderr.write(
            `  ⚠ evaluate: 出力が max_tokens で打ち切られた可能性があります。models.yaml の max_tokens を増やして再実行してください。\n`
          );
        }
        break;
      }
      case "revise:done": {
        const cost = accrue(event.costUsd, event.elapsedMs, event.inputTokens, event.outputTokens);
        process.stderr.write(
          `  revise - done via ${event.provider}/${event.model} (${formatDuration(event.elapsedMs)}${cost})\n`
        );
        if (event.truncated) {
          process.stderr.write(
            `  ⚠ revise: 出力が max_tokens で打ち切られた可能性があります。models.yaml の max_tokens を増やして再実行してください。\n`
          );
        }
        for (const warning of event.warnings ?? []) {
          process.stderr.write(`  ⚠ revise: ${warning}\n`);
        }
        break;
      }
      case "stopped": {
        const cost = hasCost ? `, ~$${total.toFixed(4)} estimate` : "";
        process.stderr.write(`[refine] stopped: ${event.reason} (${event.rounds} rounds${cost})\n`);
        if (event.reason === "regressed") {
          // 悪化は評価ラウンド R で検出され、final.md は R-1 の revise 結果。悪化前の版は R-1 の before。
          const best = `runs/${runId}/refine-r${Math.max(event.rounds - 1, 1)}-before.md`;
          process.stderr.write(
            `  ⚠ スコアが悪化したため停止しました。${best} の方が良い可能性があります。\n`
          );
        }
        break;
      }
    }
  };

  const totals = (): ProgressTotals => ({
    costUsd: hasCost ? Number(total.toFixed(6)) : undefined,
    elapsedMs: totalElapsedMs,
    inputTokens: hasTokens ? totalInputTokens : undefined,
    outputTokens: hasTokens ? totalOutputTokens : undefined,
  });

  return { report, totals };
}

// 評価観点の解決順: 明示指定（--criteria / --criteria-file）> run の brushup-criteria.md > run の profile の criteria_file > なし。
async function resolveEvaluationCriteria(
  store: RunStore,
  options: { run: string; criteria?: string; criteriaFile?: string }
): Promise<string | undefined> {
  if (options.criteria !== undefined || options.criteriaFile !== undefined) {
    return resolveText(options.criteria, options.criteriaFile, "criteria", "--criteria", "--criteria-file");
  }

  // import 時に同梱したブラッシュアップ・ブリーフがあれば profile criteria より優先で採用する。
  const brushup = await store.read(options.run, "brushup-criteria.md").then(
    (content) => content.trim(),
    () => ""
  );
  if (brushup) {
    process.stderr.write(`criteria: run の brushup-criteria.md を使用\n`);
    return brushup;
  }

  const meta = await store.readMeta(options.run);
  if (meta.profile) {
    const profile = await loadProfile(meta.profile);
    if (profile.criteriaFile) {
      // profile 由来でも LLM に送る入力なので、CLI の --criteria-file と同じガードを通す。
      assertSafeInputPath(profile.criteriaFile);
      const content = (await readFile(profile.criteriaFile, "utf8")).trim();
      if (content) {
        process.stderr.write(`criteria: ${meta.profile} プロファイルの ${profile.criteriaFile} を使用\n`);
        return content;
      }
    }
  }

  return undefined;
}

function parseSeverity(value: string): Severity {
  const allowed: Severity[] = ["critical", "major", "minor", "suggestion"];
  if (!(allowed as string[]).includes(value)) {
    throw new Error(`Invalid --min-severity: ${value} (use critical|major|minor|suggestion)`);
  }
  return value as Severity;
}

function parseProgressStatus(value: string): ProgressEventStatus {
  const allowed: ProgressEventStatus[] = ["start", "done", "skip", "error"];
  if (!(allowed as string[]).includes(value)) {
    throw new Error(`Invalid --status: ${value} (use start|done|skip|error)`);
  }
  return value as ProgressEventStatus;
}

function parseOptionalNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid ${flag}: ${value} (expected a number)`);
  }
  return n;
}

function parseVerdict(value: string): Verdict {
  if (value !== "ok" && value !== "revise") {
    throw new Error(`Invalid --verdict: ${value} (use ok|revise)`);
  }
  return value;
}

function parseDirectionSource(value: string): DirectionSource {
  if (value !== "final" && value !== "draft") {
    throw new Error(`Invalid --source: ${value} (use final|draft)`);
  }
  return value;
}

function parseAcceptedAfter(value: string): AcceptedAfter {
  if (value !== "factcheck" && value !== "non-factual-diff") {
    throw new Error(`Invalid --accepted-after: ${value} (use factcheck|non-factual-diff)`);
  }
  return value;
}

function scopeSummary(scope: FactcheckScope): string {
  if (scope.mode === "diff") {
    return `diff (changed ${scope.changedSections.length} sections / ${scope.recheckClaims.length} claims)`;
  }
  return scope.mode; // full | skip
}

async function createRuntime(configPath: string): Promise<{ router: ModelRouter; store: RunStore }> {
  const config = await loadRouterConfig(configPath);
  const providers = createProviders(config);
  const logger = new RunLogger();
  const router = new ModelRouter(providers, config, logger);
  const store = new RunStore();
  return { router, store };
}

program
  .command("article:status")
  .description("Show run progress (current step / elapsed / estimated cost) from progress.events.jsonl")
  .requiredOption("--run <runId>", "Run id")
  .option("--json", "Output the ProgressSnapshot as JSON (for scripts)")
  .action(async (options: { run: string; json?: boolean }) => {
    const { snapshot, markdown } = await getRunStatus(options.run);
    if (options.json) {
      console.log(JSON.stringify(snapshot, null, 2));
      return;
    }
    process.stdout.write(`${markdown}\n`);
  });

program
  .command("article:progress:event")
  .description("Record a progress event into runs/<id>/progress.events.jsonl (for subagent / manual recording)")
  .requiredOption("--run <runId>", "Run id")
  .requiredOption("--step <name>", "Step name (e.g. factcheck, build-verify, publication-check)")
  .requiredOption("--status <status>", "start | done | skip | error")
  .option("--note <text>", "Reason / notes (required for skip — silent skip is forbidden)")
  .option("--output <path>", "Main output path for this step")
  .option("--elapsed-ms <n>", "Elapsed milliseconds")
  .option("--cost-usd <n>", "Estimated cost in USD")
  .option("--editor-model <id>", "Editor-in-chief AI model id (e.g. claude-opus-4-8). Shown in progress.md header")
  .action(
    async (options: {
      run: string;
      step: string;
      status: string;
      note?: string;
      output?: string;
      elapsedMs?: string;
      costUsd?: string;
      editorModel?: string;
    }) => {
      const status = parseProgressStatus(options.status);
      if (status === "skip" && !options.note) {
        throw new Error("skip は --note（理由）が必須です（silent skip 禁止）。");
      }
      const store = new RunStore();
      await assertRunExists(store, options.run);
      const progress = new RunProgress(store, pkg.version);
      const event: ProgressEventInput = {
        step: options.step,
        status,
        note: options.note,
        output: options.output,
        elapsedMs: parseOptionalNumber(options.elapsedMs, "--elapsed-ms"),
        costUsd: parseOptionalNumber(options.costUsd, "--cost-usd"),
        editorModel: options.editorModel,
      };
      await progress.append(options.run, event);
      const snapshot = await progress.regenerate(options.run);
      console.log(`progress: runs/${options.run}/progress.md (${options.step} = ${status})`);
      console.log(
        `current: ${snapshot.complete ? "complete" : snapshot.currentIndex !== undefined ? `${snapshot.currentIndex}/${snapshot.total}` : `-/${snapshot.total}`}`
      );
    }
  );

program
  .command("article:completion-report")
  .description("Generate runs/<id>/completion-report.md from progress.json + publication-check.md (closed to runs/, never touches export/index.json)")
  .requiredOption("--run <runId>", "Run id")
  .option("--stdout", "Print to stdout without writing the file (dry run)")
  .option("--reset-editor", "Reset the editor sections to the template (backs up the existing file first)")
  .action(async (options: { run: string; stdout?: boolean; resetEditor?: boolean }) => {
    const store = new RunStore();
    await assertRunExists(store, options.run);

    const publicationCheck = await store.read(options.run, "publication-check.md").catch(() => null);
    if (publicationCheck === null) {
      throw new Error(
        `publication-check.md がありません（runs/${options.run}/）。先に編集長が GO/NO-GO チェックリストを作成してください（verify-artifacts は推奨だが必須ではありません）。`
      );
    }

    const data = await collectCompletionReportData(store, options.run, publicationCheck);

    // 既定: auto 範囲だけ再生成し editor 欄は保持。--reset-editor のときだけ全面初期化。
    const existing = options.resetEditor
      ? null
      : await store.read(options.run, COMPLETION_REPORT_FILE).catch(() => null);
    const { content, recovered } = mergeCompletionReport(data, existing);

    if (options.stdout) {
      process.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
      return;
    }

    // reset-editor / マーカー破損のときは既存を bak へ退避してから書く（編集を飛ばさない）。
    if (options.resetEditor || recovered) {
      const prev = await store.read(options.run, COMPLETION_REPORT_FILE).catch(() => null);
      if (prev !== null) {
        await store.save(options.run, COMPLETION_REPORT_BAK, prev);
        process.stderr.write(
          `  ⚠ 既存の completion-report.md を ${COMPLETION_REPORT_BAK} に退避しました${recovered ? "（auto マーカーが見つからないため再生成）" : ""}。\n`
        );
      }
    }

    await store.save(options.run, COMPLETION_REPORT_FILE, content);
    console.log(`completion-report: runs/${options.run}/${COMPLETION_REPORT_FILE}`);
    if (data.goNoGo) {
      console.log(`GO/NO-GO: ${data.goNoGo}`);
    }

    // 完成報告の生成を進捗台帳に1行残す（GO/NO-GO 判断到達が status から分かるように）。
    // canonical 工程ではなく editorial 等と同じマーカー的 done 行（末尾に追加アクションとして出る）。
    // 完成報告本体は runs/ に閉じる方針のまま（export/index.json には混ぜない）。失敗は握って本処理継続。
    await safeProgress(async () => {
      const progress = new RunProgress(store, pkg.version);
      await progress.append(options.run, {
        step: "completion-report",
        status: "done",
        output: `runs/${options.run}/${COMPLETION_REPORT_FILE}`,
        note: data.goNoGo ? `GO/NO-GO: ${data.goNoGo}` : undefined,
      });
      await progress.regenerate(options.run);
    });
  });

program
  .command("article:direction-check")
  .description("Record a pre-factcheck direction gate into runs/<id>/direction-check.md (lightweight, editor-judged)")
  .requiredOption("--run <runId>", "Run id")
  .requiredOption("--verdict <ok|revise>", "Editor verdict after reading the article (ok = go to factcheck, revise = fix first)")
  .option("--note <text>", "Direction notes / revise instruction (recommended when --verdict revise)")
  .option("--source <final|draft>", "Article to read: final.md (default, the real gate) or draft.md (early preview)", "final")
  .option("--stdout", "Print to stdout only (no file write, no progress recording)")
  .option("--reset-editor", "Reset the editor (所感) section to the template (backs up the existing file first)")
  .action(async (options: { run: string; verdict: string; note?: string; source: string; stdout?: boolean; resetEditor?: boolean }) => {
    const verdict = parseVerdict(options.verdict);
    const source = parseDirectionSource(options.source);
    const store = new RunStore();
    await assertRunExists(store, options.run);

    const data = await collectDirectionCheckData(store, options.run, source, verdict, options.note);
    const existing = options.resetEditor
      ? null
      : await store.read(options.run, DIRECTION_CHECK_FILE).catch(() => null);
    const { content, recovered } = mergeDirectionCheck(data, existing);

    if (options.stdout) {
      // 完全な dry run: ファイルも progress も残さない。
      process.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
      return;
    }

    if (options.resetEditor || recovered) {
      const prev = await store.read(options.run, DIRECTION_CHECK_FILE).catch(() => null);
      if (prev !== null) {
        await store.save(options.run, DIRECTION_CHECK_BAK, prev);
        process.stderr.write(
          `  ⚠ 既存の direction-check.md を ${DIRECTION_CHECK_BAK} に退避しました${recovered ? "（auto マーカーが見つからないため再生成）" : ""}。\n`
        );
      }
    }

    await store.save(options.run, DIRECTION_CHECK_FILE, content);

    // progress 記録: source=final だけ canonical direction を進める（draft は早期プレビュー＝非 canonical）。
    // verdict=revise は canonical direction を error（未通過）で記録し、status を factcheck へ進めない。
    // 再判定 ok（done）が error を上書きする。draft は preview のため常に done（gate ではない）。
    const revisePrefix = verdict === "revise" ? "revise before factcheck; " : "";
    if (source === "final") {
      await recordProgress(store, options.run, {
        step: "direction",
        status: directionGateStatus(verdict),
        note: `${revisePrefix}verdict=${verdict}`,
      });
    } else {
      await recordProgress(store, options.run, {
        step: "direction-draft",
        status: "done",
        note: `early preview; ${revisePrefix}verdict=${verdict}`,
      });
    }

    console.log(`direction-check: runs/${options.run}/${DIRECTION_CHECK_FILE} (source=${source}, verdict=${verdict})`);
    if (verdict === "revise") {
      process.stderr.write("  ⚠ 方向性 要修正: factcheck の前に revise で直してください（factcheck に進まない）。\n");
    }
  });

program
  .command("article:factcheck-scope")
  .description("Decide whether a re-factcheck is needed by diffing the last baseline (factcheck.snapshot.md) against final.md")
  .requiredOption("--run <runId>", "Run id")
  .option("--json", "Print the scope as JSON to stdout (no file write)")
  .option("--stdout", "Print the scope markdown to stdout (no file write)")
  .action(async (options: { run: string; json?: boolean; stdout?: boolean }) => {
    if (options.json && options.stdout) {
      throw new Error("--json と --stdout は同時に指定できません（どちらの dry run か曖昧）。");
    }
    const store = new RunStore();
    await assertRunExists(store, options.run);
    const scope = await collectFactcheckScope(store, options.run);

    if (options.json) {
      console.log(JSON.stringify(scope, null, 2));
      return;
    }
    const markdown = renderFactcheckScope(scope, options.run);
    if (options.stdout) {
      process.stdout.write(markdown.endsWith("\n") ? markdown : `${markdown}\n`);
      return;
    }
    // 既定: md ＋ json を保存し、1行サマリを stdout に。
    await store.save(options.run, FACTCHECK_SCOPE_FILE, markdown);
    await store.save(options.run, FACTCHECK_SCOPE_JSON, JSON.stringify(scope, null, 2));
    console.log(`factcheck-scope: ${scopeSummary(scope)} -> runs/${options.run}/${FACTCHECK_SCOPE_FILE}`);

    // 再 factcheck の要否判定（full|diff|skip）を進捗台帳に1行残す。台帳から「差分に絞って
    // どれだけ再検証を省いたか」が見えるようにする（dry run の --json/--stdout では記録しない）。
    // canonical 外の追加アクション扱い（factcheck 本体とは別行）。失敗は握って本処理継続。
    await safeProgress(async () => {
      const progress = new RunProgress(store, pkg.version);
      await progress.append(options.run, {
        step: "factcheck-scope",
        status: "done",
        output: `runs/${options.run}/${FACTCHECK_SCOPE_FILE}`,
        note: `scope=${scopeSummary(scope)}`,
      });
      await progress.regenerate(options.run);
    });
  });

program
  .command("article:factcheck-stamp")
  .description("Accept current final.md as the fact-checked baseline (factcheck.snapshot.md). Run after factcheck (or after judging a diff non-factual).")
  .requiredOption("--run <runId>", "Run id")
  .requiredOption("--accepted-after <factcheck|non-factual-diff>", "Why the baseline is accepted (audit)")
  .requiredOption("--note <text>", "Acceptance note (audit)")
  .action(async (options: { run: string; acceptedAfter: string; note: string }) => {
    const acceptedAfter = parseAcceptedAfter(options.acceptedAfter);
    if (options.note.trim().length === 0) {
      throw new Error("--note は空にできません（baseline 受理の理由を監査メタに残すため）。");
    }
    const store = new RunStore();
    await assertRunExists(store, options.run);
    const meta = await stampSnapshot(store, options.run, acceptedAfter, options.note);
    console.log(
      `factcheck baseline updated: runs/${options.run}/factcheck.snapshot.md (accepted-after=${meta.acceptedAfter})`
    );
  });

program
  .command("article:references")
  .description("Generate the 参考 section links from sources.json (verified sources only; never lets the LLM write URLs)")
  .requiredOption("--run <runId>", "Run id")
  .option("--stdout", "Print only the generated 参考 block (no file write)")
  .action(async (options: { run: string; stdout?: boolean }) => {
    const store = new RunStore();
    await assertRunExists(store, options.run);

    // claims/sources を読んで参考ブロックを生成（不在・verified 0件はここで明確にエラー＝exit 1）。
    const { block, count } = await prepareReferencesBlock(store, options.run);

    if (options.stdout) {
      process.stdout.write(block.endsWith("\n") ? block : `${block}\n`);
      return;
    }

    const final = await store.read(options.run, "final.md").catch(() => null);
    if (final === null) {
      throw new Error(`final.md がありません（runs/${options.run}/）。`);
    }
    // LLM が書いた参考リスト節（参考リンク/出典 等・URL 入り）を先に除去する。機械生成の `## 参考`
    // と二重化させない＝偽 URL 防止（台帳照合外の LLM 製 URL を本文に残さない）。
    const stripped = stripLlmReferenceSections(final);
    // 反映を先に計算（マーカー破損ならここで throw＝書き込まない）→ bak 退避 → 書き込み。
    const { content, status } = replaceMarkedBlock(stripped.body, SOURCES_BEGIN, SOURCES_END, block);
    await store.save(options.run, "final.references.bak.md", final);
    await store.save(options.run, "final.md", content);
    const strippedNote =
      stripped.removed.length > 0 ? ` / LLM 参考節を除去: ${stripped.removed.join(", ")}` : "";
    console.log(
      `references: runs/${options.run}/final.md (${count} sources, ${status}) / backup: final.references.bak.md${strippedNote}`
    );
    if (stripped.removed.length > 0) {
      process.stderr.write(
        `  ⚠ LLM が書いた参考リスト節を除去しました（機械生成の ## 参考 に一本化）: ${stripped.removed.join(", ")}\n`
      );
    }
  });

if (process.argv.slice(2).length === 0) {
  // サブコマンド未指定ならヘルプを表示する。
  program.outputHelp();
} else {
  program.parseAsync().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
