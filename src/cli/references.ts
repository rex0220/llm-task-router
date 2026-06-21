import type { RunStore } from "../storage/RunStore";
import { ClaimsSchema, SourcesSchema, type Claim, type Source } from "../schemas/ClaimsSchema";
import { CLAIMS_FILE, SOURCES_FILE } from "./claimsNormalize";

// 参考章に「検証済みソースのリンク」を機械生成する（優先度: 記事出力の検証経路を読者へ）。
// - リンクは sources.json（検証済み）が正本。LLM に URL を書かせない（偽 URL 捏造防止）。
// - 載せるのは lifecycle:"present" かつ status:"verified" な claim が参照する source のみ。
// - 参考章はマーカーブロックで管理し、再生成で人の前後文を壊さない。見出しは `## 参考` 固定。

export const SOURCES_BEGIN = "<!-- sources:begin -->";
export const SOURCES_END = "<!-- sources:end -->";
const REFERENCES_HEADING_RE = /^##\s+参考\s*$/;

const SOURCE_TYPE_ORDER: Record<Source["sourceType"], number> = { primary: 0, secondary: 1 };

// present かつ verified な claim が参照する source だけを、primary→secondary・id 昇順で返す（重複排除）。
export function selectReferenceSources(claims: Claim[], sources: Source[]): Source[] {
  const citedIds = new Set<string>();
  for (const c of claims) {
    if (c.lifecycle === "present" && c.status === "verified") {
      for (const sid of c.sourceIds) {
        citedIds.add(sid);
      }
    }
  }
  const byId = new Map(sources.map((s) => [s.id, s] as const));
  const picked: Source[] = [];
  const seen = new Set<string>();
  for (const id of citedIds) {
    const s = byId.get(id);
    if (s && !seen.has(s.id)) {
      seen.add(s.id);
      picked.push(s);
    }
  }
  return picked.sort(
    (a, b) => SOURCE_TYPE_ORDER[a.sourceType] - SOURCE_TYPE_ORDER[b.sourceType] || a.id.localeCompare(b.id)
  );
}

// 選定済み source を参考ブロック（マーカー込み）に描画する。
export function renderReferencesBlock(sources: Source[]): string {
  const lines = [SOURCES_BEGIN];
  for (const s of sources) {
    lines.push(`- [${s.id}] ${s.title}（${s.sourceType}, retrieved: ${s.retrievedAt}）`);
    lines.push(`  ${s.url}`);
  }
  lines.push(SOURCES_END);
  return lines.join("\n");
}

export type ReplaceStatus = "replaced" | "section-replaced" | "created";
export type ReplaceResult = { content: string; status: ReplaceStatus };

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
}

// 参考ブロックを本文へ反映する。
// (1) マーカーがちょうど1組・正順 → その範囲を block で置換。
// (2) マーカー無しで `## 参考` 章がある → 章本文（見出し直下〜次見出し/EOF）を丸ごと block で置換（二重化防止）。
// (3) `## 参考` 章も無い → 末尾に `## 参考` ＋ block を新規作成。
// マーカーが欠落・複数・逆順なら破損とみなし throw（壊れた本文を機械置換でさらに壊さない）。
export function replaceMarkedBlock(body: string, begin: string, end: string, block: string): ReplaceResult {
  const bCount = countOccurrences(body, begin);
  const eCount = countOccurrences(body, end);

  if (bCount > 0 || eCount > 0) {
    const bIdx = body.indexOf(begin);
    const eIdx = body.indexOf(end);
    const wellFormed = bCount === 1 && eCount === 1 && bIdx < eIdx;
    if (!wellFormed) {
      throw new Error(
        "参考ブロックのマーカーが壊れています（begin/end が1組・正順ではありません）。手で修復してから再実行してください。"
      );
    }
    return { content: `${body.slice(0, bIdx)}${block}${body.slice(eIdx + end.length)}`, status: "replaced" };
  }

  // マーカー無し: 既存 `## 参考` 章があれば章本文を置換。
  const lines = body.split("\n");
  const headingIdx = lines.findIndex((l) => REFERENCES_HEADING_RE.test(l));
  if (headingIdx >= 0) {
    let sectionEnd = lines.length;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      if (/^#{1,2}\s+/.test(lines[i])) {
        sectionEnd = i;
        break;
      }
    }
    const before = lines.slice(0, headingIdx + 1); // 見出しは残す
    const after = lines.slice(sectionEnd); // 次見出し以降
    const merged = [...before, "", block, "", ...after].join("\n");
    return { content: merged, status: "section-replaced" };
  }

  // `## 参考` 章も無い: 末尾に新規作成。
  const trimmed = body.replace(/\s+$/, "");
  return { content: `${trimmed}\n\n## 参考\n\n${block}\n`, status: "created" };
}

// claims.json / sources.json を読んで参考ブロックを作る（I/O ラッパ）。
// claims/sources が無ければ「claims-normalize を先に」、verified source 0件なら明確なエラー。
export async function prepareReferencesBlock(
  store: RunStore,
  runId: string
): Promise<{ block: string; count: number }> {
  const claims = await readLedger(store, runId, CLAIMS_FILE, ClaimsSchema);
  const sources = await readLedger(store, runId, SOURCES_FILE, SourcesSchema);
  const selected = selectReferenceSources(claims, sources);
  if (selected.length === 0) {
    throw new Error(
      "参考に載せる検証済み source がありません（present かつ verified の claim が参照する source なし）。factcheck / article:claims-normalize を確認してください。"
    );
  }
  return { block: renderReferencesBlock(selected), count: selected.length };
}

async function readLedger<T>(
  store: RunStore,
  runId: string,
  file: string,
  schema: { parse: (v: unknown) => T }
): Promise<T> {
  const raw = await store.read(runId, file).catch(() => null);
  if (raw === null) {
    throw new Error(`${file} がありません（runs/${runId}/）。先に article:claims-normalize を実行してください。`);
  }
  return schema.parse(JSON.parse(raw));
}
