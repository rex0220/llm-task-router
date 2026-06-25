import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { validateSafeId } from "./meta";

// 保存時の末尾改行正規化（既存 save と同じ規則）。SeriesStore とバイト等価で共有するため抽出。
export function withTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

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

// 公開先の正本（§5.1）。公開記事としての所在と版のみ。run 系譜は混ぜない。
export type PublishedMeta = {
  url: string;
  articleId: string;
  version: number; // 公開記事としての版番号（>=1）
  updatedAt: string; // 公開更新時刻（meta.updatedAt = ファイル更新時刻 とは別物）
};

// run 系譜の正本（§5.2）。どの run がどの run の更新か。公開情報とは別軸。
export type LineageMeta = {
  supersedesRunId?: string; // 直前の起点 run
  rootRunId?: string; // 系譜の根（初版 run）
  sourceExportPath?: string; // import 元
};

// シリーズ（横の束）の正本（series-spec §5.1）。published / lineage と並列の第3軸。
// run がどのシリーズの何番目で、どの版・内容の voice で書かれたかを焼き込む（監査用）。
export type RunSeriesMeta = {
  seriesId: string; // series/<slug> に対応（series.json と一致）
  role?: "article" | "chapter" | "seed"; // 既定 "article"。小説は "chapter"
  order?: number; // 束内の順序（1 始まり）
  prevRunId?: string; // 連続性の参照元（小説の前章 run）
  voiceVersion: number; // 焼き込んだ voice の版（series.json.voice.version と対応）
  voiceHash: string; // 同 voice の内容ハッシュ（sha256 hex・監査用）
};

// 編集レビューの独立性に使うモデル印（editorial-review-spec §5.1）。
export type ModelStamp = { provider: string; model: string };
// 現在の final.md を最後に生成・改稿したモデル。import 由来は "external"。
export type FinalAuthorModel = ModelStamp | "external";

export type RunMeta = {
  runId: string;
  topic: string;
  platform?: string;
  style?: string;
  profile?: string;
  // 既存記事を取り込んだ run の印。生成系工程を経ていないため resume/review を拒否する判定に使う。
  imported?: boolean;
  createdAt: string;
  updatedAt: string;
  steps: Record<string, { status: RunStepStatus; file?: string }>;
  refine?: RefineMeta;
  // 投稿用メタ（export の front-matter 生成に使う）。brief から populate、import は継承/指定。
  articleTitle?: string;
  tags?: string[];
  // 更新リライト運用の拡張（§5）。既存 run との後方互換のため optional。
  published?: PublishedMeta;
  lineage?: LineageMeta;
  // 編集レビューの独立性用（editorial-review-spec §5.1）。
  finalAuthorModel?: FinalAuthorModel; // 現 final.md を最後に書いたモデル（import は "external"）
  reviewerModel?: ModelStamp; // 直近の editorial_review 実応答モデル
  // シリーズ（横の束）の正本（series-spec §5.1）。optional・既存 run は undefined。
  series?: RunSeriesMeta;
  // 機械生成参考章の見出し（既定 "参考"・`## ` は含めない）。run 単位 first-write-wins。
  // 未設定 run は "参考"（後方互換）。正本はマーカーで見出しはブロック外＝検証ゲートは見出し非依存。
  referencesHeading?: string;
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
    profile?: string,
    // series は末尾の optional 引数（位置を並べ替えない＝既存呼び出しに非影響・series-c1-plan §9.5）。
    // 渡されたときだけ初期 meta.json に同梱し、brief の中間 writeMeta と競合させない（§10 D6）。
    series?: RunSeriesMeta,
    // 参考章見出し（既定 "参考"）。series の後ろの optional 引数（既存呼び出しに非影響）。
    referencesHeading?: string
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
      // undefined は JSON.stringify で出力されないため、series 無しでは meta に現れない。
      ...(series ? { series } : {}),
      ...(referencesHeading ? { referencesHeading } : {}),
    };
    await mkdir(this.runPath(meta.runId), { recursive: true });
    await this.writeMeta(meta);
    return meta;
  }

  // 指定シリーズに属する run の meta を runs/ 横断で集める（series:status --fix の source of truth）。
  // 壊れた run（meta 読込/検証不能）は握り潰さず warnings に積み、全体は止めない（series-c1-plan §9.5）。
  // console には出さず構造で返す（責務分離・テスト容易）。
  async listSeriesRuns(seriesId: string): Promise<{ runs: RunMeta[]; warnings: string[] }> {
    const runs: RunMeta[] = [];
    const warnings: string[] = [];
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return { runs, warnings };
      }
      throw error;
    }
    for (const entry of entries) {
      let meta: RunMeta;
      try {
        meta = await this.readMeta(entry);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        // meta.json が無い＝run ではない（export/ 等）→ 静かにスキップ。
        // それ以外（不正 JSON・I/O・不正 runId 名）は壊れた run として警告し、全体は止めない。
        if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") {
          warnings.push(`Skipped ${entry}: ${err?.message ?? "meta.json unreadable"}`);
        }
        continue;
      }
      if (meta.series?.seriesId === seriesId) {
        runs.push(meta);
      }
    }
    return { runs, warnings };
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
    await writeFile(this.filePath(runId, fileName), withTrailingNewline(content), "utf8");
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

  // final.md を最後に書いたモデルを記録する。markDone が meta を再読込・上書きするため、
  // 記録は markDone の「後」に呼ぶこと（前に書くと markDone に消される）。
  async setFinalAuthorModel(runId: string, model: FinalAuthorModel): Promise<void> {
    const meta = await this.readMeta(runId);
    meta.finalAuthorModel = model;
    await this.writeMeta(meta);
  }

  async setReviewerModel(runId: string, model: ModelStamp): Promise<void> {
    const meta = await this.readMeta(runId);
    meta.reviewerModel = model;
    await this.writeMeta(meta);
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
    // slug/articleId と同一の安全文字種ガードを共有（meta.ts）。二重定義のドリフトを避ける。
    return validateSafeId(runId, "run id");
  }
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}
