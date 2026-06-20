import { access, readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { RunStore } from "../storage/RunStore";
import type { LineageMeta } from "../storage/RunStore";
import { validateSafeId } from "../storage/meta";
import { loadProfile } from "../workflows/profile";
import { createRunId } from "../workflows/createQiitaArticle";
import { DEFAULT_PLATFORM, qiitaSteps } from "../workflows/qiitaSteps";
import { assertSafeInputPath } from "./inputs";

export type ImportArticleOptions = {
  from: string;
  runId?: string;
  topic?: string;
  profile: string;
  platform?: string;
  criteria?: string; // ブラッシュアップ・ブリーフ（解決済みテキスト）
  force?: boolean;
  // 更新リライト運用の系譜（§5.2）。/update-article が台帳から解決して渡す。
  supersedesRunId?: string;
  rootRunId?: string;
  // 投稿用タグ。未指定なら supersedes 元 run の tags を継承する。
  tags?: string[];
};

export type ImportArticleResult = {
  runId: string;
  frontMatterWarning: boolean;
  replacedRun: boolean; // 既存 run を --force で置き換えたか
};

// force 置き換え時に掃除する成果物。run 全体を import run として作り直すため、
// 旧 brushup-criteria（古い改善方針の silent 再利用を防ぐ）・生成系成果物・評価/refine 系を消す。
// brushup-criteria.md はこの後 criteria 指定時のみ再生成される。
function staleArtifacts(maxRefineRounds: number): string[] {
  const files = [
    "brushup-criteria.md",
    "brief.json",
    "outline.json",
    "draft.md",
    "review.json",
    "final.bak.md",
    "final-review.json",
    "final-review.md",
    "revise-instruction.md",
    "refine-summary.md",
    // 版の正本（§5.3）。--force 再 import では作り直す（古い版を回帰起点に残さない）。
    "update-base.md",
  ];
  for (let n = 1; n <= maxRefineRounds; n++) {
    files.push(`refine-r${n}-review.json`, `refine-r${n}-review.md`, `refine-r${n}-instruction.md`, `refine-r${n}-before.md`);
  }
  return files;
}

// 本文先頭の最初の H1 をテーマ種に使う（評価には不使用。履歴・人の参照用）。
function deriveTopic(body: string): string | undefined {
  const match = body.match(/^#\s+(.+?)\s*$/m);
  return match?.[1]?.trim() || undefined;
}

function hasFrontMatter(body: string): boolean {
  return /^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(body);
}

// 既存記事(Markdown)を取り込み、profile から正しい meta を生成した import run を作る。
// export.ts の対（export: run → 外、import: 外 → run）。本文の自動編集はしない。
export async function importArticle(store: RunStore, options: ImportArticleOptions): Promise<ImportArticleResult> {
  assertSafeInputPath(options.from);
  const body = await readFile(options.from, "utf8");
  if (!body.trim()) {
    throw new Error(`Article file is empty: ${options.from}`);
  }

  const seed = options.runId ?? basename(options.from).replace(/\.[^.]+$/, "");
  const runId = options.runId ?? createRunId(seed);

  // 既存 run 保護: meta.json または run ディレクトリが既にあれば force を要求する。
  const existing = await readExistingMeta(store, runId);
  const dirExists = existing !== null || (await pathExists(store.runPath(runId)));
  if (dirExists && !options.force) {
    throw new Error(`Run already exists: runs/${runId} (use --force to replace it as an import run)`);
  }
  if (dirExists && options.force && existing && !existing.imported) {
    process.stderr.write(
      `Warning: replacing a non-import run as an import run: runs/${runId}\n`
    );
  }

  const profile = await loadProfile(options.profile);
  const platform = options.platform ?? profile.platform ?? DEFAULT_PLATFORM;
  const topic = options.topic?.trim() || deriveTopic(body) || runId;

  // force 置き換え時は旧成果物を掃除（run 全体を import run として作り直す）。
  if (dirExists && options.force) {
    const maxRounds = Math.max(existing?.refine?.maxRoundsAtRun ?? 0, existing?.refine?.rounds.length ?? 0, 0);
    for (const file of staleArtifacts(maxRounds)) {
      await store.remove(runId, file);
    }
  }

  // meta を create と同経路で生成 → 全 step done ＋ imported を立てる（手書き meta を避ける核心）。
  await store.create(
    runId,
    topic,
    qiitaSteps.map((step) => step.name),
    platform,
    profile.style,
    options.profile
  );
  const meta = await store.readMeta(runId);
  meta.imported = true;
  const finalStep = qiitaSteps[qiitaSteps.length - 1];
  for (const step of qiitaSteps) {
    meta.steps[step.name] = { status: "done", file: step.name === finalStep.name ? finalStep.file : undefined };
  }
  // 系譜（§5.2）。import 元は常に記録し、起点/根 run は与えられた分だけ記録する。
  const lineage: LineageMeta = { sourceExportPath: options.from };
  if (options.supersedesRunId) {
    lineage.supersedesRunId = validateSafeId(options.supersedesRunId, "supersedes run id");
  }
  if (options.rootRunId) {
    lineage.rootRunId = validateSafeId(options.rootRunId, "root run id");
  }
  meta.lineage = lineage;
  // import 由来の本文は外部/人間作。編集レビューの独立性チェックは免除（external）。
  meta.finalAuthorModel = "external";
  // 投稿用メタ: タイトルは本文 H1 / topic を流用、タグは指定 > supersedes 継承。
  meta.articleTitle = deriveTopic(body) ?? topic;
  const inheritedTags = options.supersedesRunId
    ? await store.readMeta(options.supersedesRunId).then(
        (prev) => prev.tags,
        () => {
          // supersedes が見つからない等で継承できなかったことを黙らせない（タグ消失の footgun 防止）。
          process.stderr.write(
            `Warning: supersedes run ${options.supersedesRunId} のメタを読めずタグを継承できませんでした。--tags で明示してください。\n`
          );
          return undefined;
        }
      )
    : undefined;
  const resolvedTags = options.tags ?? inheritedTags;
  if (resolvedTags && resolvedTags.length > 0) {
    meta.tags = resolvedTags;
  }
  await store.writeMeta(meta);

  await store.save(runId, "final.md", body);
  // 版の正本（§5.3）。import 直後の本文を固定保存し、差分監査・回帰確認の起点にする。
  // final.bak.md は revise のたびに上書きされるため、ここで別ファイルに固定する。
  await store.save(runId, "update-base.md", body);

  if (options.criteria?.trim()) {
    await store.save(runId, "brushup-criteria.md", options.criteria.trim());
  }

  return { runId, frontMatterWarning: hasFrontMatter(body), replacedRun: dirExists && Boolean(options.force) };
}

async function readExistingMeta(store: RunStore, runId: string): Promise<Awaited<ReturnType<RunStore["readMeta"]>> | null> {
  try {
    return await store.readMeta(runId);
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  );
}
