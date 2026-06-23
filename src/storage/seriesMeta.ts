// series.json（シリーズの横の束）のスキーマと検証（series-c1-plan §4）。
// published/lineage と別軸の series container の正本。run 側の RunSeriesMeta（RunStore）と対応する。
import { validateSafeId, validateSlug } from "./meta";

export const SERIES_FORMAT_VERSION = 1;

// voice の出所（手書き / exemplar run / 外部ファイル）。単一 runId に縛らず配列で集約する。
export type SeriesVoiceProvenance =
  | { kind: "handwritten" }
  | { kind: "exemplar-run"; runId: string }
  | { kind: "external-file"; path: string };

// voice 各版の索引（version → file）。検証の正本は実ファイル再計算 hash（§6.1）、ここは索引。
export type SeriesVoiceHistoryEntry = {
  version: number;
  hash: string; // 保存後 UTF-8 の sha256 hex
  file: string; // 現行版は voice.md、旧版は voice-v<N>.md
};

export type SeriesVoice = {
  frozen: boolean; // first-write-wins。未凍結なら create を拒否
  version: number; // 現行版。run 側 voiceVersion と対応
  frozenAt: string;
  hash: string; // 現行 voice.md の hash
  history: SeriesVoiceHistoryEntry[];
  provenance: SeriesVoiceProvenance[];
};

export type SeriesMemberStatus = "planned" | "done";

export type SeriesMember = {
  order: number;
  slug: string; // 表示・補助識別子（照合主キーは order/runId・§4.1）
  runId: string | null; // 未作成枠は null
  status: SeriesMemberStatus;
};

export type SeriesData = {
  version: number; // 封筒（SERIES_FORMAT_VERSION）
  seriesId: string;
  profile: string;
  voice: SeriesVoice;
  members: SeriesMember[];
};

// seriesId は series/<slug> の識別子かつ status 集計のキーになり得るため、
// 予約キー（__proto__ 等）まで弾く validateSlug を使う（validateSafeId 単体は弾かない）。
export function validateSeriesId(seriesId: string): string {
  return validateSlug(seriesId);
}

// runId から日付 prefix（YYYY-MM-DD-）を除いた member slug を導く（§4.1）。
// createRunId 採番なら [a-z0-9-] のみだが、--run 明示は createRunId を通らないため
// 呼び出し側で validateSlug する前提（ここは prefix 除去のみ）。
export function memberSlugFromRunId(runId: string): string {
  return runId.replace(/^\d{4}-\d{2}-\d{2}-/, "");
}

// series.json を検証する。破損（不正JSON・非オブジェクト・型不一致）は空扱いにせず throw し、
// 他データを失わせない（ExportIndex と同方針）。
export function validateSeriesData(parsed: unknown, source = "series.json"): SeriesData {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Corrupt ${source} (expected a JSON object).`);
  }
  const data = parsed as Record<string, unknown>;
  const seriesId = validateSeriesId(String(data.seriesId ?? ""));
  if (typeof data.profile !== "string" || data.profile.length === 0) {
    throw new Error(`Corrupt ${source} (missing profile).`);
  }
  const voice = validateVoice(data.voice, source);
  const members = validateMembers(data.members, source);
  return {
    version: typeof data.version === "number" ? data.version : SERIES_FORMAT_VERSION,
    seriesId,
    profile: data.profile,
    voice,
    members,
  };
}

function validateVoice(value: unknown, source: string): SeriesVoice {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Corrupt ${source} (voice must be an object).`);
  }
  const v = value as Record<string, unknown>;
  const history = Array.isArray(v.history)
    ? v.history.map((h, i) => validateHistoryEntry(h, i, source))
    : [];
  const provenance = Array.isArray(v.provenance) ? (v.provenance as SeriesVoiceProvenance[]) : [];
  const version = typeof v.version === "number" ? v.version : 0;
  if (v.frozen === true) {
    // 凍結済みなら現行版が history 末尾に存在する整合を要求する（§4 ガード）。
    const top = history[history.length - 1];
    if (!top || top.version !== version) {
      throw new Error(`Corrupt ${source} (voice.version ${version} not at history tail).`);
    }
  }
  return {
    frozen: v.frozen === true,
    version,
    frozenAt: typeof v.frozenAt === "string" ? v.frozenAt : "",
    hash: typeof v.hash === "string" ? v.hash : "",
    history,
    provenance,
  };
}

function validateHistoryEntry(value: unknown, index: number, source: string): SeriesVoiceHistoryEntry {
  if (value === null || typeof value !== "object") {
    throw new Error(`Corrupt ${source} (voice.history[${index}] must be an object).`);
  }
  const h = value as Record<string, unknown>;
  if (typeof h.version !== "number" || typeof h.hash !== "string" || typeof h.file !== "string") {
    throw new Error(`Corrupt ${source} (voice.history[${index}] missing version/hash/file).`);
  }
  return { version: h.version, hash: h.hash, file: h.file };
}

function validateMembers(value: unknown, source: string): SeriesMember[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Corrupt ${source} (members must be an array).`);
  }
  return value.map((m, i) => {
    if (m === null || typeof m !== "object") {
      throw new Error(`Corrupt ${source} (members[${i}] must be an object).`);
    }
    const member = m as Record<string, unknown>;
    if (typeof member.order !== "number") {
      throw new Error(`Corrupt ${source} (members[${i}].order must be a number).`);
    }
    const slug = validateSlug(String(member.slug ?? ""));
    const runId = member.runId == null ? null : validateSafeId(String(member.runId), "runId");
    const status = member.status === "done" ? "done" : "planned";
    return { order: member.order, slug, runId, status };
  });
}
