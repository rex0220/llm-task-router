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

// 同梱の config/ ツリー・.env.example・templates/ 配下を、作業ディレクトリへ展開する。
// - 書き込み先は cwd 配下の固定パス（任意パスは受け取らない）。
// - 既存ファイルは force 無しでは上書きしない（カスタム設定の保護）。
// - .env は生成しない（.env.example のみ。秘密ファイルを置かない）。
// - templates/ 配下（.claude/ や CLAUDE.md 等の編集長セット）は接頭辞を剥がして
//   ターゲット直下へ置く（templates/CLAUDE.md → CLAUDE.md）。
export async function initConfig(
  targetDir: string,
  sourceDir: string,
  options: { force?: boolean } = {}
): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];

  // { src: 絶対パス, destRel: ターゲット直下からの相対パス } の組を集める。
  const items: { src: string; destRel: string }[] = [];

  for (const src of await listFiles(join(sourceDir, "config"))) {
    items.push({ src, destRel: relative(sourceDir, src) });
  }

  const envExample = join(sourceDir, ".env.example");
  if (await exists(envExample)) {
    items.push({ src: envExample, destRel: ".env.example" });
  }

  // templates/ ツリーは接頭辞を剥がしてターゲット直下に展開する。
  const templatesDir = join(sourceDir, "templates");
  if (await exists(templatesDir)) {
    for (const src of await listFiles(templatesDir)) {
      items.push({ src, destRel: relative(templatesDir, src) });
    }
  }

  for (const { src, destRel } of items) {
    const dest = join(targetDir, destRel);

    if (!options.force && (await exists(dest))) {
      skipped.push(destRel);
      continue;
    }

    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    created.push(destRel);
  }

  return { created, skipped };
}
