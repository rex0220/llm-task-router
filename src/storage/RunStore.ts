import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export type RunStepStatus = "pending" | "done";

// refine ループの severity（schema の enum と一致。storage→workflow の依存を作らないため inline 定義）。
export type RefineSeverity = "critical" | "major" | "minor" | "suggestion";

export type RefineStoppedReason =
  | "clean"
  | "approved"
  | "max-rounds"
  | "stalled"
  | "regressed"
  | "no-instruction";

export type RefineRoundEval = {
  provider: string;
  model: string;
  elapsedMs: number;
  costUsd?: number;
  truncated?: boolean;
  issueCount: number; // minSeverity 以上
  score: number; // 重み付きスコア（全指摘）
  approved?: boolean;
};

export type RefineRoundRevision = {
  provider: string;
  model: string;
  elapsedMs: number;
  costUsd?: number;
  truncated?: boolean;
  warnings?: string[];
  beforeFile: string; // refine-r<N>-before.md
};

export type RefineRoundMeta = {
  round: number;
  evaluation: RefineRoundEval;
  revision: RefineRoundRevision | null; // 停止ラウンドは null
  costUsdTotal: number; // (evaluation.costUsd ?? 0) + (revision?.costUsd ?? 0)
};

export type RefineMeta = {
  // 開始時に確定（in-progress でも成立）
  rounds: RefineRoundMeta[];
  minSeverity: RefineSeverity;
  until: "clean" | "approved";
  maxRoundsAtRun: number;
  // 終了処理（finalize）で確定する optional フィールド（実行中・中断時は未設定）
  stoppedReason?: RefineStoppedReason;
  finalIssueCount?: number;
  finalScore?: number;
  finalApproved?: boolean;
  costUsdTotal?: number;
};

export type RunMeta = {
  runId: string;
  topic: string;
  platform?: string;
  style?: string;
  profile?: string;
  createdAt: string;
  updatedAt: string;
  steps: Record<string, { status: RunStepStatus; file?: string }>;
  refine?: RefineMeta;
};

export class RunStore {
  private readonly root: string;

  constructor(root = "runs") {
    this.root = resolve(root);
  }

  async create(
    runId: string,
    topic: string,
    steps: string[],
    platform?: string,
    style?: string,
    profile?: string
  ): Promise<RunMeta> {
    const meta: RunMeta = {
      runId: this.validateRunId(runId),
      topic,
      platform,
      style,
      profile,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: Object.fromEntries(steps.map((step) => [step, { status: "pending" as const }])),
    };
    await mkdir(this.runPath(meta.runId), { recursive: true });
    await this.writeMeta(meta);
    return meta;
  }

  async readMeta(runId: string): Promise<RunMeta> {
    const content = await readFile(this.filePath(runId, "meta.json"), "utf8");
    return JSON.parse(content) as RunMeta;
  }

  async writeMeta(meta: RunMeta): Promise<void> {
    const updated = { ...meta, updatedAt: new Date().toISOString() };
    await mkdir(this.runPath(updated.runId), { recursive: true });
    await writeFile(this.filePath(updated.runId, "meta.json"), `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  }

  async save(runId: string, fileName: string, content: string): Promise<void> {
    await mkdir(this.runPath(runId), { recursive: true });
    await writeFile(this.filePath(runId, fileName), content.endsWith("\n") ? content : `${content}\n`, "utf8");
  }

  async read(runId: string, fileName: string): Promise<string> {
    return readFile(this.filePath(runId, fileName), "utf8");
  }

  async remove(runId: string, fileName: string): Promise<void> {
    await rm(this.filePath(runId, fileName), { force: true });
  }

  async markDone(runId: string, step: string, fileName: string): Promise<RunMeta> {
    const meta = await this.readMeta(runId);
    meta.steps[step] = { status: "done", file: fileName };
    await this.writeMeta(meta);
    return meta;
  }

  runPath(runId: string): string {
    const safeRunId = this.validateRunId(runId);
    const candidate = resolve(this.root, safeRunId);
    if (!isInside(this.root, candidate)) {
      throw new Error("Run path escapes runs root");
    }
    return candidate;
  }

  private filePath(runId: string, fileName: string): string {
    if (fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) {
      throw new Error(`Invalid file name: ${fileName}`);
    }

    const candidate = resolve(join(this.runPath(runId), fileName));
    if (!isInside(this.runPath(runId), candidate)) {
      throw new Error("File path escapes run directory");
    }
    return candidate;
  }

  private validateRunId(runId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId === "." || runId === ".." || runId.includes("..")) {
      throw new Error(`Invalid run id: ${runId}`);
    }
    return runId;
  }
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}
