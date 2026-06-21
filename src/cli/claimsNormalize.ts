import { createHash } from "node:crypto";
import type { RunStore } from "../storage/RunStore";
import {
  ClaimsLedgerSchema,
  RawClaimsSchema,
  RawSourcesSchema,
  type Claim,
  type ClaimsLedger,
  type LedgerClaim,
  type LedgerSource,
  type RawClaim,
  type RawSource,
  type Source,
} from "../schemas/ClaimsSchema";

// docs/claims-schema-notes.md の確定形を実装する。
// - identity は claim 文の hash のみ（anchorHash と id の hash8 は同一値）。
// - source の安定主キーは正規化 URL hash（raw key ではない）。
// - 採番（CNNN-<hash8> / SNNN）はすべてここ（コード）で行う。LLM に hash を計算させない。
// - lifecycle は「今回の raw（current observed set）」と台帳の比較で更新。scope=full のときだけ removed 判定。

export const LEDGER_FILE = "claims-ledger.json";
export const CLAIMS_FILE = "claims.json";
export const SOURCES_FILE = "sources.json";
export const RAW_CLAIMS_FILE = "claims.raw.json";
export const RAW_SOURCES_FILE = "sources.raw.json";

const HASH_LEN = 8;

export type NormalizeScope = "full" | "diff";

export type NormalizeSummary = {
  runId: string;
  round: number;
  scope: NormalizeScope;
  claimsTotal: number;
  present: number;
  removed: number;
  sources: number;
  blocking: number;
};

// クエリから外すトラッキング系（順序非依存・大小無視）。utm_* は接頭辞で別途除去。
const TRACKING_PARAMS = new Set(["gclid", "fbclid", "mc_cid", "mc_eid", "igshid", "ref", "ref_src"]);

// URL を正規化して安定主キーの素にする。細部は P5 fixture で固定（docs/claims-schema-notes.md 未決事項）。
export function canonicalUrl(raw: string): string {
  const u = new URL(raw);
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
    u.port = "";
  }
  u.hash = "";
  const kept = [...u.searchParams.entries()].filter(
    ([k]) => !/^utm_/i.test(k) && !TRACKING_PARAMS.has(k.toLowerCase())
  );
  kept.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  u.search = "";
  for (const [k, v] of kept) {
    u.searchParams.append(k, v);
  }
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }
  return u.toString();
}

export function normalizeClaimText(claim: string): string {
  return claim.replace(/\s+/g, " ").trim();
}

function hash8(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, HASH_LEN);
}

export function claimHash(claim: string): string {
  return hash8(normalizeClaimText(claim));
}

export function urlHash(url: string): string {
  return hash8(canonicalUrl(url));
}

function emptyLedger(): ClaimsLedger {
  return { round: 0, lastSeq: 0, lastSourceSeq: 0, claims: [], sources: [] };
}

async function readLedgerFile(store: RunStore, runId: string): Promise<ClaimsLedger | null> {
  return store.read(runId, LEDGER_FILE).then(
    (content) => ClaimsLedgerSchema.parse(JSON.parse(content)),
    () => null
  );
}

// 台帳を解決する。current run に無ければ meta.lineage.supersedesRunId（更新前の版）の
// 台帳を seed として継承する（claims-recheck と同じ lineage フォールバック）。
// これで更新 run の差分再検証後も、未変更 claim / source / id 順序が前版から引き継がれる。
// 注: store.read は新しい文字列を JSON.parse するので seed は deep copy。前版ファイルは書き換えない。
async function readLedger(store: RunStore, runId: string): Promise<ClaimsLedger> {
  const own = await readLedgerFile(store, runId);
  if (own) {
    return own;
  }
  const meta = await store.readMeta(runId).catch(() => null);
  const prev = meta?.lineage?.supersedesRunId;
  if (prev) {
    const seed = await readLedgerFile(store, prev);
    if (seed) {
      return seed;
    }
  }
  return emptyLedger();
}

