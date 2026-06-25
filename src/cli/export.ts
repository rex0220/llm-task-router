import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { RunMeta, RunStore } from "../storage/RunStore";
import { assertSafeOutputPath } from "./inputs";
import { detectBrokenStrongEmphasis, STRONG_EMPHASIS_RULE_VERSION, strongEmphasisWarnings } from "../utils/text";
import { sha256 } from "../utils/hash";
import { ClaimsSchema, SourcesSchema } from "../schemas/ClaimsSchema";
import { CLAIMS_FILE, SOURCES_FILE } from "./claimsNormalize";
import { DEFAULT_FRESHNESS_DAYS, linkGate, type LinkGateResult } from "./linkGate";

export const MARKDOWN_LINT_STAMP_FILE = "markdown-lint-stamp.json";
export const LINK_GATE_STAMP_FILE = "link-gate-stamp.json";

// 公開前到達性ゲート（提案B）が「旧 run の未検証を warning に降格」する作成日カットオフ。
// これより前に作られた run は、ゲート導入前なので checkedAt 欠落を FAIL でなく warning にする
// （§6 #8。これ以降に作る run は sources-check を回す前提なので未検証は FAIL）。
export const LINK_GATE_SINCE = "2026-06-25";

// claims.json / sources.json を読んで公開前ゲートを評価し、結果をスタンプに残す（通信しない）。
// claims/sources がまだ無い run（normalize 未実行）はゲート対象外として skipped を返す（後方互換）。
export async function evaluateLinkGate(
  store: RunStore,
  runId: string,
  today: string,
  legacyGrace: boolean,
  // override（--allow-unverified-links）の事実と理由をスタンプにも残し、台帳を自己完結させる（監査）。
  override: { allowed: boolean; reason?: string } = { allowed: false }
): Promise<LinkGateResult | { skipped: true; reason: string }> {
  const claimsRaw = await store.read(runId, CLAIMS_FILE).catch(() => null);
  const sourcesRaw = await store.read(runId, SOURCES_FILE).catch(() => null);
  if (claimsRaw === null || sourcesRaw === null) {
    return { skipped: true, reason: `${CLAIMS_FILE}/${SOURCES_FILE} が無い（claims-normalize 未実行）` };
  }
  const claims = ClaimsSchema.parse(JSON.parse(claimsRaw));
  const sources = SourcesSchema.parse(JSON.parse(sourcesRaw));
  const result = linkGate(claims, sources, { today, mode: "export", legacyGrace });
  // override が実際に効いた（FAIL を握りつぶした）ときだけ bypass を記録する。
  const bypassed = override.allowed && !result.pass;
  await store.save(
    runId,
    LINK_GATE_STAMP_FILE,
    JSON.stringify(
      {
        verifiedAt: today,
        freshnessDays: DEFAULT_FRESHNESS_DAYS,
        legacyGrace,
        result: result.pass ? "pass" : "fail",
        checkedCited: result.checkedCited,
        fails: result.fails,
        warnings: result.warnings,
        ...(bypassed ? { allowedUnverified: true, reason: override.reason ?? "" } : {}),
      },
      null,
      2
    )
  );
  return result;
}

// 指定 run の final.md を、明示された出力先へエクスポートする。
// - final.md のみを対象（他の中間成果物は出さない）。
// - 秘密ファイル名は拒否、既存ファイルは force 無しでは上書きしない（force は「出力先の上書き」専用）。
// - frontMatter: true なら投稿用に front-matter（title/tags 等）を付与し、本文先頭の H1 は
//   front-matter のタイトルへ一本化する（重複回避）。既定 false（clean な本文のまま）。
// - 公開前ゲート（Phase 3）: front-matter 生成前の raw final.md を強調 lint し、開閉できない `**`
//   があれば書き出さず throw する（約物が front-matter/タイトルに影響しないよう raw を対象にする）。
//   allowBrokenMarkdown で明示オーバーライド可（理由は allowBrokenMarkdownReason でスタンプに残す）。
//   結果は毎回 markdown-lint-stamp.json に記録する（許可の主判定は「export 直前 lint」、スタンプは監査用）。
export async function exportFinalArticle(
  store: RunStore,
  runId: string,
  outPath: string,
  options: {
    force?: boolean;
    frontMatter?: boolean;
    allowBrokenMarkdown?: boolean;
    allowBrokenMarkdownReason?: string;
    allowUnverifiedLinks?: boolean;
    allowUnverifiedLinksReason?: string;
  } = {}
): Promise<string> {
  let content = await store.read(runId, "final.md"); // run / final.md が無ければここで失敗
  assertSafeOutputPath(outPath);

  // 公開前到達性ゲート（提案B）。cited な source の到達性メタを記録から判定する（通信しない）。
  // FAIL は --allow-unverified-links --note でのみ override（理由はスタンプに残す）。
  const today = new Date().toISOString().slice(0, 10);
  const meta0 = await store.readMeta(runId).catch(() => null);
  const legacyGrace = meta0?.createdAt ? meta0.createdAt.slice(0, 10) < LINK_GATE_SINCE : false;
  const gate = await evaluateLinkGate(store, runId, today, legacyGrace, {
    allowed: Boolean(options.allowUnverifiedLinks),
    reason: options.allowUnverifiedLinksReason,
  });
  if ("skipped" in gate) {
    process.stderr.write(`Warning: 公開前到達性ゲートをスキップしました（${gate.reason}）。\n`);
  } else {
    for (const w of gate.warnings) {
      process.stderr.write(`Warning: 参考リンク到達性: ${w.message}\n`);
    }
    if (!gate.pass && !options.allowUnverifiedLinks) {
      const detail = gate.fails.map((f) => `  ${f.message}`).join("\n");
      throw new Error(
        `cited な参考リンクに未検証/未解決/死リンクが ${gate.fails.length} 件あります（export 中止）。` +
          `\n  article:sources-check --run ${runId} --only-cited で確認し、dead は代替へ張り替え・unknown は解決してください。` +
          `\n  公開を強行する場合は --allow-unverified-links --note "<理由>" を付けてください。\n${detail}`
      );
    }
    if (!gate.pass && options.allowUnverifiedLinks) {
      process.stderr.write(
        `Warning: 未検証/未解決の参考リンク ${gate.fails.length} 件を override で許可しました（理由: ${options.allowUnverifiedLinksReason ?? ""}）。\n`
      );
    }
  }

  // front-matter 付与前の raw 本文を lint し、結果をスタンプに残す（許可判定は直前 lint が主）。
  const issues = detectBrokenStrongEmphasis(content);
  const result = issues.length === 0 ? "pass" : "fail";
  await store.save(
    runId,
    MARKDOWN_LINT_STAMP_FILE,
    JSON.stringify(
      {
        finalHash: sha256(content),
        ruleVersion: STRONG_EMPHASIS_RULE_VERSION,
        severityMode: "error",
        result,
        verifiedAt: new Date().toISOString().slice(0, 10),
        ...(result === "fail" && options.allowBrokenMarkdown
          ? { allowedBroken: true, reason: options.allowBrokenMarkdownReason ?? "" }
          : {}),
      },
      null,
      2
    )
  );
  if (result === "fail" && !options.allowBrokenMarkdown) {
    const detail = strongEmphasisWarnings(content).join("\n  ");
    throw new Error(
      `final.md に開閉できない強調 ** が ${issues.length} 件あります（export 中止）。約物を ** の外へ出して修正するか、` +
        `--allow-broken-markdown で明示的に上書きしてください。\n  ${detail}`
    );
  }

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
