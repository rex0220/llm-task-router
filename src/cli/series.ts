import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateSlug } from "../storage/meta";
import type { RunMeta, RunSeriesMeta } from "../storage/RunStore";
import { RunStore } from "../storage/RunStore";
import { RunProgress } from "../progress/RunProgress";
import { SeriesStore, voiceHash } from "../storage/SeriesStore";
import {
  memberSlugFromRunId,
  type SeriesData,
  type SeriesMember,
  type SeriesMemberStatus,
} from "../storage/seriesMeta";

const SERIES_VOICE_HEADING = "# Series Voice";

// meta.style の合成フォーマット（series-c1-plan §4.2 / D10）。実装差・テストブレを避け固定する。
// profile.style ＋ 空行 ＋ "# Series Voice" ＋ 空行 ＋ voice 本文。profile.style 空なら見出しから。
export function composeSeriesStyle(profileStyle: string | undefined, voice: string): string {
  const base = (profileStyle ?? "").trim();
  const body = voice.trim();
  const head = `${SERIES_VOICE_HEADING}\n\n${body}`;
  return base ? `${base}\n\n${head}` : head;
}

// --order 省略時の自動採番値を返す（append＝最大 order +1）。明示時はそのまま返す。
// recordMember が「確定した order」を呼び出し元へ返すためにも使う（meta.json backpatch 用）。
function resolveOrder(members: SeriesMember[], order: number | undefined): number {
  return order ?? (members.reduce((max, m) => Math.max(max, m.order), 0) + 1);
}

// members に作成済み run を upsert する（series-c1-plan §4.1 / D8）。
// order 指定ありは該当 order を upsert、無しは末尾 append（最大 order +1）。slug は呼び出し側で
// validateSlug 済みの safe slug を渡す。返り値は更新後 members（入力は破壊しない）。
// ⚠ status は必須引数（既定値を持たせない）。create と reconcile（--fix）が共有する関数なので、
//   既定で "done"/"writing" を埋めると一方の経路で意図しない格上げ/格下げ（silent up/downgrade）が起きる。
//   呼び出し側に status の判断を強制する（proposal §2）。
// title（候補名）は任意。既存スロット更新では entry.title 未指定なら既存を保持（slot.title を消さない）。
// 新規スロット（push）では entry.title を運ぶ（series:plan で planned 枠に候補名を載せる経路・proposal §2）。
// runId は planned 枠（null）を series:plan で upsert できるよう string | null。create 経路は実 runId を渡す。
export function upsertMember(
  members: SeriesMember[],
  entry: { order?: number; slug: string; runId: string | null; status: SeriesMemberStatus; title?: string }
): SeriesMember[] {
  const next = members.map((m) => ({ ...m }));
  const order = resolveOrder(next, entry.order);
  const slot = next.find((m) => m.order === order);
  if (slot) {
    slot.slug = entry.slug;
    slot.runId = entry.runId;
    slot.status = entry.status;
    if (entry.title !== undefined) {
      slot.title = entry.title; // 未指定なら既存 title を保持（フィールド代入なので触らなければ残る）
    }
  } else {
    next.push({ order, slug: entry.slug, runId: entry.runId, status: entry.status, title: entry.title });
  }
  next.sort((a, b) => a.order - b.order);
  return next;
}

// --fix（reconcile）でメンバーの status を run 側から導出する（proposal §影響範囲）。
//   - done への昇格は「export 工程 done」のときだけ（信号は §4 トリガと統一）。
//   - 既存 done は保持（旧 create 由来の done を巻き戻さない＝後方互換）。
//   - 既存 updating は保持（progress に痕跡が残らず復元できないため上書きしない）。
//   - それ以外（run はあるが未 export）は writing。
// downgrade は一切しない（done/updating を writing に落とさない）。
export function deriveMemberStatus(exportDone: boolean, prior: SeriesMemberStatus | undefined): SeriesMemberStatus {
  if (exportDone) {
    return "done";
  }
  if (prior === "done") {
    return "done";
  }
  if (prior === "updating") {
    return "updating";
  }
  return "writing";
}

