import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateSlug } from "../storage/meta";
import type { RunMeta, RunSeriesMeta } from "../storage/RunStore";
import { RunStore } from "../storage/RunStore";
import { SeriesStore, voiceHash } from "../storage/SeriesStore";
import { memberSlugFromRunId, type SeriesData, type SeriesMember } from "../storage/seriesMeta";

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
export function upsertMember(
  members: SeriesMember[],
  entry: { order?: number; slug: string; runId: string }
): SeriesMember[] {
  const next = members.map((m) => ({ ...m }));
  const order = resolveOrder(next, entry.order);
  const slot = next.find((m) => m.order === order);
  if (slot) {
    slot.slug = entry.slug;
    slot.runId = entry.runId;
    slot.status = "done";
  } else {
    next.push({ order, slug: entry.slug, runId: entry.runId, status: "done" });
  }
  next.sort((a, b) => a.order - b.order);
  return next;
}

export type SeriesConflict = string;

// series:status --fix 用の集計＋衝突検出（series-c1-plan §5 / D7）。
// 多義的状態は修復せず conflicts に積む（CLI が警告表示）。reconciled は run 側を正に埋め直した members。
export function reconcileMembers(
  existing: SeriesMember[],
  runs: RunMeta[]
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
    members = upsertMember(members, { order, slug, runId: r.runId });

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

export async function seriesInit(slug: string, profile: string, seriesRoot?: string): Promise<SeriesData> {
  const store = new SeriesStore(seriesRoot);
  return store.init(slug, profile);
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
    data.members = upsertMember(data.members, { order: resolvedOrder, slug: memberSlug, runId });
    await store.write(slug, data);
    return resolvedOrder;
  });
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
  const { members, conflicts } = reconcileMembers(data.members, runs);

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
