import "dotenv/config";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { assertSafeInputPath, resolveText } from "./cli/inputs";
import { exportFinalArticle } from "./cli/export";
import { initConfig } from "./cli/init";
import { loadProfile } from "./workflows/profile";
import { RunLogger } from "./logger/RunLogger";
import { createProviders } from "./providers";
import { ModelRouter } from "./router/ModelRouter";
import { loadRouterConfig } from "./router/config";
import { RunStore } from "./storage/RunStore";
import {
  createQiitaArticle,
  createRunId,
  evaluateQiitaFinal,
  rerunQiitaReview,
  resumeQiitaArticle,
  reviseQiitaFinal,
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
  .description("Scaffold config/ and .env.example into the current directory")
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
  .option("--config <path>", "Path to models.yaml", "config/models.yaml")
  .action(
    async (options: {
      topic?: string;
      topicFile?: string;
      profile: string;
      platform?: string;
      run?: string;
      config: string;
    }) => {
      const topic = await resolveText(options.topic, options.topicFile, "topic", "--topic", "--topic-file");
      const profile = await loadProfile(options.profile);
      const platform = options.platform ?? profile.platform;
      const runIdSeed = options.topicFile ? basename(options.topicFile).replace(/\.[^.]+$/, "") : topic;
      const runId = options.run ?? createRunId(runIdSeed);
      const { router, store } = await createRuntime(options.config);
      const reporter = createProgressReporter();
      const result = await createQiitaArticle(
        router,
        store,
        topic,
        { runId, platform, style: profile.style, profile: options.profile },
        reporter.report
      );
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
    const reporter = createProgressReporter();
    const result = await resumeQiitaArticle(router, store, options.run, reporter.report);
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
    const reporter = createProgressReporter();
    const result = await rerunQiitaReview(router, store, options.run, reporter.report);
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
    const reporter = createProgressReporter();
    const result = await reviseQiitaFinal(router, store, options.run, instruction, reporter.report);
    reporter.printTotal();
    console.log(`runId: ${result.runId}`);
    console.log(`final: runs/${result.runId}/final.md (previous: runs/${result.runId}/final.bak.md)`);
  });

program
  .command("article:export")
  .requiredOption("--run <runId>", "Run id")
  .requiredOption("--out <path>", "Destination path for the final article")
  .option("--force", "Overwrite the destination if it already exists")
  .action(async (options: { run: string; out: string; force?: boolean }) => {
    const store = new RunStore();
    const dest = await exportFinalArticle(store, options.run, options.out, { force: options.force });
    console.log(`exported: ${dest}`);
  });

// 進捗は stderr に出す（stdout は runId / final パスのみに保ち、スクリプトでパースしやすくする）。
// コストは usage トークン × models.yaml の prices によるローカル概算（追加APIコールは無し）。
function createProgressReporter(): { report: (event: WorkflowEvent) => void; printTotal: () => void } {
  let totalCostUsd = 0;
  let hasCost = false;

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
        const cost = event.costUsd !== undefined ? `, ~$${event.costUsd.toFixed(4)}` : "";
        process.stderr.write(
          `[${event.index}/${event.total}] ${event.name} - done via ${event.provider}/${event.model} (${event.elapsedMs}ms${cost})\n`
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

  return { report, printTotal };
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

      const reporter = createProgressReporter();
      const result = await evaluateQiitaFinal(router, store, options.run, { minSeverity, criteria }, reporter.report);
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

// 評価観点の解決順: 明示指定（--criteria / --criteria-file）> run の profile の criteria_file > なし。
async function resolveEvaluationCriteria(
  store: RunStore,
  options: { run: string; criteria?: string; criteriaFile?: string }
): Promise<string | undefined> {
  if (options.criteria !== undefined || options.criteriaFile !== undefined) {
    return resolveText(options.criteria, options.criteriaFile, "criteria", "--criteria", "--criteria-file");
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

async function createRuntime(configPath: string): Promise<{ router: ModelRouter; store: RunStore }> {
  const config = await loadRouterConfig(configPath);
  const providers = createProviders(config);
  const logger = new RunLogger();
  const router = new ModelRouter(providers, config, logger);
  const store = new RunStore();
  return { router, store };
}

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