// run の進捗（progress.events.jsonl が正本）に export 工程の done イベントがあるかを返す。
// best-effort（events が読めなければ false）。meta.steps.export は export が markDone を呼ばないため
// 当てにならない。export は recordProgress(step:"export", status:"done") を events に残すのでそれを見る。
export async function isExportDone(progress: RunProgress, runId: string): Promise<boolean> {
  const events = await progress.readEvents(runId).catch(() => []);
  return events.some((e) => e.step === "export" && e.status === "done");
}

export type SeriesConflict = string;

// series:status --fix 用の集計＋衝突検出（series-c1-plan §5 / D7）。
// 多義的状態は修復せず conflicts に積む（CLI が警告表示）。reconciled は run 側を正に埋め直した members。
// exportedRunIds は「export 工程 done」の run 集合（status 導出に使う・proposal §影響範囲）。
// 省略時は空集合＝全 run を未 export 扱い（既存 done/updating は deriveMemberStatus が保持する）。
export function reconcileMembers(
  existing: SeriesMember[],
  runs: RunMeta[],
  exportedRunIds: ReadonlySet<string> = new Set()
): { members: SeriesMember[]; conflicts: SeriesConflict[] } {
  const conflicts: SeriesConflict[] = [];

  // 衝突1: 同一シリーズで order 重複の run。
  const byOrder = new Map<number, string[]>();
  for (const r of runs) {
    const o = r.series?.order;
    if (o != null) {
      byOrder.set(o, [...(byOrder.get(o) ?? []), r.runId]);
    }
  }
  for (const [order, ids] of byOrder) {
    if (ids.length > 1) {
      conflicts.push(`order ${order} is claimed by multiple runs: ${ids.join(", ")}`);
    }
  }

  // 衝突2: 同じ runId が複数 member 枠に載る（既存 members 内）。
  const seen = new Set<string>();
  for (const m of existing) {
    if (m.runId && seen.has(m.runId)) {
      conflicts.push(`runId ${m.runId} appears in multiple member slots`);
    }
    if (m.runId) {
      seen.add(m.runId);
    }
  }

  // run 側を正として members を埋め直す（order 重複は上で警告済み・ここでは最初の1件で代表）。
  let members = existing.map((m) => ({ ...m }));
  for (const r of runs) {
    const order = r.series?.order;
    const slug = memberSlugFromRunId(r.runId);
    const dupOrder = order != null && (byOrder.get(order)?.length ?? 0) > 1;
    if (order == null || dupOrder) {
      continue; // order 不明・重複は自動修復しない（警告のみ）。
    }
    // 既存スロットの status を踏まえて run 側から status を導出（done/updating は保持・downgrade しない）。
    const prior = existing.find((m) => m.order === order)?.status;
    const status = deriveMemberStatus(exportedRunIds.has(r.runId), prior);
    members = upsertMember(members, { order, slug, runId: r.runId, status });

    // 衝突3: planned 枠の slug と runId 由来 slug が食い違う。
    const slot = existing.find((m) => m.order === order);
    if (slot && slot.slug && slot.slug !== slug && slot.status === "planned") {
      conflicts.push(`order ${order}: planned slug "${slot.slug}" != runId-derived slug "${slug}"`);
    }

    // 衝突4: voiceHash が run の voiceVersion に対応する voice ファイルの実 hash と不一致は
    //        CLI 側で series voice と突き合わせる（reconcile は members のみ扱う）。
  }

  return { members, conflicts };
}

// --- store orchestration ---

export async function seriesInit(
  slug: string,
  profile: string,
  seriesRoot?: string,
  referencesHeading?: string
): Promise<SeriesData> {
  const store = new SeriesStore(seriesRoot);
  return store.init(slug, profile, [], referencesHeading);
}

