import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { RunStore } from "../../src/storage/RunStore";

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
});
