import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { validateSlug } from "./meta";

// 公開記事 slug → 最新 run / 公開 URL の逆引き台帳（§5.5）。
// /update-article が slug を解決し、record-publication がここを更新する。
export type ExportIndexEntry = {
  runId: string;
  url: string;
  articleId: string;
  version: number;
  updatedAt: string;
};

export type ExportIndexData = {
  version: number; // 台帳フォーマットの版（現状 1）
  articles: Record<string, ExportIndexEntry>;
};

const INDEX_FORMAT_VERSION = 1;
const DEFAULT_PATH = "export/index.json";

// 台帳の中身（runId/url/articleId/version）が一致するか。updatedAt は冪等性のため比較に含めない。
export function entryContentEqual(
  a: ExportIndexEntry | undefined,
  b: ExportIndexEntry | undefined
): boolean {
  if (!a || !b) {
    return false;
  }
  return a.runId === b.runId && a.url === b.url && a.articleId === b.articleId && a.version === b.version;
}

// version 退行ガード（§5.5）。完全一致は冪等な再実行として許可、version 上昇は通常更新、
// それ以外（退行・同 version で内容差）は --force 無しでは拒否する。
export function assertNoVersionRegression(
  existing: ExportIndexEntry | undefined,
  candidate: ExportIndexEntry,
  force: boolean
): void {
  if (!existing) {
    return; // 新規 slug
  }
  if (entryContentEqual(existing, candidate)) {
    return; // 完全一致 → no-op として許可
  }
  if (candidate.version > existing.version) {
    return; // version 上昇 → 通常更新
  }
  if (force) {
    return; // 意図的な訂正
  }
  throw new Error(
    `Refusing to record version ${candidate.version} over existing version ${existing.version} for the same slug ` +
      `(use --force to override a non-increasing version)`
  );
}

export class ExportIndex {
  private readonly path: string;

  constructor(path: string = DEFAULT_PATH) {
    this.path = resolve(path);
  }

  // 台帳を読む。ファイル不在（ENOENT）のみ空として扱い、権限/I/O エラーは握り潰さず投げる。
  // articles は prototype 汚染を避けるため null プロトタイプ。
  async read(): Promise<ExportIndexData> {
    const raw = await readFile(this.path, "utf8").then(
      (content) => content,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return null;
        }
        throw error;
      }
    );
    if (raw === null) {
      return { version: INDEX_FORMAT_VERSION, articles: Object.create(null) as Record<string, ExportIndexEntry> };
    }
    // 破損（不正JSON・非オブジェクト）は黙って空扱いにしない（他 slug を失わせない）。
    // 明確なエラーで知らせ、空台帳で上書きする事故を防ぐ。
    let parsed: ExportIndexData;
    try {
      parsed = JSON.parse(raw) as ExportIndexData;
    } catch {
      throw new Error(`Corrupt export index (invalid JSON): ${this.path} — fix or remove the file.`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Corrupt export index (expected a JSON object): ${this.path} — fix or remove the file.`);
    }
    // 継承キーの混入を防ぐため、読み込んだ articles を null プロトタイプへ移し替える。
    const articles = Object.assign(Object.create(null) as Record<string, ExportIndexEntry>, parsed.articles ?? {});
    return { version: parsed.version ?? INDEX_FORMAT_VERSION, articles };
  }

  async resolve(slug: string): Promise<ExportIndexEntry | undefined> {
    validateSlug(slug);
    const data = await this.read();
    return Object.prototype.hasOwnProperty.call(data.articles, slug) ? data.articles[slug] : undefined;
  }

  // slug のエントリを upsert する。検証・退行ガードは呼び出し側（record-publication）の責務。
  async write(slug: string, entry: ExportIndexEntry): Promise<void> {
    validateSlug(slug);
    const data = await this.read();
    data.articles[slug] = entry;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  async exists(): Promise<boolean> {
    return access(this.path).then(
      () => true,
      () => false
    );
  }
}