// raw source を台帳へマージし、urlHash→SNNN を確定する。同一 URL の再出現は既存 SNNN を再利用。
// reachable は raw を正本として伝播（未記録は省略）。replacedBy はここでは常にクリアし、
// 全 source の id 確定後の2パス目で raw.replacedByKey から解決して設定する。
function mergeSource(ledger: ClaimsLedger, raw: RawSource): LedgerSource {
  const h = urlHash(raw.url);
  const existing = ledger.sources.find((s) => s.urlHash === h);
  if (existing) {
    // 内容（タイトル等）は最新で上書き。id/urlHash は安定。
    existing.url = raw.url;
    existing.title = raw.title;
    existing.retrievedAt = raw.retrievedAt;
    existing.sourceType = raw.sourceType;
    existing.summary = raw.summary;
    existing.reachable = raw.reachable; // 未記録（undefined）なら省略へ戻す
    existing.replacedBy = undefined; // 2パス目で再設定
    return existing;
  }
  ledger.lastSourceSeq += 1;
  const created: LedgerSource = {
    id: `S${String(ledger.lastSourceSeq).padStart(3, "0")}`,
    urlHash: h,
    url: raw.url,
    title: raw.title,
    retrievedAt: raw.retrievedAt,
    sourceType: raw.sourceType,
    summary: raw.summary,
    reachable: raw.reachable,
    cited: false, // 後段で claims から再計算
  };
  ledger.sources.push(created);
  return created;
}

// 1つの ref（raw key か URL）を SNNN へ解決する（replacedByKey 用。全 id 確定後に呼ぶ）。
function resolveOneSourceId(ref: string, ledger: ClaimsLedger, keyToUrlHash: Map<string, string>): string {
  let h = keyToUrlHash.get(ref);
  if (!h) {
    try {
      h = urlHash(ref);
    } catch {
      throw new Error(`replacedByKey is neither a known key nor a valid URL: ${ref}`);
    }
  }
  const src = ledger.sources.find((s) => s.urlHash === h);
  if (!src) {
    throw new Error(`replacedByKey does not resolve to any declared source: ${ref}`);
  }
  return src.id;
}

// claim の sourceRefs（URL か raw source の key）を SNNN の配列へ解決する。
function resolveSourceIds(
  refs: string[],
  ledger: ClaimsLedger,
  keyToUrlHash: Map<string, string>
): string[] {
  const ids = new Set<string>();
  for (const ref of refs) {
    let h = keyToUrlHash.get(ref);
    if (!h) {
      // key で引けなければ URL とみなして正規化 hash で台帳を引く。
      try {
        h = urlHash(ref);
      } catch {
        throw new Error(`sourceRef is neither a known key nor a valid URL: ${ref}`);
      }
    }
    const src = ledger.sources.find((s) => s.urlHash === h);
    if (!src) {
      throw new Error(`sourceRef does not resolve to any declared source: ${ref}`);
    }
    ids.add(src.id);
  }
  return [...ids].sort();
}

// raw claim を台帳へマージ（同一 claim hash の再出現は既存 id を再利用、新規だけ採番）。
function mergeClaim(ledger: ClaimsLedger, raw: RawClaim, sourceIds: string[], round: number): void {
  const h = claimHash(raw.claim);
  const existing = ledger.claims.find((c) => c.hash === h);
  if (existing) {
    existing.claim = raw.claim;
    existing.location = { heading: raw.location.heading, anchorHash: h };
    existing.type = raw.type;
    existing.status = raw.status;
    existing.lifecycle = "present";
    existing.sourceIds = sourceIds;
    existing.severity = raw.severity;
    existing.note = raw.note;
    existing.lastRound = round;
    return;
  }
  ledger.lastSeq += 1;
  const created: LedgerClaim = {
    id: `C${String(ledger.lastSeq).padStart(3, "0")}-${h}`,
    hash: h,
    claim: raw.claim,
    location: { heading: raw.location.heading, anchorHash: h },
    type: raw.type,
    status: raw.status,
    lifecycle: "present",
    sourceIds,
    severity: raw.severity,
    note: raw.note,
    firstRound: round,
    lastRound: round,
  };
  ledger.claims.push(created);
}

// scope=full のとき: 今回の観測に無い既存 present claim を removed にする（closeMissing 相当）。
function closeMissing(ledger: ClaimsLedger, observed: Set<string>, round: number): void {
  for (const c of ledger.claims) {
    if (c.lifecycle === "present" && !observed.has(c.hash)) {
      c.lifecycle = "removed";
      c.lastRound = round;
    }
  }
}

