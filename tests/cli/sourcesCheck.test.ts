import { describe, expect, it } from "vitest";
import {
  classifyReachable,
  checkSources,
  applyReachabilityToRaw,
  summarize,
  type Fetcher,
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
  it("maps network errors/timeouts to unknown", () => {
    expect(classifyReachable({ error: "ECONNREFUSED" })).toBe("unknown");
    expect(classifyReachable({ error: "aborted" })).toBe("unknown");
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