export async function seriesFreezeVoice(
  slug: string,
  voiceFile: string | undefined,
  seriesRoot?: string
): Promise<SeriesData> {
  const store = new SeriesStore(seriesRoot);
  const existing = await store.read(slug);
  if (!existing) {
    throw new Error(`Series not initialized: ${slug} (run series:init first)`);
  }

  if (existing.voice.frozen) {
    // 再 freeze: --voice-file 必須・voice.md 自身は不可（series-c1-plan §5.3 / D3）。
    if (!voiceFile) {
      throw new Error("Re-freeze requires --voice-file (omitting it would re-freeze the current voice.md)");
    }
    const resolved = resolve(voiceFile);
    if (resolved === resolve(store.seriesPath(slug), "voice.md")) {
      throw new Error("Re-freeze must not point --voice-file at series/<slug>/voice.md itself (use a separate file)");
    }
    const content = await readFile(resolved, "utf8");
    return store.freezeVoice(slug, content);
  }

  // 初回 freeze: --voice-file 省略時は in-place の voice.md を凍結。
  const content = voiceFile ? await readFile(resolve(voiceFile), "utf8") : await store.readVoice(slug);
  if (content.trim().length === 0) {
    throw new Error("Voice content is empty — write series/<slug>/voice.md (or pass --voice-file) before freezing");
  }
  return store.freezeVoice(slug, content);
}

// article:create --series の前処理（その1）: series を読み、create を許す状態か検証する。
// 未凍結 / voice 空 / 凍結後に voice.md が手編集された（hash 不一致）を弾く（series-c1-plan §10 step4 / §5.3）。
// profile 選択は呼び出し側（index）が series.profile を既定に決めるため、ここでは扱わない。
export async function readSeriesForCreate(
  slug: string,
  seriesRoot?: string
): Promise<{ data: SeriesData; voice: string }> {
  const store = new SeriesStore(seriesRoot);
  const data = await store.read(slug);
  if (!data) {
    throw new Error(`Series not found: ${slug} (run series:init + series:freeze-voice first)`);
  }
  if (!data.voice.frozen) {
    throw new Error(`Series voice is not frozen: ${slug} (run series:freeze-voice first)`);
  }
  const voice = await store.readVoice(slug);
  if (voice.trim().length === 0) {
    throw new Error(`Series voice.md is empty: ${slug}`);
  }
  // first-write-wins: 凍結後に voice.md を手編集して別内容で作成するのを防ぐ。
  // 変えたいなら series:freeze-voice で version を上げる（hash が変わって整合する）。
  if (voiceHash(voice) !== data.voice.hash) {
    throw new Error(
      `Series voice.md was edited after freeze (hash mismatch) for "${slug}". ` +
        `Re-freeze with series:freeze-voice to bump the version, or restore voice.md.`
    );
  }
  return { data, voice };
}

// article:create --series の前処理（その2）: effective profile を決め、profile 不一致を弾く。
// --series 時は series.profile を既定にし、明示 --profile が異なれば拒否（§5.2 / Codex P2）。
export function resolveSeriesProfile(
  seriesProfile: string,
  explicitProfile: string | undefined,
  allowProfileMismatch: boolean,
  slug: string
): string {
  if (explicitProfile && explicitProfile !== seriesProfile && !allowProfileMismatch) {
    throw new Error(
      `Profile mismatch: series "${slug}" uses "${seriesProfile}" but --profile is "${explicitProfile}" ` +
        `(pass --allow-profile-mismatch to override)`
    );
  }
  return explicitProfile ?? seriesProfile;
}

// 焼き込む RunSeriesMeta を組む。voiceHash は再計算せず凍結値（data.voice.hash）を使う
// （readSeriesForCreate が voice と data.voice.hash の一致を保証済み）。
export function buildSeriesMeta(data: SeriesData, order: number | undefined): RunSeriesMeta {
  return {
    seriesId: data.seriesId,
    role: "article",
    order,
    voiceVersion: data.voice.version,
    voiceHash: data.voice.hash,
  };
}

