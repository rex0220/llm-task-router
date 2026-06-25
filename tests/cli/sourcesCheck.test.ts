import { describe, expect, it } from "vitest";
import {
  classifyReachable,
  checkSources,
  checkOneWithRetry,
  isRetryable,
  applyReachabilityToRaw,
  summarize,
  type Fetcher,
  type FetchOutcome,
  type RetryOptions,
} from "../../src/cli/sourcesCheck";
import { urlHash } from "../../src/cli/claimsNormalize";
import type { RawSource } from "../../src/schemas/ClaimsSchema";

function raw(url: string, over: Partial<RawSource> = {}): RawSource {
  return { key: url, url, title: "", retrievedAt: "2026-06-20", sourceType: "secondary", summary: "", ...over };
}

describe("classifyReachable", () => {
  it("maps 2xx to ok", () => {
    expect(classifyReachable({ status: 200 })).toBe("ok");
    expect(classifyReachable({ status: 204 })).toBe("ok");
  });
  it("maps only 404/410 to dead", () => {
    expect(classifyReachable({ status: 404 })).toBe("dead");
    expect(classifyReachable({ status: 410 })).toBe("dead");
  });
  it("maps 401/403/other 4xx, 5xx, unresolved 3xx to unknown", () => {
    for (const s of [301, 302, 401, 403, 429, 451, 500, 503]) {
      expect(classifyReachable({ status: s })).toBe("unknown");
    }
  });
  it("maps connrefused/timeout/tls/other errors to unknown (no false dead)", () => {
    expect(classifyReachable({ error: "refused", errorKind: "connrefused" })).toBe("unknown");
    expect(classifyReachable({ error: "aborted", errorKind: "timeout" })).toBe("unknown");
    expect(classifyReachable({ error: "cert", errorKind: "tls" })).toBe("unknown");
    expect(classifyReachable({ error: "?", errorKind: "other" })).toBe("unknown");
  });
  it("promotes NXDOMAIN to dead (C-1)", () => {
    expect(classifyReachable({ error: "ENOTFOUND", errorKind: "nxdomain" })).toBe("dead");
  });
});

describe("isRetryable", () => {
  it("retries timeout/connrefused/nxdomain, not status results or tls/other", () => {
    expect(isRetryable({ error: "x", errorKind: "timeout" })).toBe(true);
    expect(isRetryable({ error: "x", errorKind: "connrefused" })).toBe(true);
    expect(isRetryable({ error: "x", errorKind: "nxdomain" })).toBe(true);
    expect(isRetryable({ error: "x", errorKind: "tls" })).toBe(false);
    expect(isRetryable({ error: "x", errorKind: "other" })).toBe(false);
    expect(isRetryable({ status: 200 })).toBe(false);
    expect(isRetryable({ status: 404 })).toBe(false);
  });
});

describe("checkOneWithRetry", () => {
  // 決定的にするため sleep/now は注入（実時間に依存しない）。
  function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
    let t = 0;
    return { now: () => t, sleep: async (ms) => { t += ms; } };
  }
  const base = (over: Partial<RetryOptions>): RetryOptions => ({
    timeoutMs: 1000,
    maxRetries: 2,
    backoffMs: [500, 1500],
    maxTotalMs: 15_000,
    ...fakeClock(),
    ...over,
  });

  it("does not retry a confirmed status result (404)", async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => { calls++; return { status: 404 }; };
    const r = await checkOneWithRetry("https://x", fetcher, base({}));
    expect(calls).toBe(1);
    expect(classifyReachable(r)).toBe("dead");
  });

  it("retries a transient timeout then succeeds", async () => {
    const seq: FetchOutcome[] = [{ error: "t", errorKind: "timeout" }, { status: 200 }];
    let i = 0;
    const fetcher: Fetcher = async () => seq[Math.min(i++, seq.length - 1)];
    const r = await checkOneWithRetry("https://x", fetcher, base({}));
    expect(i).toBe(2); // 1 retry
    expect(classifyReachable(r)).toBe("ok");
  });

  it("re-confirms NXDOMAIN across retries before classifying dead", async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => { calls++; return { error: "ENOTFOUND", errorKind: "nxdomain" }; };
    const r = await checkOneWithRetry("https://x", fetcher, base({ maxRetries: 2 }));
    expect(calls).toBe(3); // 初回 + 2 retries
    expect(classifyReachable(r)).toBe("dead");
  });

  it("stops retrying once the total wait budget would be exceeded", async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => { calls++; return { error: "t", errorKind: "timeout" }; };
    // backoff 500 で2回目以降 maxTotalMs=600 を超えるので、初回+1回で打ち切り。
    const r = await checkOneWithRetry("https://x", fetcher, base({ maxRetries: 5, backoffMs: [500, 1500], maxTotalMs: 600 }));
    expect(calls).toBe(2);
    expect(classifyReachable(r)).toBe("unknown");
  });

  it("shares one deadline and shrinks per-call timeout as time is consumed (sleep)", async () => {
    let t = 0;
    const now = (): number => t;
    const sleep = async (ms: number): Promise<void> => { t += ms; };
    const seenTimeouts: number[] = [];
    const seenDeadlines: (number | undefined)[] = [];
    const fetcher: Fetcher = async (_url, opts) => {
      seenTimeouts.push(opts.timeoutMs);
      seenDeadlines.push(opts.deadlineMs);
      return { error: "t", errorKind: "timeout" };
    };
    await checkOneWithRetry("https://x", fetcher, {
      timeoutMs: 1000, maxRetries: 3, backoffMs: [200], maxTotalMs: 600, sleep, now,
    });
    // deadline=600。各 fetch の timeout は残り時間に切り詰められる（1000 ではなく 600→400→200）。
    expect(seenTimeouts).toEqual([600, 400, 200]);
    expect(seenDeadlines.every((d) => d === 600)).toBe(true);
  });

  it("counts fetch execution time (not just backoff) toward the deadline", async () => {
    let t = 0;
    const now = (): number => t;
    const sleep = async (ms: number): Promise<void> => { t += ms; };
    let calls = 0;
    // 各 fetch が timeout ぶん「かかった」ことにして時計を進める（遅延 URL の模擬）。
    const fetcher: Fetcher = async (_url, opts) => {
      calls++;
      t += opts.timeoutMs;
      return { error: "t", errorKind: "timeout" };
    };
    await checkOneWithRetry("https://x", fetcher, {
      timeoutMs: 1000, maxRetries: 5, backoffMs: [200], maxTotalMs: 600, sleep, now,
    });
    // 初回 fetch（timeout=600）で期限を使い切るので再試行しない＝合計が timeout×回数に膨らまない。
    expect(calls).toBe(1);
  });
});

