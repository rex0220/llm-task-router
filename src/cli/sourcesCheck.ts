import type { RawSource } from "../schemas/ClaimsSchema";
import { urlHash } from "./claimsNormalize";

// article:sources-check のコア（純粋寄り・I/O は注入 fetcher 経由）。
// URL の到達性を HTTP で確認し、reachable/checkedAt を sources.raw.json に stamp する素材を作る。
// 判定は保守的（「迷ったら unknown」）: dead は 404/410 のみ。5xx・401/403・未解決3xx・通信エラーは unknown。
// 実通信は CLI 側が realFetcher を渡す。テストは fake fetcher で決定的にする。

export type Reachable = "ok" | "dead" | "unknown";

// fetcher は redirect を follow した「最終応答」の status を返す。到達不能/タイムアウト等は error。
export type FetchOutcome = { status: number } | { error: string };
export type Fetcher = (url: string, opts: { timeoutMs: number }) => Promise<FetchOutcome>;

export type CheckResult = { reachable: Reachable; checkedAt: string };

// 最終 status → reachable（redirect follow 後を前提）。dead は 404/410 のみ。
export function classifyReachable(outcome: FetchOutcome): Reachable {
  if ("error" in outcome) {
    return "unknown"; // 通信エラー/タイムアウト/DNS は transient を dead にしない
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
  opts: { concurrency: number; timeoutMs: number; today: string }
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

  const results = new Map<string, CheckResult>();
  const entries = [...unique.entries()];
  await runPool(entries, opts.concurrency, async ([h, url]) => {
    const outcome = await fetcher(url, { timeoutMs: opts.timeoutMs });
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
