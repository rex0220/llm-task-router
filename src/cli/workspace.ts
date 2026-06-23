import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

// series:* のような「config 非依存のファイル操作」コマンドが、誤って llm-task-router の
// ソース repo 直下や未初期化ディレクトリで実行され、`series/` を誤った場所に作るのを防ぐガード。
// （article:create 等は createRuntime が config/models.yaml と API キーを要求するため自然に止まるが、
//   series:* にはその依存が無く、どこでも黙って成功してしまう＝誤配置の温床。）

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  );
}

// cwd が llm-task-router の「ソース repo」かどうか。
// 注意: config/ / .env.example / CLAUDE.md は init 済み workspace にも repo にも在るため判別に使えない。
// repo だけが持つ src/index.ts・templates/.claude・パッケージ名で判定する（negative マーカー）。
async function isSourceRepo(cwd: string): Promise<boolean> {
  if (await exists(resolve(cwd, "templates/.claude"))) {
    return true;
  }
  if (await exists(resolve(cwd, "src/index.ts"))) {
    return true;
  }
  const pkgPath = resolve(cwd, "package.json");
  if (await exists(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { name?: string };
      if (pkg.name === "@rex0220/llm-task-router") {
        return true;
      }
    } catch {
      // package.json が壊れていても repo 判定は他マーカーに任せる。
    }
  }
  return false;
}

// init 済みの記事ワークスペースらしいか（positive マーカー）。init が必ず撒く config/models.yaml で見る。
async function isInitializedWorkspace(cwd: string): Promise<boolean> {
  return exists(resolve(cwd, "config/models.yaml"));
}

// 記事ワークスペース内での実行であることを保証する。違反時は明確なエラーで止める。
// allowOutsideWorkspace=true（CLI の --allow-outside-workspace）で意図的に無効化できる。
export async function assertArticleWorkspace(
  options: { allowOutsideWorkspace?: boolean; cwd?: string } = {}
): Promise<void> {
  if (options.allowOutsideWorkspace) {
    return;
  }
  const cwd = options.cwd ?? process.cwd();

  if (await isSourceRepo(cwd)) {
    throw new Error(
      "Refusing to run here: this looks like the llm-task-router source repo, not an article workspace. " +
        "cd into your article folder (where you ran `llm-task-router init`), " +
        "or pass --allow-outside-workspace to override."
    );
  }
  if (!(await isInitializedWorkspace(cwd))) {
    throw new Error(
      "Not an initialized article workspace (config/models.yaml not found in the current directory). " +
        "Run `llm-task-router init` here first, cd into your workspace, " +
        "or pass --allow-outside-workspace to override."
    );
  }
}