describe("checkSources", () => {
  const today = "2026-06-22";

  it("dedupes by canonical url hash and stamps checkedAt", async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      return { status: url.includes("dead") ? 404 : 200 };
    };
    // 同一 canonical URL（utm 違い）は1回だけ fetch。
    const urls = [
      "https://a.example/p?utm_source=x",
      "https://a.example/p",
      "https://dead.example/x",
    ];
    const results = await checkSources(urls, fetcher, { concurrency: 4, timeoutMs: 1000, today });
    expect(calls.length).toBe(2); // a.example は1回に畳まれる
    expect(results.get(urlHash("https://a.example/p"))).toEqual({ reachable: "ok", checkedAt: today });
    expect(results.get(urlHash("https://dead.example/x"))).toEqual({ reachable: "dead", checkedAt: today });
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const fetcher: Fetcher = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return { status: 200 };
    };
    const urls = Array.from({ length: 10 }, (_, i) => `https://x.example/${i}`);
    await checkSources(urls, fetcher, { concurrency: 3, timeoutMs: 1000, today });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("skips invalid URLs", async () => {
    const fetcher: Fetcher = async () => ({ status: 200 });
    const results = await checkSources(["not a url", "https://ok.example/y"], fetcher, {
      concurrency: 2,
      timeoutMs: 1000,
      today,
    });
    expect(results.size).toBe(1);
    expect(results.get(urlHash("https://ok.example/y"))?.reachable).toBe("ok");
  });
});

describe("applyReachabilityToRaw", () => {
  const today = "2026-06-22";

  it("stamps reachable/checkedAt by canonical url match", () => {
    const sources = [raw("https://a.example/p"), raw("https://b.example/q")];
    const results = new Map([[urlHash("https://a.example/p"), { reachable: "dead" as const, checkedAt: today }]]);
    const out = applyReachabilityToRaw(sources, results);
    expect(out[0].reachable).toBe("dead");
    expect(out[0].checkedAt).toBe(today);
    expect(out[1].reachable).toBeUndefined(); // results に無い URL は触らない
  });

  it("stamps all raw sources that share the same canonical url across different keys", () => {
    const sources = [
      raw("https://a.example/p?utm_source=x", { key: "k1" }),
      raw("https://a.example/p", { key: "k2" }),
    ];
    const results = new Map([[urlHash("https://a.example/p"), { reachable: "ok" as const, checkedAt: today }]]);
    const out = applyReachabilityToRaw(sources, results);
    expect(out.every((s) => s.reachable === "ok" && s.checkedAt === today)).toBe(true);
  });

  it("does not mutate the input array", () => {
    const sources = [raw("https://a.example/p")];
    const results = new Map([[urlHash("https://a.example/p"), { reachable: "ok" as const, checkedAt: today }]]);
    applyReachabilityToRaw(sources, results);
    expect(sources[0].reachable).toBeUndefined();
  });
});

describe("summarize", () => {
  it("counts by reachable", () => {
    const results = new Map<string, { reachable: "ok" | "dead" | "unknown"; checkedAt: string }>([
      ["h1", { reachable: "ok", checkedAt: "d" }],
      ["h2", { reachable: "dead", checkedAt: "d" }],
      ["h3", { reachable: "unknown", checkedAt: "d" }],
      ["h4", { reachable: "ok", checkedAt: "d" }],
    ]);
    expect(summarize(results)).toEqual({ ok: 2, dead: 1, unknown: 1 });
  });
});
