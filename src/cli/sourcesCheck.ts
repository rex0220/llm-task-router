import type { RawSource } from "../schemas/ClaimsSchema";
import { urlHash } from "./claimsNormalize";

// article:sources-check のコア（純粋寄り・I/O は注入 fetcher 経由）。
// URL の到達性を HTTP で確認し、reachable/checkedAt を sources.raw.json に stamp する素材を作る。
// 判定（dead に上げるもの）: 404/410 と、リトライ後も再現する NXDOMAIN（DNS 名前解決失敗・C-1）。
// それ以外（5xx・401/403・未解決3xx・timeout・接続拒否・TLS）は unknown（偽 dead を出さない）。
// 実通信は CLI 側が realFetcher を渡す。テストは fake fetcher で決定的にする。

export type Reachable = "ok" | "dead" | "unknown";

// 通信エラーの種別（D・判定入力を typed に＝NXDOMAIN→dead 昇格を決定的にテストできる）。
// nxdomain=DNS 名前解決失敗（恒久的） / timeout / connrefused=TCP 接続拒否 / tls=証明書等 / other。
export type ErrorKind = "nxdomain" | "timeout" | "connrefused" | "tls" | "other";

// fetcher は redirect を follow した「最終応答」の status を返す。到達不能/タイムアウト等は error+errorKind。
// deadlineMs（絶対 epoch ms・任意）は「この URL に費やせる総ウォールクロック期限」。実 fetcher は HEAD/GET の
// 各タイムアウトを min(timeoutMs, deadline - now) に切り詰め、合計待機がこの期限を大きく超えないようにする。
export type FetchOutcome = { status: number } | { error: string; errorKind: ErrorKind };
export type Fetcher = (url: string, opts: { timeoutMs: number; deadlineMs?: number }) => Promise<FetchOutcome>;

export type CheckResult = { reachable: Reachable; checkedAt: string };

// リトライ対象（D）: timeout / 接続拒否 / NXDOMAIN のみ。確定的な status 結果（2xx/404/410 等）は
// 即確定で再試行しない。tls/other は再試行しても結論が変わりにくいので unknown 確定。
const RETRYABLE_KINDS: ReadonlySet<ErrorKind> = new Set(["timeout", "connrefused", "nxdomain"]);

export function isRetryable(outcome: FetchOutcome): boolean {
  return "error" in outcome && RETRYABLE_KINDS.has(outcome.errorKind);
}

// 最終 outcome → reachable（redirect follow 後・リトライ後を前提）。
export function classifyReachable(outcome: FetchOutcome): Reachable {
  if ("error" in outcome) {
    // NXDOMAIN（DNS 名前解決失敗）は「恒久的に存在しない」クラスとして dead に昇格（C-1）。
    // リトライ後も再現したものだけがここに来る（checkOneWithRetry が再確認する）。
    // 接続拒否(connrefused)/timeout/tls/other は一時障害・bot ブロックの可能性があり unknown のまま。
    return outcome.errorKind === "nxdomain" ? "dead" : "unknown";
  }
  const s = outcome.status;
  if (s >= 200 && s < 300) {
    return "ok";
  }
  if (s === 404 || s === 410) {
    return "dead"; // 恒久的に存在しない
  }
  // 401/403/その他4xx・5xx・解決できない3xx は機械では断定しない
  return "unknown";
}