// article:export --out-dir 用の自動命名（追加課題D）。
// <seriesId>-<NN>-<slug>[-<platform>].md（NN は保存順 order の2桁ゼロ詰め・100以上は伸びる）。
// 番号は「束の中の通し番号（保存順）」であって記事タイトルの「第N回」とは一致しない場合がある。
// slug は series.json.members の runId 一致から取る（planned/手編集 slug と一致させる。前提: seriesId==ディレクトリ slug）。
export async function seriesExportFileName(meta: RunMeta, seriesRoot?: string): Promise<string> {
  const s = meta.series;
  if (!s) {
    throw new Error(`Run ${meta.runId} is not a series member (meta.series missing); --out-dir requires a series run`);
  }
  if (s.order == null) {
    throw new Error(`Run ${meta.runId} has no series order; run "series:status --fix" first`);
  }
  const store = new SeriesStore(seriesRoot);
  const data = await store.read(s.seriesId);
  if (!data) {
    throw new Error(`Series not found: ${s.seriesId}`);
  }
  const matched = data.members.filter((m) => m.runId === meta.runId);
  if (matched.length !== 1) {
    throw new Error(`Run ${meta.runId} matched ${matched.length} members in series ${s.seriesId}`);
  }
  const nn = String(s.order).padStart(2, "0");
  const platform = (meta.platform ?? "").toLowerCase();
  const suffix = platform ? `-${platform}` : "";
  return `${s.seriesId}-${nn}-${matched[0].slug}${suffix}.md`;
}

// 作成済み run を series.json.members へ反映する（create 成功後・run→series.json の順・§6.1）。
// 確定した order を返す（--order 省略時の自動採番値。呼び出し側が meta.json を backpatch するため）。
// series.json の read-modify-write は withLock で直列化し、並行 create の R1/R2 を防ぐ（§6.2 / C9）。
export async function recordMember(
  slug: string,
  runId: string,
  order: number | undefined,
  seriesRoot?: string
): Promise<number> {
  const store = new SeriesStore(seriesRoot);
  return store.withLock(slug, async () => {
    const data = await store.read(slug);
    if (!data) {
      throw new Error(`Series not found: ${slug}`); // 未作成は通常エラー（ロックは取得済み）
    }
    const memberSlug = validateSlug(memberSlugFromRunId(runId));
    // upsert 前に order を確定（壊れた series.json に runId 重複があっても正しい値を返せる）。
    const resolvedOrder = resolveOrder(data.members, order);
    // create 時点は「作成中」。done への昇格は export 工程（§4）が担う（proposal §2）。
    data.members = upsertMember(data.members, {
      order: resolvedOrder,
      slug: memberSlug,
      runId,
      status: "writing",
    });
    await store.write(slug, data);
    return resolvedOrder;
  });
}

// 候補名（title）から member slug を導く（series:plan で --member-slug 省略時）。
// 英数とハイフンに正規化。日本語タイトル等で slug 化できなければ呼び出し側に --member-slug を要求させる。
export function deriveMemberSlug(title: string): string | null {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.length > 0 ? slug : null;
}

