import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { RunStore } from "../../src/storage/RunStore";
import { SeriesStore } from "../../src/storage/SeriesStore";
import { SERIES_FORMAT_VERSION } from "../../src/storage/seriesMeta";

const root = process.cwd();
const bin = join(root, "dist", "llm-task-router.js");

// E2E 1件あたりのタイムアウト。並列実行下では node 起動＋bundle import で
// Vitest 既定の 5s を超え得るため明示的に伸ばす。
const E2E_TIMEOUT = 30000;

// ビルド済み bin (dist/llm-task-router.js) に対する最小 E2E。
// `npm test` は build を前置きするため dist は最新。直接 `vitest run` した場合に
// dist が無ければここでビルドする（stale dist は npm test ゲートで防ぐ）。
describe("CLI bin (dist/llm-task-router.js)", () => {
  beforeAll(() => {
    if (!existsSync(bin)) {
      execSync("npm run build", { cwd: root, stdio: "ignore" });
    }
  }, 180000);

  function run(args: string[]): string {
    return execFileSync(process.execPath, [bin, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: E2E_TIMEOUT,
    });
  }

  function runFail(args: string[]): { status: number; stderr: string } {
    try {
      execFileSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8", timeout: E2E_TIMEOUT });
      throw new Error("expected a non-zero exit");
    } catch (error) {
      const e = error as { status?: number; stderr?: string };
      return { status: e.status ?? -1, stderr: String(e.stderr ?? "") };
    }
  }

  it(
    "--help lists commands including article:create",
    () => {
      const out = run(["--help"]);
      expect(out).toContain("article:create");
    },
    E2E_TIMEOUT
  );

  it(
    "-v matches package.json version",
    () => {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
      expect(run(["-v"]).trim()).toBe(pkg.version);
    },
    E2E_TIMEOUT
  );

  it(
    "article:create --help succeeds and shows options",
    () => {
      const out = run(["article:create", "--help"]);
      expect(out).toContain("--topic");
      expect(out).toContain("--profile");
      // 編集長モデルは作成時に固定する（progress.md ヘッダに出る）。
      expect(out).toContain("--editor-model");
    },
    E2E_TIMEOUT
  );

  it(
    "article:refine --help succeeds and shows options",
    () => {
      const out = run(["article:refine", "--help"]);
      expect(out).toContain("--max-rounds");
      expect(out).toContain("--until");
    },
    E2E_TIMEOUT
  );

  it(
    "article:refine rejects --max-rounds 0",
    () => {
      const { status, stderr } = runFail(["article:refine", "--run", "x", "--max-rounds", "0"]);
      expect(status).toBe(1);
      expect(stderr).toContain("Invalid --max-rounds");
    },
    E2E_TIMEOUT
  );

  it(
    "article:refine rejects an invalid --until",
    () => {
      const { status, stderr } = runFail(["article:refine", "--run", "x", "--until", "bad"]);
      expect(status).toBe(1);
      expect(stderr).toContain("Invalid --until");
    },
    E2E_TIMEOUT
  );

  it(
    "article:update-diff --help succeeds and shows --run",
    () => {
      const out = run(["article:update-diff", "--help"]);
      expect(out).toContain("--run");
    },
    E2E_TIMEOUT
  );

  it(
    "article:review-editorial --help shows --mode and independence override flags",
    () => {
      const out = run(["article:review-editorial", "--help"]);
      expect(out).toContain("--mode");
      expect(out).toContain("--allow-same-provider");
      expect(out).toContain("--allow-same-model");
    },
    E2E_TIMEOUT
  );

  it(
    "article:editorial-resolve records the decision in the ledger, regenerates candidates, and logs a progress event",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "er-resolve-e2e-"));
      const runId = "2026-06-21-er-resolve-e2e";
      const store = new RunStore(join(cwd, "runs"));
      await store.create(runId, "T", ["create"], "Qiita", undefined, "qiita");
      // 最小の台帳＋最新 alias（head 復元用）を seed。weakness 1件（minor / open）。
      const wid = "W001-deadbeef";
      await store.save(
        runId,
        "editorial-ledger.json",
        JSON.stringify({
          round: 1,
          lastSeq: 1,
          weaknesses: [
            { id: wid, hash: "deadbeef", severity: "minor", problem: "用語揺れ", recommendation: "統一", status: "open", firstRound: 1, lastRound: 1 },
          ],
        })
      );
      await store.save(
        runId,
        "editorial-review.json",
        JSON.stringify({ round: 1, verdict: "needs-revision", scores: [], strengths: [], weaknesses: [], summary: "s" })
      );

      execFileSync(
        process.execPath,
        [bin, "article:editorial-resolve", "--run", runId, "--id", wid, "--resolution", "accepted", "--evidence", "採用して revise 済み"],
        { cwd, encoding: "utf8", timeout: E2E_TIMEOUT }
      );

      const ledger = JSON.parse(readFileSync(join(cwd, "runs", runId, "editorial-ledger.json"), "utf8")) as {
        weaknesses: { id: string; status: string; resolution?: string; resolutionEvidence?: string }[];
      };
      const entry = ledger.weaknesses.find((w) => w.id === wid);
      expect(entry?.status).toBe("open"); // reviewer status は不変
      expect(entry?.resolution).toBe("accepted");
      expect(entry?.resolutionEvidence).toBe("採用して revise 済み");

      // 候補が即時再生成され、採用済み weakness は外れている。
      const candidates = readFileSync(join(cwd, "runs", runId, "editorial-instruction.candidates.md"), "utf8");
      expect(candidates).toContain("適用候補はありません");

      const events = readFileSync(join(cwd, "runs", runId, "progress.events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { step: string; status: string; note?: string });
      const ev = events.find((e) => e.step === "editorial-resolve");
      expect(ev?.status).toBe("done");
      expect(ev?.note).toContain("accepted");
    },
    E2E_TIMEOUT
  );

  it(
    "article:editorial-resolve rejects an invalid --resolution",
    () => {
      const { status, stderr } = runFail([
        "article:editorial-resolve",
        "--run",
        "no-such-run",
        "--id",
        "W001-x",
        "--resolution",
        "bogus",
        "--evidence",
        "x",
      ]);
      expect(status).toBe(1);
      expect(stderr).toContain("Invalid resolution");
    },
    E2E_TIMEOUT
  );

  it(
    "article:sources-check --help shows --dry-run/--only-cited/--json (not --stdout)",
    () => {
      const out = run(["article:sources-check", "--help"]);
      expect(out).toContain("--dry-run");
      expect(out).toContain("--only-cited");
      expect(out).toContain("--json");
      expect(out).not.toContain("--stdout");
    },
    E2E_TIMEOUT
  );

  it(
    "article:sources-check --dry-run classifies an unreachable URL as unknown without writing",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "sc-dry-"));
      const runId = "2026-06-21-sc-dry";
      const store = new RunStore(join(cwd, "runs"));
      await store.create(runId, "T", ["create"], "Qiita", undefined, "qiita");
      // 接続拒否で即 error → unknown（実通信だが localhost:1 で速い）。
      const rawSources = JSON.stringify([
        { key: "x", url: "http://127.0.0.1:1/gone", title: "X", retrievedAt: "2026-06-20", sourceType: "secondary", summary: "" },
      ]);
      await store.save(runId, "sources.raw.json", rawSources);

      const out = execFileSync(
        process.execPath,
        [bin, "article:sources-check", "--run", runId, "--dry-run", "--json", "--timeout", "2000"],
        { cwd, encoding: "utf8", timeout: E2E_TIMEOUT }
      );
      const parsed = JSON.parse(out) as { summary: { ok: number; dead: number; unknown: number }; dryRun: boolean };
      expect(parsed.summary).toEqual({ ok: 0, dead: 0, unknown: 1 });
      expect(parsed.dryRun).toBe(true);
      // dry-run なので raw は不変（reachable/checkedAt は付かない）・progress も記録されない。
      const after = JSON.parse(readFileSync(join(cwd, "runs", runId, "sources.raw.json"), "utf8")) as {
        reachable?: string;
        checkedAt?: string;
      }[];
      expect(after[0].reachable).toBeUndefined();
      expect(after[0].checkedAt).toBeUndefined();
      expect(existsSync(join(cwd, "runs", runId, "progress.events.jsonl"))).toBe(false);
    },
    E2E_TIMEOUT
  );

  it(
    "article:sources-check writes reachable/checkedAt and records a progress event",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "sc-write-"));
      const runId = "2026-06-21-sc-write";
      const store = new RunStore(join(cwd, "runs"));
      await store.create(runId, "T", ["create"], "Qiita", undefined, "qiita");
      await store.save(
        runId,
        "sources.raw.json",
        JSON.stringify([
          { key: "x", url: "http://127.0.0.1:1/gone", title: "X", retrievedAt: "2026-06-20", sourceType: "secondary", summary: "" },
        ])
      );

      execFileSync(
        process.execPath,
        [bin, "article:sources-check", "--run", runId, "--timeout", "2000"],
        { cwd, encoding: "utf8", timeout: E2E_TIMEOUT }
      );

      const updated = JSON.parse(readFileSync(join(cwd, "runs", runId, "sources.raw.json"), "utf8")) as {
        reachable?: string;
        checkedAt?: string;
      }[];
      expect(updated[0].reachable).toBe("unknown");
      expect(updated[0].checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      const events = readFileSync(join(cwd, "runs", runId, "progress.events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { step: string; status: string; note?: string });
      const ev = events.find((e) => e.step === "sources-check");
      expect(ev?.status).toBe("done");
      expect(ev?.note).toMatch(/unknown=1/);
    },
    E2E_TIMEOUT
  );

  it(
    "article:sources-check --only-cited stamps only sources cited by present&verified claims",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "sc-cited-"));
      const runId = "2026-06-21-sc-cited";
      const store = new RunStore(join(cwd, "runs"));
      await store.create(runId, "T", ["create"], "Qiita", undefined, "qiita");
      // S001 は cited（verified/present claim が参照）、S002 は uncited。
      await store.save(
        runId,
        "claims.json",
        JSON.stringify([
          { id: "C001-aaaaaaaa", claim: "x", location: { heading: "## h", anchorHash: "aaaaaaaa" }, type: "general", status: "verified", lifecycle: "present", sourceIds: ["S001"], severity: "minor", note: "" },
        ])
      );
      await store.save(
        runId,
        "sources.json",
        JSON.stringify([
          { id: "S001", url: "http://127.0.0.1:1/cited", title: "C", retrievedAt: "2026-06-20", sourceType: "primary", summary: "", cited: true },
          { id: "S002", url: "http://127.0.0.1:1/uncited", title: "U", retrievedAt: "2026-06-20", sourceType: "secondary", summary: "", cited: false },
        ])
      );
      await store.save(
        runId,
        "sources.raw.json",
        JSON.stringify([
          { key: "c", url: "http://127.0.0.1:1/cited", title: "C", retrievedAt: "2026-06-20", sourceType: "primary", summary: "" },
          { key: "u", url: "http://127.0.0.1:1/uncited", title: "U", retrievedAt: "2026-06-20", sourceType: "secondary", summary: "" },
        ])
      );

      execFileSync(
        process.execPath,
        [bin, "article:sources-check", "--run", runId, "--only-cited", "--timeout", "2000"],
        { cwd, encoding: "utf8", timeout: E2E_TIMEOUT }
      );

      const updated = JSON.parse(readFileSync(join(cwd, "runs", runId, "sources.raw.json"), "utf8")) as {
        key: string;
        reachable?: string;
        checkedAt?: string;
      }[];
      const cited = updated.find((s) => s.key === "c")!;
      const uncited = updated.find((s) => s.key === "u")!;
      expect(cited.reachable).toBe("unknown"); // cited だけ確認・stamp された
      expect(uncited.reachable).toBeUndefined(); // uncited は触らない
      expect(uncited.checkedAt).toBeUndefined();
    },
    E2E_TIMEOUT
  );

  it(
    "article:links-audit --series lists stale/unverified cited links from the ledger (no network)",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "la-"));
      const runId = "2026-06-21-la-a";
      const store = new RunStore(join(cwd, "runs"));
      await store.create(runId, "T", ["create"], "Qiita", undefined, "qiita", {
        seriesId: "demo",
        voiceVersion: 1,
        voiceHash: "x",
      });
      await store.save(
        runId,
        "claims.json",
        JSON.stringify([
          { id: "C001-aaaaaaaa", claim: "x", location: { heading: "## h", anchorHash: "aaaaaaaa" }, type: "general", status: "verified", lifecycle: "present", sourceIds: ["S001"], severity: "minor", note: "" },
        ])
      );
      // checkedAt 無し＝未検証として要対応に出る。
      await store.save(
        runId,
        "sources.json",
        JSON.stringify([
          { id: "S001", url: "https://example.com/s1", title: "S1", retrievedAt: "2026-06-20", sourceType: "primary", summary: "", cited: true, reachable: "ok" },
        ])
      );

      const out = execFileSync(
        process.execPath,
        [bin, "article:links-audit", "--series", "demo", "--json"],
        { cwd, encoding: "utf8", timeout: E2E_TIMEOUT }
      );
      const parsed = JSON.parse(out) as { audits: { runId: string; result: { fails: { category: string }[] } }[] };
      const a = parsed.audits.find((x) => x.runId === runId)!;
      expect(a.result.fails.map((f) => f.category)).toContain("unverified");
    },
    E2E_TIMEOUT
  );

  it(
    "article:links-audit requires exactly one of --series / --all-published",
    () => {
      const neither = runFail(["article:links-audit"]);
      expect(neither.status).toBe(1);
      expect(neither.stderr).toContain("--series");
    },
    E2E_TIMEOUT
  );

  it(
    "article:references --help shows --run and --stdout",
    () => {
      const out = run(["article:references", "--help"]);
      expect(out).toContain("--run");
      expect(out).toContain("--stdout");
    },
    E2E_TIMEOUT
  );

  it(
    "article:references fails on a non-existent run",
    () => {
      const { status, stderr } = runFail(["article:references", "--run", "no-such-run"]);
      expect(status).toBe(1);
      expect(stderr).toMatch(/no-such-run/);
    },
    E2E_TIMEOUT
  );

  it(
    "article:export --note records the approval note in the export progress event",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "export-note-e2e-"));
      const runId = "2026-06-21-export-note";
      const store = new RunStore(join(cwd, "runs"));
      await store.create(runId, "T", ["create"], "Qiita", undefined, "qiita");
      await store.save(runId, "final.md", "# タイトル\n本文\n");

      execFileSync(
        process.execPath,
        [bin, "article:export", "--run", runId, "--out", join(cwd, "out.md"), "--note", "ユーザー承認済み（条件: Qiita媒体適性OK）"],
        { cwd, encoding: "utf8", timeout: E2E_TIMEOUT }
      );

      const events = readFileSync(join(cwd, "runs", runId, "progress.events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { step: string; status: string; note?: string });
      const ex = events.find((e) => e.step === "export");
      expect(ex?.status).toBe("done");
      expect(ex?.note).toBe("ユーザー承認済み（条件: Qiita媒体適性OK）");
    },
    E2E_TIMEOUT
  );

  it(
    "article:export blocks broken strong emphasis; --allow-broken-markdown needs --note; --force does not bypass it",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "export-emphasis-e2e-"));
      const runId = "2026-06-22-export-emphasis";
      const store = new RunStore(join(cwd, "runs"));
      await store.create(runId, "T", ["create"], "Qiita", undefined, "qiita");
      await store.save(runId, "final.md", "# タイトル\n小惑星は、**「太陽系の化石」**のような存在です。\n");
      const out = join(cwd, "out.md");

      // cwd=temp で実行し、非ゼロ終了（execFileSync が throw）を厳密に検証するヘルパー。
      // 成功時は failed=false のまま assert で落ちる（sentinel を catch に混ぜない）。
      const expectExportFail = (args: string[]): void => {
        let failed = false;
        let status: number | undefined;
        try {
          execFileSync(process.execPath, [bin, "article:export", "--run", runId, "--out", out, ...args], {
            cwd,
            encoding: "utf8",
            timeout: E2E_TIMEOUT,
          });
        } catch (error) {
          failed = true;
          status = (error as { status?: number }).status;
        }
        expect(failed).toBe(true);
        expect(status).toBeTypeOf("number");
        expect(status).not.toBe(0);
      };

      // 既定: 崩れていると失敗（書き出さない）。
      expectExportFail([]);
      expect(existsSync(out)).toBe(false);

      // --force（上書き）だけでは lint を回避できない。
      expectExportFail(["--force"]);
      expect(existsSync(out)).toBe(false);

      // --allow-broken-markdown 単独（--note なし）は CLI 層で検証エラー。
      expectExportFail(["--allow-broken-markdown"]);
      expect(existsSync(out)).toBe(false);

      // --allow-broken-markdown + --note なら書き出せ、note が progress event に載る。
      execFileSync(
        process.execPath,
        [bin, "article:export", "--run", runId, "--out", out, "--allow-broken-markdown", "--note", "既知の崩れを明示承認"],
        { cwd, encoding: "utf8", timeout: E2E_TIMEOUT }
      );
      expect(existsSync(out)).toBe(true);
      const exportEvents = readFileSync(join(cwd, "runs", runId, "progress.events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { step: string; status: string; note?: string });
      const exportEvent = exportEvents.find((e) => e.step === "export");
      expect(exportEvent?.status).toBe("done");
      expect(exportEvent?.note).toBe("既知の崩れを明示承認");
    },
    E2E_TIMEOUT
  );

  it(
    "article:export link gate blocks unverified cited links; --allow-unverified-links needs --note",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "export-linkgate-e2e-"));
      const runId = "2026-06-25-export-linkgate";
      const store = new RunStore(join(cwd, "runs"));
      await store.create(runId, "T", ["create"], "Qiita", undefined, "qiita");
      await store.save(runId, "final.md", "# タイトル\n本文。\n");
      // cited な S001 が checkedAt 無し＝未検証 → ゲートで FAIL。
      await store.save(
        runId,
        "claims.json",
        JSON.stringify([
          { id: "C001-aaaaaaaa", claim: "x", location: { heading: "## h", anchorHash: "aaaaaaaa" }, type: "general", status: "verified", lifecycle: "present", sourceIds: ["S001"], severity: "minor", note: "" },
        ])
      );
      await store.save(
        runId,
        "sources.json",
        JSON.stringify([
          { id: "S001", url: "https://example.com/s1", title: "S1", retrievedAt: "2026-06-20", sourceType: "primary", summary: "", cited: true, reachable: "ok" },
        ])
      );
      const out = join(cwd, "out.md");

      // temp cwd で実行し非ゼロ終了を厳密に検証する（runFail は cwd=root 固定で temp run を見ないため使わない）。
      const expectExportFail = (args: string[]): void => {
        let failed = false;
        let status: number | undefined;
        try {
          execFileSync(process.execPath, [bin, "article:export", "--run", runId, "--out", out, ...args], {
            cwd,
            encoding: "utf8",
            timeout: E2E_TIMEOUT,
          });
        } catch (error) {
          failed = true;
          status = (error as { status?: number }).status;
        }
        expect(failed).toBe(true);
        expect(status).not.toBe(0);
      };

      // 既定: 未検証 cited で失敗（書き出さない）。
      expectExportFail([]);
      expect(existsSync(out)).toBe(false);

      // --allow-unverified-links 単独（--note なし）は CLI 層で検証エラー。
      expectExportFail(["--allow-unverified-links"]);
      expect(existsSync(out)).toBe(false);

      // --allow-unverified-links + --note なら書き出せ、note が export イベントに載る。
      execFileSync(
        process.execPath,
        [bin, "article:export", "--run", runId, "--out", out, "--allow-unverified-links", "--note", "offline 承認"],
        { cwd, encoding: "utf8", timeout: E2E_TIMEOUT }
      );
      expect(existsSync(out)).toBe(true);
      const stamp = JSON.parse(readFileSync(join(cwd, "runs", runId, "link-gate-stamp.json"), "utf8")) as {
        result: string;
        allowedUnverified?: boolean;
        reason?: string;
      };
      expect(stamp.result).toBe("fail");
      expect(stamp.allowedUnverified).toBe(true);
      expect(stamp.reason).toBe("offline 承認");
    },
    E2E_TIMEOUT
  );

  it(
    "article:record-publication --help shows --article-version (not the reserved --version)",
    () => {
      const out = run(["article:record-publication", "--help"]);
      expect(out).toContain("--slug");
      expect(out).toContain("--article-id");
      // 公開版番号は --article-version（CLI 全体の -v/--version との衝突回避）。
      expect(out).toContain("--article-version");
    },
    E2E_TIMEOUT
  );

  it(
    "article:completion-report records a progress event into progress.events.jsonl",
    async () => {
      // temp cwd に runs/ を seed して bin を cwd=temp で実行（実 runs/ を汚さず実アクションを通す）。
      const cwd = await mkdtemp(join(tmpdir(), "cr-e2e-"));
      const runId = "2026-06-21-cr-e2e";
      const store = new RunStore(join(cwd, "runs"));
      await store.create(runId, "T", ["create"], "Qiita", undefined, "qiita");
      await store.save(runId, "final.md", "# タイトル\n本文\n");
      await store.save(
        runId,
        "publication-check.md",
        ["# Publication Check", "- GO/NO-GO: GO", "- reason: 全ゲート通過", ""].join("\n")
      );

      execFileSync(process.execPath, [bin, "article:completion-report", "--run", runId], {
        cwd,
        encoding: "utf8",
        timeout: E2E_TIMEOUT,
      });

      const events = readFileSync(join(cwd, "runs", runId, "progress.events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { step: string; status: string; note?: string });
      const cr = events.find((e) => e.step === "completion-report");
      expect(cr).toBeDefined();
      expect(cr?.status).toBe("done");
      expect(cr?.note).toBe("GO/NO-GO: GO");
    },
    E2E_TIMEOUT
  );

  it(
    "article:factcheck-scope records the scope verdict as a progress event",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "fcs-e2e-"));
      const runId = "2026-06-21-fcs-e2e";
      const store = new RunStore(join(cwd, "runs"));
      await store.create(runId, "T", ["create"], "Qiita", undefined, "qiita");
      await store.save(runId, "final.md", "# タイトル\n本文\n");
      // baseline スナップショット無し → scope=full（初回判定）が決定的に出る。

      execFileSync(process.execPath, [bin, "article:factcheck-scope", "--run", runId], {
        cwd,
        encoding: "utf8",
        timeout: E2E_TIMEOUT,
      });

      const events = readFileSync(join(cwd, "runs", runId, "progress.events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { step: string; status: string; note?: string });
      const fcs = events.find((e) => e.step === "factcheck-scope");
      expect(fcs).toBeDefined();
      expect(fcs?.status).toBe("done");
      expect(fcs?.note).toContain("scope=full");
    },
    E2E_TIMEOUT
  );

  it(
    "article:factcheck-stamp records the baseline acceptance as a progress event",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "fcstamp-e2e-"));
      const runId = "2026-06-21-fcstamp-e2e";
      const store = new RunStore(join(cwd, "runs"));
      await store.create(runId, "T", ["create"], "Qiita", undefined, "qiita");
      await store.save(runId, "final.md", "# タイトル\n本文\n");

      execFileSync(
        process.execPath,
        [bin, "article:factcheck-stamp", "--run", runId, "--accepted-after", "non-factual-diff", "--note", "参考章注入のみ・非事実差分として受理"],
        { cwd, encoding: "utf8", timeout: E2E_TIMEOUT }
      );

      const events = readFileSync(join(cwd, "runs", runId, "progress.events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { step: string; status: string; note?: string });
      const stamp = events.find((e) => e.step === "factcheck-stamp");
      expect(stamp?.status).toBe("done");
      expect(stamp?.note).toBe("accepted-after=non-factual-diff");
      // 正本の meta も書かれている。
      expect(existsSync(join(cwd, "runs", runId, "factcheck.snapshot.meta.json"))).toBe(true);
    },
    E2E_TIMEOUT
  );

  it(
    "article:factcheck-scope --stdout does not record a progress event (dry run)",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "fcs-dry-"));
      const runId = "2026-06-21-fcs-dry";
      const store = new RunStore(join(cwd, "runs"));
      await store.create(runId, "T", ["create"], "Qiita", undefined, "qiita");
      await store.save(runId, "final.md", "# タイトル\n本文\n");

      execFileSync(process.execPath, [bin, "article:factcheck-scope", "--run", runId, "--stdout"], {
        cwd,
        encoding: "utf8",
        timeout: E2E_TIMEOUT,
      });

      // dry run なので events ファイル自体が作られない（progress 記録なし）。
      expect(existsSync(join(cwd, "runs", runId, "progress.events.jsonl"))).toBe(false);
    },
    E2E_TIMEOUT
  );

  it(
    "article:progress:event --editor-model surfaces the editor AI model in progress.md",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "editor-e2e-"));
      const runId = "2026-06-21-editor-e2e";
      const store = new RunStore(join(cwd, "runs"));
      await store.create(runId, "T", ["create"], "Qiita", undefined, "qiita");

      execFileSync(
        process.execPath,
        [bin, "article:progress:event", "--run", runId, "--step", "factcheck", "--status", "done", "--editor-model", "claude-opus-4-8"],
        { cwd, encoding: "utf8", timeout: E2E_TIMEOUT }
      );

      const md = readFileSync(join(cwd, "runs", runId, "progress.md"), "utf8");
      expect(md).toContain("- 編集長（AIモデル・自己申告）: claude-opus-4-8");
      const events = readFileSync(join(cwd, "runs", runId, "progress.events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { step: string; editorModel?: string });
      expect(events.find((e) => e.step === "factcheck")?.editorModel).toBe("claude-opus-4-8");
    },
    E2E_TIMEOUT
  );

  it(
    "article:record-publication --article-version is parsed as the flag, not the CLI version",
    () => {
      // --article-version を渡しても CLI の version（package.json の値）が出力されないこと。
      // run 不在で失敗する経路だが、stdout に version 文字列が混ざらないことを固定する。
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
      const { stderr } = runFail([
        "article:record-publication",
        "--run",
        "no-such-run",
        "--slug",
        "x",
        "--url",
        "https://example.com/items/abc",
        "--article-id",
        "abc",
        "--article-version",
        "2",
      ]);
      // version 表示で早期 exit していたら stderr は空でこの assertion が壊れる。
      expect(stderr).not.toBe(pkg.version);
      expect(stderr.length).toBeGreaterThan(0);
    },
    E2E_TIMEOUT
  );

  async function setupGlossaryWorkspace(withGlossary: boolean): Promise<string> {
    const cwd = await mkdtemp(join(tmpdir(), "glossary-e2e-"));
    const seriesStore = new SeriesStore(join(cwd, "series"));
    const runStore = new RunStore(join(cwd, "runs"));
    await seriesStore.write("jomon-2026", {
      version: SERIES_FORMAT_VERSION,
      seriesId: "jomon-2026",
      profile: "qiita",
      voice: { frozen: false, version: 0, frozenAt: "", hash: "", history: [], provenance: [] },
      members: [
        { order: 1, slug: "jomon-1", runId: "2026-06-23-jomon-1", status: "done" },
        { order: 2, slug: "jomon-2", runId: "2026-06-23-jomon-2", status: "done" },
        { order: 3, slug: "jomon-3", runId: null, status: "planned" },
      ],
    });
    await runStore.save("2026-06-23-jomon-1", "final.md", "三内丸山遺跡は青森市にある。\n\n竪穴建物が並ぶ。");
    await runStore.save("2026-06-23-jomon-2", "final.md", "三内丸山遺跡は青森県にある。\n\n竪穴住居が見つかった。");
    if (withGlossary) {
      const yaml = [
        "schemaVersion: 1",
        "seriesId: jomon-2026",
        "terms:",
        "  - preferred: 竪穴建物",
        "    variants: [竪穴住居]",
        "nouns:",
        "  - canonical: 三内丸山遺跡",
        "    attributes:",
        "      location:",
        "        preferred: 青森市",
        "        variants: [青森県]",
        "        contextPatterns: [三内丸山遺跡, 所在地]",
        "",
      ].join("\n");
      await writeFile(join(seriesStore.seriesPath("jomon-2026"), "glossary.yaml"), yaml, "utf8");
    }
    return cwd;
  }

  it(
    "series:check --json reports findings, skips, and writes a report",
    async () => {
      const cwd = await setupGlossaryWorkspace(true);
      const out = execFileSync(
        process.execPath,
        [bin, "series:check", "--slug", "jomon-2026", "--json", "--allow-outside-workspace"],
        { cwd, encoding: "utf8", timeout: E2E_TIMEOUT }
      );
      const report = JSON.parse(out) as {
        missingGlossary: boolean;
        totalFindings: number;
        members: { order: number; findings: unknown[]; skipped?: string }[];
      };
      expect(report.missingGlossary).toBe(false);
      expect(report.totalFindings).toBe(2);
      const byOrder = Object.fromEntries(report.members.map((m) => [m.order, m]));
      expect(byOrder[1].findings).toHaveLength(0);
      expect(byOrder[2].findings).toHaveLength(2);
      expect(byOrder[3].skipped).toBe("planned");
      // レポートが series/<slug>/ に書かれる。
      expect(existsSync(join(cwd, "series", "jomon-2026", "series-check-report.json"))).toBe(true);
    },
    E2E_TIMEOUT
  );

  it(
    "series:check --strict exits non-zero when glossary is missing",
    async () => {
      const cwd = await setupGlossaryWorkspace(false);
      try {
        execFileSync(
          process.execPath,
          [bin, "series:check", "--slug", "jomon-2026", "--strict", "--allow-outside-workspace"],
          { cwd, encoding: "utf8", timeout: E2E_TIMEOUT }
        );
        throw new Error("expected a non-zero exit");
      } catch (error) {
        const e = error as { status?: number; stderr?: string; stdout?: string };
        expect(e.status).toBe(1);
        expect(String(e.stdout ?? "")).toContain("glossary not configured");
      }
    },
    E2E_TIMEOUT
  );
});