export type RetryOptions = {
  timeoutMs: number;
  maxRetries: number; // 追加試行回数（0 = 単発）
  backoffMs: readonly number[]; // 各リトライ前の待機（指数バックオフ。末尾値を超えたら末尾を流用）
  maxTotalMs: number; // 1 URL あたりの合計待機上限（超過しそうなら打ち切り＝レイテンシ上限を切る）
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

// 既定のリトライ設定（D の受け入れ基準: 合計待機上限 ~15 秒）。
export const DEFAULT_RETRY: Omit<RetryOptions, "timeoutMs" | "sleep" | "now"> = {
  maxRetries: 2,
  backoffMs: [500, 1500],
  maxTotalMs: 15_000,
};

// 1 URL を到達確認し、リトライ対象なら指数バックオフで再試行する（合計ウォールクロック期限で打ち切り）。
// fetcher 自身が HEAD→GET フォールバック等を内包する想定。確定結果（status）は即返す。
// maxTotalMs は「待機」だけでなく fetch 実行も含む総期限とし、各 fetch の timeoutMs を残り時間に切り詰める
// ことで、遅延 URL でも合計が maxTotalMs を大きく超えないようにする（レビュー指摘・実ウォールクロック上限）。
export async function checkOneWithRetry(url: string, fetcher: Fetcher, opts: RetryOptions): Promise<FetchOutcome> {
  const deadline = opts.now() + opts.maxTotalMs;
  const effectiveTimeout = (): number => Math.max(0, Math.min(opts.timeoutMs, deadline - opts.now()));
  let outcome = await fetcher(url, { timeoutMs: effectiveTimeout(), deadlineMs: deadline });
  let attempt = 0;
  while (isRetryable(outcome) && attempt < opts.maxRetries) {
    const backoff = opts.backoffMs[Math.min(attempt, opts.backoffMs.length - 1)] ?? 0;
    // backoff 後に少しでも fetch する余地が無い（期限到達）なら、これ以上は再試行せず確定する。
    if (opts.now() + backoff >= deadline) {
      break;
    }
    await opts.sleep(backoff);
    if (opts.now() >= deadline) {
      break;
    }
    outcome = await fetcher(url, { timeoutMs: effectiveTimeout(), deadlineMs: deadline });
    attempt += 1;
  }
  return outcome;
}

// 並行数を超えないように tasks を順に消化する（順序非依存）。
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const size = Math.max(1, limit);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
}

// 与えた URL 群を到達確認し、urlHash → {reachable, checkedAt} を返す。
// 同一 canonical URL（同じ urlHash）は1回だけ fetch する（重複排除）。
export async function checkSources(
  urls: string[],
  fetcher: Fetcher,
  opts: {
    concurrency: number;
    timeoutMs: number;
    today: string;
    // リトライ設定（D）。省略時は単発（後方互換）。CLI は DEFAULT_RETRY＋実 sleep/now を渡す。
    retry?: Partial<RetryOptions>;
  }
): Promise<Map<string, CheckResult>> {
  // urlHash でユニーク化（先勝ちで代表 URL を持つ）。invalid URL はスキップ。
  const unique = new Map<string, string>(); // urlHash -> url
  for (const url of urls) {
    let h: string;
    try {
      h = urlHash(url);
    } catch {
      continue; // 不正 URL は対象外
    }
    if (!unique.has(h)) {
      unique.set(h, url);
    }
  }

  // リトライ設定を解決（retry 未指定なら単発＝maxRetries 0 で後方互換）。
  const retry: RetryOptions = {
    timeoutMs: opts.timeoutMs,
    maxRetries: opts.retry?.maxRetries ?? 0,
    backoffMs: opts.retry?.backoffMs ?? DEFAULT_RETRY.backoffMs,
    maxTotalMs: opts.retry?.maxTotalMs ?? DEFAULT_RETRY.maxTotalMs,
    sleep: opts.retry?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: opts.retry?.now ?? Date.now,
  };

  const results = new Map<string, CheckResult>();
  const entries = [...unique.entries()];
  await runPool(entries, opts.concurrency, async ([h, url]) => {
    const outcome = await checkOneWithRetry(url, fetcher, retry);
    results.set(h, { reachable: classifyReachable(outcome), checkedAt: opts.today });
  });
  return results;
}

// results（urlHash 単位）を raw source へ反映する。同一 canonical URL が複数 key で出たら全て stamp。
// raw に無い URL（results にのみある）は対象外。新しい配列を返す（入力は変更しない）。
export function applyReachabilityToRaw(
  rawSources: RawSource[],
  results: Map<string, CheckResult>
): RawSource[] {
  return rawSources.map((rs) => {
    let h: string;
    try {
      h = urlHash(rs.url);
    } catch {
      return rs;
    }
    const r = results.get(h);
    if (!r) {
      return rs;
    }
    return { ...rs, reachable: r.reachable, checkedAt: r.checkedAt };
  });
}

export type ReachabilitySummary = { ok: number; dead: number; unknown: number };

export function summarize(results: Map<string, CheckResult>): ReachabilitySummary {
  const summary: ReachabilitySummary = { ok: 0, dead: 0, unknown: 0 };
  for (const { reachable } of results.values()) {
    summary[reachable] += 1;
  }
  return summary;
}