// series:plan（最小・第2段先行）: planned 枠に候補名を upsert する（proposal §4）。
// withLock 内で series.json を read-modify-write。order 省略は末尾自動採番（新規＝安全）。
// 🔴 作成済みスロット（runId != null）への明示 order は拒否する（巻き戻し防止・決定3）。
// 返り値は確定 order。
export async function seriesPlan(
  slug: string,
  options: { title: string; order?: number; memberSlug?: string },
  seriesRoot?: string
): Promise<number> {
  const title = options.title.trim();
  if (title === "") {
    throw new Error("series:plan requires a non-empty --title");
  }
  const store = new SeriesStore(seriesRoot);
  return store.withLock(slug, async () => {
    const data = await store.read(slug);
    if (!data) {
      throw new Error(`Series not found: ${slug} (run series:init first)`);
    }
    const resolvedOrder = resolveOrder(data.members, options.order);
    // 🔴 巻き戻し guard: 既に run が紐づく order を planned に戻さない（series:plan は planned 枠専用）。
    const existing = data.members.find((m) => m.order === resolvedOrder);
    if (existing && existing.runId != null) {
      throw new Error(
        `order ${resolvedOrder} already has a created run ${existing.runId}; series:plan fills planned slots only`
      );
    }
    const memberSlug = options.memberSlug
      ? validateSlug(options.memberSlug)
      : validateSlug(
          deriveMemberSlug(title) ??
            (() => {
              throw new Error(
                `Could not derive a slug from title "${title}" (e.g. non-ASCII). Pass --member-slug <slug>.`
              );
            })()
        );
    data.members = upsertMember(data.members, {
      order: resolvedOrder,
      slug: memberSlug,
      runId: null,
      status: "planned",
      title,
    });
    await store.write(slug, data);
    return resolvedOrder;
  });
}

// /update-article（article:import --supersedes）でシリーズ membership を新 run に引き継ぐ（§6.2・案A）。
// import は新しい runId を作るため、放置すると series.json は旧 runId を指したまま＝新 run を export しても
// markMemberDone が対象を見つけられない。そこで supersedes 先メンバーがあればその枠の runId を新 run に
// 付け替え（status=updating＝更新中）、無ければ末尾に新規追加（status=writing）。旧 runId は新 run の
// meta.lineage に残るので情報は失われない（横の束は常に現行版の run を指す）。
// 返り値は新 run に焼く RunSeriesMeta（seriesId/order/voice）。withLock 内で series.json を read-modify-write。
export async function inheritSeriesMembership(
  slug: string,
  newRunId: string,
  opts: { supersedesRunId?: string; seriesRoot?: string } = {}
): Promise<RunSeriesMeta> {
  const store = new SeriesStore(opts.seriesRoot);
  return store.withLock(slug, async () => {
    const data = await store.read(slug);
    if (!data) {
      throw new Error(`Series not found: ${slug}`);
    }
    const memberSlug = validateSlug(memberSlugFromRunId(newRunId));
    const prior = opts.supersedesRunId
      ? data.members.find((m) => m.runId === opts.supersedesRunId)
      : undefined;
    const order = prior?.order ?? resolveOrder(data.members, undefined);
    // supersedes 先があれば「更新中」、無ければ（新規メンバー）「作成中」。
    const status: SeriesMemberStatus = prior ? "updating" : "writing";
    data.members = upsertMember(data.members, { order, slug: memberSlug, runId: newRunId, status });
    await store.write(slug, data);
    return buildSeriesMeta(data, order);
  });
}

// runId 一致のメンバーの status を更新する共通処理（withLock 内 read-modify-write・best-effort）。
// 束やメンバーが無ければ no-op（呼び出し側の本処理＝export/revise は止めない）。guard を渡すと
// 現 status が guard を満たすメンバーだけ更新する（変化なしなら書き込まない）。
async function setMemberStatusByRunId(
  slug: string,
  runId: string,
  status: SeriesMemberStatus,
  seriesRoot: string | undefined,
  guard?: (current: SeriesMemberStatus) => boolean
): Promise<void> {
  const store = new SeriesStore(seriesRoot);
  await store.withLock(slug, async () => {
    const data = await store.read(slug);
    if (!data) {
      return; // 束が無ければ何もしない（best-effort）
    }
    let changed = false;
    data.members = data.members.map((m) => {
      if (m.runId !== runId || m.status === status) {
        return m;
      }
      if (guard && !guard(m.status)) {
        return m;
      }
      changed = true;
      return { ...m, status };
    });
    if (changed) {
      await store.write(slug, data);
    }
  });
}

// export 成功後にメンバーを done にする（§4・runId 一致のメンバーのみ）。
export async function markMemberDone(slug: string, runId: string, seriesRoot?: string): Promise<void> {
  await setMemberStatusByRunId(slug, runId, "done", seriesRoot);
}

