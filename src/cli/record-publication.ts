import {
  assertNoVersionRegression,
  ExportIndex,
  type ExportIndexEntry,
} from "../storage/ExportIndex";
import { validatePublicationInput, validateSlug } from "../storage/meta";
import type { PublishedMeta, RunStore } from "../storage/RunStore";

export type RecordPublicationOptions = {
  runId: string;
  slug: string;
  url: string;
  articleId: string;
  version: number;
  force?: boolean;
};

export type RecordPublicationResult = {
  runId: string;
  slug: string;
  url: string;
  version: number;
  noop: boolean; // 既に記録済みで書き込み不要だったか
};

function publishedEqual(a: PublishedMeta | undefined, b: PublishedMeta): boolean {
  return (
    a !== undefined &&
    a.url === b.url &&
    a.articleId === b.articleId &&
    a.version === b.version &&
    a.updatedAt === b.updatedAt
  );
}

function entryEqual(a: ExportIndexEntry | undefined, b: ExportIndexEntry): boolean {
  return (
    a !== undefined &&
    a.runId === b.runId &&
    a.url === b.url &&
    a.articleId === b.articleId &&
    a.version === b.version &&
    a.updatedAt === b.updatedAt
  );
}

// meta.published と既存 index エントリの食い違いを検出して監査用の警告文を返す（無ければ undefined）。
// 修復・収束は recordPublication が行うが、運用上「何が食い違っていたか」を残すための軽量チェック。
function detectInconsistency(
  runId: string,
  slug: string,
  prev: PublishedMeta | undefined,
  existingEntry: ExportIndexEntry | undefined
): string | undefined {
  if (!prev || !existingEntry) {
    return undefined; // 片方しか無いのは初回/修復前。食い違いではない。
  }
  if (existingEntry.runId !== runId) {
    return `slug "${slug}" の台帳は別 run (${existingEntry.runId}) を指しています。この run (${runId}) で上書きします。`;
  }
  if (
    existingEntry.version !== prev.version ||
    existingEntry.articleId !== prev.articleId ||
    existingEntry.url !== prev.url
  ) {
    return `slug "${slug}" の meta.published と台帳が食い違っています（meta v${prev.version} / index v${existingEntry.version}）。整合するよう修復します。`;
  }
  return undefined;
}

// 公開台帳更新（§6.2）。meta.published（§5.1）と export/index.json（§5.5）を同時更新する。
// - 検証フェーズ（副作用なし）→ 書き込みフェーズの順で、reject は書き込み前に出す。
// - 冪等: 同じ引数の再実行は同じ最終状態へ収束する（完全一致 no-op／既存 updatedAt 再利用）。
// - 不整合（meta.published と台帳の食い違い）は onWarn で監査ログに残す（修復は継続する）。
export async function recordPublication(
  store: RunStore,
  index: ExportIndex,
  options: RecordPublicationOptions,
  onWarn: (message: string) => void = (message) => process.stderr.write(`Warning: ${message}\n`)
): Promise<RecordPublicationResult> {
  // --- 検証フェーズ（副作用なし）---
  const slug = validateSlug(options.slug);
  const { url, articleId, version } = validatePublicationInput({
    url: options.url,
    articleId: options.articleId,
    version: options.version,
  });
  const meta = await store.readMeta(options.runId); // run が無ければここで失敗

  const existingEntry = await index.resolve(slug);
  // 不整合の検出は version 退行ガードより前（reject されても監査ログは残す）。
  const inconsistency = detectInconsistency(options.runId, slug, meta.published, existingEntry);
  if (inconsistency) {
    onWarn(inconsistency);
  }
  // version 退行ガード（updatedAt は比較に使わないため空で渡す）。
  const candidateContent: ExportIndexEntry = { runId: options.runId, url, articleId, version, updatedAt: "" };
  assertNoVersionRegression(existingEntry, candidateContent, Boolean(options.force));

  // --- 時刻の決定 ---
  // meta.published の内容が候補と一致するなら updatedAt を再利用する
  // （完全一致の再実行・index 欠落の修復で時刻をブレさせない＝冪等）。
  const prev = meta.published;
  const contentMatchesMeta =
    prev !== undefined && prev.url === url && prev.articleId === articleId && prev.version === version;
  // meta が失われ index だけ無傷な修復でも時刻をブレさせないため、index 側の一致でも再利用する。
  const contentMatchesIndex =
    existingEntry !== undefined &&
    existingEntry.runId === options.runId &&
    existingEntry.url === url &&
    existingEntry.articleId === articleId &&
    existingEntry.version === version;
  const timestamp =
    (contentMatchesMeta && prev?.updatedAt) ||
    (contentMatchesIndex && existingEntry?.updatedAt) ||
    new Date().toISOString();

  const nextPublished: PublishedMeta = { url, articleId, version, updatedAt: timestamp };
  const nextEntry: ExportIndexEntry = { runId: options.runId, url, articleId, version, updatedAt: timestamp };

  const metaNeedsWrite = !publishedEqual(prev, nextPublished);
  const indexNeedsWrite = !entryEqual(existingEntry, nextEntry);

  // 完全一致 → no-op（meta.updatedAt も含め何も書かない）。
  if (!metaNeedsWrite && !indexNeedsWrite) {
    return { runId: options.runId, slug, url, version, noop: true };
  }

  // --- 書き込みフェーズ ---
  if (metaNeedsWrite) {
    meta.published = nextPublished;
    await store.writeMeta(meta);
  }
  if (indexNeedsWrite) {
    await index.write(slug, nextEntry);
  }

  return { runId: options.runId, slug, url, version, noop: false };
}
