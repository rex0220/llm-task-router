import { readFile, stat } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";

// CLIのファイル入力をLLMへ送る前の安全ガード。
// - `.env` / `.env.*` のような秘密情報ファイルは明示的に拒否する。
// - ワークスペース外のパスは警告する（読み込みは許可）。
export function assertSafeInputPath(filePath: string, cwd: string = process.cwd()): void {
  const name = basename(filePath).toLowerCase();
  if (name === ".env" || name.startsWith(".env.")) {
    throw new Error(`Refusing to read a secret file: ${filePath}`);
  }

  const resolved = resolve(cwd, filePath);
  const root = resolve(cwd);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    process.stderr.write(`Warning: reading a file outside the workspace: ${resolved}\n`);
  }
}

// 明示エクスポート先のガード。秘密ファイルへの書き込みは拒否、ワークスペース外は警告（拒否しない）。
export function assertSafeOutputPath(filePath: string, cwd: string = process.cwd()): void {
  const name = basename(filePath).toLowerCase();
  if (name === ".env" || name.startsWith(".env.")) {
    throw new Error(`Refusing to write to a secret file: ${filePath}`);
  }

  const resolved = resolve(cwd, filePath);
  const root = resolve(cwd);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    process.stderr.write(`Warning: writing a file outside the workspace: ${resolved}\n`);
  }
}

// インライン文字列とファイルパスから1つの指示テキストを解決する。
// - 両方指定はエラー（どちらが使われたか曖昧になるのを防ぐ）。
// - ファイル指定時は安全ガードを通し、空ならエラー。
export async function resolveText(
  inline: string | undefined,
  filePath: string | undefined,
  label: string,
  inlineFlag: string,
  fileFlag: string
): Promise<string> {
  if (inline !== undefined && filePath !== undefined) {
    throw new Error(`Specify only one of ${inlineFlag} or ${fileFlag}, not both`);
  }

  if (filePath !== undefined) {
    assertSafeInputPath(filePath);
    const content = (await readFile(filePath, "utf8")).trim();
    if (!content) {
      throw new Error(`${label} file is empty: ${filePath}`);
    }
    return content;
  }

  const text = inline?.trim();
  if (text) {
    if (await isExistingInputPath(text)) {
      throw new Error(`${inlineFlag} looks like a file path: ${text}. Use ${fileFlag} <path> instead.`);
    }
    return text;
  }

  throw new Error(`Provide ${label} with ${inlineFlag} "..." or ${fileFlag} <path>`);
}

async function isExistingInputPath(value: string): Promise<boolean> {
  if (value.includes("\n") || value.includes("\r")) {
    return false;
  }
  try {
    const s = await stat(value);
    return s.isFile();
  } catch {
    return false;
  }
}
