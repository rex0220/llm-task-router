import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { RunMeta, RunStore } from "../storage/RunStore";
import { assertSafeOutputPath } from "./inputs";

// 指定 run の final.md を、明示された出力先へエクスポートする。
// - final.md のみを対象（他の中間成果物は出さない）。
// - 秘密ファイル名は拒否、既存ファイルは force 無しでは上書きしない。
// - frontMatter: true なら投稿用に front-matter（title/tags 等）を付与し、本文先頭の H1 は
//   front-matter のタイトルへ一本化する（重複回避）。既定 false（clean な本文のまま）。
export async function exportFinalArticle(
  store: RunStore,
  runId: string,
  outPath: string,
  options: { force?: boolean; frontMatter?: boolean } = {}
): Promise<string> {
  let content = await store.read(runId, "final.md"); // run / final.md が無ければここで失敗
  assertSafeOutputPath(outPath);

  if (options.frontMatter) {
    const meta = await store.readMeta(runId);
    content = withFrontMatter(content, meta);
  }

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

// 本文先頭の H1（タイトル）を取り出す。先頭の空行は許容する。
// 「最初の非空行が H1 のとき」だけタイトルとみなす（stripLeadingH1 と同じ判定）。
// 本文全体を走査する fallback は持たない（コードフェンス内の "# コメント" を
// 誤ってタイトルに採るのを防ぎ、除去対象行と一致させるため）。
export function firstH1(body: string): string | undefined {
  const firstNonEmpty = body.split(/\r?\n/).find((line) => line.trim() !== "");
  if (firstNonEmpty && /^#\s+/.test(firstNonEmpty.trim())) {
    return firstNonEmpty.trim().replace(/^#\s+/, "").trim();
  }
  return undefined;
}

// 本文先頭の H1 行（と直後の空行）を1つだけ取り除く。
function stripLeadingH1(body: string): string {
  const lines = body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") {
    i++;
  }
  if (i < lines.length && /^#\s+/.test(lines[i].trim())) {
    lines.splice(0, i + 1);
    while (lines.length > 0 && lines[0].trim() === "") {
      lines.shift();
    }
    return lines.join("\n");
  }
  return body;
}

function yamlString(value: string): string {
  // 二重引用符スカラとして安全化。改行は front-matter を壊すのでスペースに畳む。
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;
}

// タイトルの正本は本文先頭 H1（revise が編集するのは本文）。meta.articleTitle は
// create 時（brief 由来）に固定され revise で更新されないため、H1 を優先し meta は
// fallback に回す。両方あって食い違うときは「黙って古い meta を採る」事故を防ぐため warn。
function resolveTitle(body: string, meta: RunMeta): string {
  const h1 = firstH1(body);
  const metaTitle = meta.articleTitle?.trim();
  if (h1 && metaTitle && h1 !== metaTitle) {
    process.stderr.write(
      `Warning: 本文 H1 と meta.articleTitle が異なります。H1 を採用します（meta: "${metaTitle}", H1: "${h1}"）。\n`
    );
  }
  return h1 || metaTitle || meta.runId;
}

function buildQiitaFrontMatter(title: string, tags: string[]): string {
  const tagLines = tags.length > 0 ? tags.map((t) => `  - ${yamlString(t)}`).join("\n") : "  []";
  // qiita-cli 互換の front-matter。id/updated_at は qiita-cli が初回同期で埋める。
  return [
    "---",
    `title: ${yamlString(title)}`,
    tags.length > 0 ? "tags:" : "tags: []",
    ...(tags.length > 0 ? [tagLines] : []),
    "private: false",
    'updated_at: ""',
    "id: null",
    "organization_url_name: null",
    "slide: false",
    "ignorePublish: false",
    "---",
  ].join("\n");
}

function buildZennFrontMatter(title: string, tags: string[]): string {
  const topics = `[${tags.map((t) => yamlString(t)).join(", ")}]`;
  return [
    "---",
    `title: ${yamlString(title)}`,
    'emoji: "📝"',
    'type: "tech"',
    `topics: ${topics}`,
    "published: false",
    "---",
  ].join("\n");
}

// platform に応じた投稿用 front-matter を本文に前置する。
// Qiita/Zenn のみ対応。それ以外は警告して clean な本文を返す。
function withFrontMatter(body: string, meta: RunMeta): string {
  const platform = (meta.platform ?? "").toLowerCase();
  const title = resolveTitle(body, meta);
  const tags = meta.tags ?? [];

  let frontMatter: string;
  if (platform === "qiita") {
    if (tags.length === 0) {
      process.stderr.write("Warning: Qiita はタグが1つ以上必要です。meta に tags が無いため空のまま出力します。\n");
    }
    frontMatter = buildQiitaFrontMatter(title, tags);
  } else if (platform === "zenn") {
    frontMatter = buildZennFrontMatter(title, tags);
  } else {
    process.stderr.write(
      `Warning: front-matter 生成は Qiita/Zenn のみ対応です（platform: ${meta.platform ?? "?"}）。clean な本文を出力します。\n`
    );
    return body;
  }

  const bodyWithoutTitle = stripLeadingH1(body);
  return `${frontMatter}\n\n${bodyWithoutTitle.replace(/^\n+/, "")}`;
}
