import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// テストごとに隔離された一時ディレクトリを使い、共有 `runs/` への並列書き込み競合を避ける。
export function tmpRunRoot(): string {
  return mkdtempSync(join(tmpdir(), "ltr-runs-"));
}

export function tmpLogPath(): string {
  return join(mkdtempSync(join(tmpdir(), "ltr-log-")), "router.log");
}
