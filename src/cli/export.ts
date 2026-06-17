import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { RunStore } from "../storage/RunStore";
import { assertSafeOutputPath } from "./inputs";

// 指定 run の final.md を、明示された出力先へエクスポートする。
// - final.md のみを対象（他の中間成果物は出さない）。
// - 秘密ファイル名は拒否、既存ファイルは force 無しでは上書きしない。
export async function exportFinalArticle(
  store: RunStore,
  runId: string,
  outPath: string,
  options: { force?: boolean } = {}
): Promise<string> {
  const content = await store.read(runId, "final.md"); // run / final.md が無ければここで失敗
  assertSafeOutputPath(outPath);

  const resolved = resolve(outPath);
  if (!options.force) {
    const exists = await access(resolved).then(
      () => true,
      () => false
    );
    if (exists) {
      throw new Error(`Output already exists: ${resolved} (use --force to overwrite)`);
    }
  }

  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, content, "utf8");
  return resolved;
}