export function isBlocking(c: Pick<Claim, "lifecycle" | "severity" | "status">): boolean {
  return (
    c.lifecycle === "present" &&
    (c.severity === "critical" || c.severity === "major") &&
    (c.status === "unverified" || c.status === "needs-source" || c.status === "incorrect")
  );
}

function toPublicClaim(c: LedgerClaim): Claim {
  return {
    id: c.id,
    claim: c.claim,
    location: c.location,
    type: c.type,
    status: c.status,
    lifecycle: c.lifecycle,
    sourceIds: c.sourceIds,
    severity: c.severity,
    note: c.note,
  };
}

// present かつ verified な claim が参照する sourceId 集合（cited 判定の正本。references と共有）。
export function collectCitedSourceIds(
  claims: Pick<Claim, "lifecycle" | "status" | "sourceIds">[]
): Set<string> {
  const ids = new Set<string>();
  for (const c of claims) {
    if (c.lifecycle === "present" && c.status === "verified") {
      for (const sid of c.sourceIds) {
        ids.add(sid);
      }
    }
  }
  return ids;
}

function toPublicSource(s: LedgerSource): Source {
  const out: Source = {
    id: s.id,
    url: s.url,
    title: s.title,
    retrievedAt: s.retrievedAt,
    sourceType: s.sourceType,
    summary: s.summary,
    cited: s.cited ?? false,
  };
  // reachable / replacedBy は値があるときだけ出す（未記録は省略）。
  if (s.reachable !== undefined) {
    out.reachable = s.reachable;
  }
  if (s.replacedBy !== undefined) {
    out.replacedBy = s.replacedBy;
  }
  return out;
}

export async function normalizeClaims(
  store: RunStore,
  runId: string,
  scope: NormalizeScope
): Promise<NormalizeSummary> {
  const rawClaims = RawClaimsSchema.parse(JSON.parse(await store.read(runId, RAW_CLAIMS_FILE)));
  // sources.raw.json は任意（出典ゼロの run もある）。無ければ空配列。
  const rawSources = await store.read(runId, RAW_SOURCES_FILE).then(
    (content) => RawSourcesSchema.parse(JSON.parse(content)),
    () => []
  );

  const ledger = await readLedger(store, runId);
  const round = ledger.round + 1;

  const keyToUrlHash = new Map<string, string>();
  const pendingReplaced: { source: LedgerSource; replacedByKey: string }[] = [];
  for (const rs of rawSources) {
    const merged = mergeSource(ledger, rs);
    keyToUrlHash.set(rs.key, merged.urlHash);
    if (rs.replacedByKey !== undefined) {
      pendingReplaced.push({ source: merged, replacedByKey: rs.replacedByKey });
    }
  }
  // 2パス目: 全 source の id が確定した後に replacedByKey → SNNN を解決（後方参照を許す）。
  for (const { source, replacedByKey } of pendingReplaced) {
    const targetId = resolveOneSourceId(replacedByKey, ledger, keyToUrlHash);
    if (targetId === source.id) {
      throw new Error(`source ${source.id} の replacedBy が自分自身を指しています（自己参照は不可）。`);
    }
    source.replacedBy = targetId;
  }

  const observed = new Set<string>();
  for (const rc of rawClaims) {
    const sourceIds = resolveSourceIds(rc.sourceRefs, ledger, keyToUrlHash);
    mergeClaim(ledger, rc, sourceIds, round);
    observed.add(claimHash(rc.claim));
  }

  if (scope === "full") {
    closeMissing(ledger, observed, round);
  }

  ledger.round = round;

  // cited を claims から再計算して全 source に焼き込む（present かつ verified の参照のみ）。
  const citedIds = collectCitedSourceIds(ledger.claims);
  for (const s of ledger.sources) {
    s.cited = citedIds.has(s.id);
  }

  const claims = ledger.claims.map(toPublicClaim);
  const sources = ledger.sources.map(toPublicSource);

  await store.save(runId, LEDGER_FILE, JSON.stringify(ledger, null, 2));
  await store.save(runId, CLAIMS_FILE, JSON.stringify(claims, null, 2));
  await store.save(runId, SOURCES_FILE, JSON.stringify(sources, null, 2));

  const present = claims.filter((c) => c.lifecycle === "present").length;
  return {
    runId,
    round,
    scope,
    claimsTotal: claims.length,
    present,
    removed: claims.length - present,
    sources: sources.length,
    blocking: claims.filter(isBlocking).length,
  };
}