// done のメンバーが変更着手したら updating に戻す（§6.1・done のときだけ。writing 中は退行させない）。
export async function markMemberUpdating(slug: string, runId: string, seriesRoot?: string): Promise<void> {
  await setMemberStatusByRunId(slug, runId, "updating", seriesRoot, (current) => current === "done");
}

// revise 後にシリーズメンバーを done から updating に戻すべきかの判定（CLI: article:revise）。
// 戻すのは「シリーズに属する run（seriesId あり）」かつ「本文が実際に変わった（changed=true）」ときだけ。
//   - 空振り revise（changed=false＝LLM が同一テキストを返し final.md 不変）では戻さず done を据え置く。
//   - 非シリーズ run（seriesId なし）はそもそも対象外。
// 誤って常に false を返すと、本当の改稿後も done のままになり README が古い状態で固定される。
export function shouldRevertSeriesAfterRevise(seriesId: string | undefined, changed: boolean): boolean {
  return Boolean(seriesId) && changed;
}

// status 集計（読取）。run を集め、reconcile した members と衝突、voiceHash 不整合を返す。
export async function seriesStatus(
  slug: string,
  seriesRoot?: string,
  runsRoot?: string
): Promise<{
  data: SeriesData;
  members: SeriesMember[];
  conflicts: SeriesConflict[];
  warnings: string[];
  nullOrderRunIds: string[]; // series.order が欠落している run（--fix の meta.json backpatch 対象）
}> {
  const seriesStore = new SeriesStore(seriesRoot);
  const data = await seriesStore.read(slug);
  if (!data) {
    throw new Error(`Series not found: ${slug}`);
  }
  const runStore = new RunStore(runsRoot);
  const { runs, warnings } = await runStore.listSeriesRuns(data.seriesId);

  // 各 run の progress（正本 events.jsonl）から export 工程 done を best-effort で集める。
  // 読めない run は exported に入れない＝writing 扱いにフォールバック（reconcile 全体は落とさない）。
  // done への昇格信号を §4 トリガ（export）と統一する（meta.published は別工程なので使わない・proposal §影響範囲）。
  const progress = new RunProgress(runStore);
  const exportedRunIds = new Set<string>();
  for (const r of runs) {
    if (await isExportDone(progress, r.runId)) {
      exportedRunIds.add(r.runId);
    }
  }
  const { members, conflicts } = reconcileMembers(data.members, runs, exportedRunIds);

  // listSeriesRuns は既に seriesId 一致の run しか返さないので、order == null だけで足りる。
  const nullOrderRunIds = runs.filter((r) => r.series?.order == null).map((r) => r.runId);

  // 衝突4: 各 run の voiceHash を、その voiceVersion に対応する history ファイルの実 hash と突き合わせる。
  for (const r of runs) {
    const s = r.series;
    if (!s) {
      continue;
    }
    const entry = data.voice.history.find((h) => h.version === s.voiceVersion);
    if (!entry) {
      conflicts.push(`run ${r.runId}: voiceVersion ${s.voiceVersion} has no matching voice file in history`);
      continue;
    }
    const actual = await seriesStore.readVoiceVersionFile(slug, entry.file).catch(() => null);
    if (actual === null) {
      conflicts.push(`run ${r.runId}: voice file ${entry.file} (version ${s.voiceVersion}) missing`);
    } else if (voiceHash(actual) !== s.voiceHash) {
      conflicts.push(`run ${r.runId}: voiceHash mismatch against ${entry.file} (voice changed since bake-in)`);
    }
  }

  // slug 重複（補助識別子・§4.1）は warning。
  const slugCounts = new Map<string, number>();
  for (const m of members) {
    slugCounts.set(m.slug, (slugCounts.get(m.slug) ?? 0) + 1);
  }
  for (const [s, n] of slugCounts) {
    if (n > 1) {
      warnings.push(`duplicate member slug "${s}" across ${n} members (slug is a display aid; keys are order/runId)`);
    }
  }

  return { data, members, conflicts, warnings, nullOrderRunIds };
}

