import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

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
    },
    E2E_TIMEOUT
  );
});
