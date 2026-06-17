import { access, copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  );
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

// 同梱の config/ ツリーと .env.example を、作業ディレクトリへ展開する。
// - 書き込み先は cwd 配下の固定パス（任意パスは受け取らない）。
// - 既存ファイルは force 無しでは上書きしない（カスタム設定の保護）。
// - .env は生成しない（.env.example のみ。秘密ファイルを置かない）。
export async function initConfig(
  targetDir: string,
  sourceDir: string,
  options: { force?: boolean } = {}
): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];

  const sources = await listFiles(join(sourceDir, "config"));
  const envExample = join(sourceDir, ".env.example");
  if (await exists(envExample)) {
    sources.push(envExample);
  }

  for (const src of sources) {
    const rel = relative(sourceDir, src);
    const dest = join(targetDir, rel);

    if (!options.force && (await exists(dest))) {
      skipped.push(rel);
      continue;
    }

    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    created.push(rel);
  }

  return { created, skipped };
}