// Markdown テーブルのセル内 `|` をエスケープ（表崩れ防止）。
function mdCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

// README（人が読む日本語の派生ビュー）の状態ラベル。日本語に統一する（英語/日本語の混在を避ける・proposal §5）。
// done は「公開済み」ではなく「完成」（トリガは export＝書き出しで、公開台帳 record-publication とは別工程）。
// コンソール（series:status）は生 status キーの技術ビューとして英語のまま（役割で分ける）。
const MEMBER_STATUS_LABEL: Record<SeriesMemberStatus, string> = {
  planned: "⬜ 予定",
  writing: "🚧 作成中",
  updating: "✏️ 更新中",
  done: "✅ 完成",
};

// README を再生成して書き出す（CLI series:status --write と、create/export 後の自動再生成の共通経路）。
// members 省略時は series.json の現状を使う。onlyIfExists=true なら README が無ければ書かずに null を返す
// （自動再生成を「一度 --write した束だけ」に限定するため）。タイトルは各 run の meta.articleTitle から拾う。
export async function writeSeriesReadme(
  slug: string,
  opts: { members?: SeriesMember[]; seriesRoot?: string; runsRoot?: string; onlyIfExists?: boolean } = {}
): Promise<string | null> {
  const store = new SeriesStore(opts.seriesRoot);
  if (opts.onlyIfExists && !(await store.hasReadme(slug))) {
    return null;
  }
  const data = await store.read(slug);
  if (!data) {
    throw new Error(`Series not found: ${slug}`);
  }
  const members = opts.members ?? data.members;
  const runStore = new RunStore(opts.runsRoot);
  const titleByRunId = new Map<string, string>();
  for (const m of members) {
    if (!m.runId) {
      continue;
    }
    const meta = await runStore.readMeta(m.runId).catch(() => null);
    if (meta?.articleTitle) {
      titleByRunId.set(m.runId, meta.articleTitle);
    }
  }
  await store.writeReadme(slug, renderSeriesReadme(data, members, titleByRunId));
  return store.seriesPath(slug);
}

// series/<slug>/README.md（人が読む一覧・追加課題C）を組む純関数。series.json が正本・README は派生ビュー。
// titleByRunId は各メンバー run の meta.articleTitle（無い run は空）。# は保存順で「第N回」とは別軸。
export function renderSeriesReadme(
  data: SeriesData,
  members: SeriesMember[],
  titleByRunId: Map<string, string>
): string {
  const lines: string[] = [];
  lines.push(`# シリーズ: ${data.seriesId}（profile: ${data.profile} / voice v${data.voice.version}）`);
  lines.push("");
  lines.push("| # | 状態 | タイトル | slug | run |");
  lines.push("|---|------|---------|------|-----|");
  for (const m of members) {
    const status = MEMBER_STATUS_LABEL[m.status] ?? MEMBER_STATUS_LABEL.planned;
    // 表示優先順位（proposal §3）: 実 meta.articleTitle（作成・見直し後）＞ 候補 title ＞ プレースホルダ。
    const title =
      (m.runId && titleByRunId.get(m.runId)) ||
      m.title ||
      (m.runId ? "（タイトル未取得）" : "（未作成）");
    const run = m.runId ?? "（planned）";
    lines.push(`| ${m.order} | ${status} | ${mdCell(title)} | ${mdCell(m.slug)} | ${mdCell(run)} |`);
  }
  lines.push("");
  lines.push("> `#` は保存順（series.json の order）です。記事タイトル上の回番号（「第N回」）とは一致しない場合があります。");
  lines.push("> この一覧は `series:status --write` 実行時点のスナップショット（派生ビュー）で、照合の正本は `series.json` です。");
  return lines.join("\n");
}
