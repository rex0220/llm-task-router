import type { RunMeta, RunStore } from "../storage/RunStore";
import { ClaimsSchema, SourcesSchema, type Claim, type Source } from "../schemas/ClaimsSchema";
import { CLAIMS_FILE, SOURCES_FILE, collectCitedSourceIds } from "./claimsNormalize";

// 参考章に「検証済みソースのリンク」を機械生成する（優先度: 記事出力の検証経路を読者へ）。
// - リンクは sources.json（検証済み）が正本。LLM に URL を書かせない（偽 URL 捏造防止）。
// - 載せるのは lifecycle:"present" かつ status:"verified" な claim が参照する source のみ。
// - 参考章はマーカーブロックで管理し、再生成で人の前後文を壊さない。
// - 見出しは既定 `## 参考`。run 単位でカスタム可（meta.referencesHeading・first-write-wins）。
//   正本はマーカーで、見出しはブロックの外側にあるため、検証ゲート（verify-artifacts/stats）は見出し非依存。

export const SOURCES_BEGIN = "<!-- sources:begin -->";
export const SOURCES_END = "<!-- sources:end -->";
export const DEFAULT_REFERENCES_HEADING = "参考";
// 旧既定 `## 参考` の照合（カスタム見出しが本文に未生成のとき adoption する固定アンカー）。
const REFERENCES_HEADING_RE = /^##\s+参考\s*$/;

// LLM が本文に書きがちな参考リスト見出し（機械生成の `## 参考` とは別物）。
// references は sources.json から `## 参考` を機械生成するので、これら LLM 製の参考リスト節は
// 「二重化＋台帳照合されない未検証 URL の温床」になる（偽 URL 防止の趣旨を骨抜きにする）。
const LLM_REFERENCE_HEADING_RE =
  /^##\s+(参考リンク|参考文献|参考資料|参考URL|出典|参照|References?|Reference Links?|Sources?)\s*$/i;

// 正規表現メタ文字を escape する（カスタム見出しは `(` `+` `[` 等を含みうる）。
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 設定見出しから `## <heading>` 行の照合正規表現を作る（必ず escape する）。
export function headingMatcher(heading: string): RegExp {
  return new RegExp(`^##\\s+${escapeRe(heading)}\\s*$`);
}

// 参考章見出しのバリデーション（trim 後に検査）。ok 時は正規化済み value を返す。
// - 空（trim 後）/ 改行 / `#` / HTML コメント記号は不可。
// - LLM 製参考節の見出し（LLM_REFERENCE_HEADING_RE）と衝突する語は不可（機械ブロック誤除去を防ぐ）。
export function validateReferencesHeading(
  input: string
): { ok: true; value: string } | { ok: false; reason: string } {
  const value = input.trim();
  if (value.length === 0) return { ok: false, reason: "見出しが空です（前後空白を除くと空）" };
  if (/[\r\n]/.test(value)) return { ok: false, reason: "見出しに改行を含められません" };
  if (value.includes("#")) return { ok: false, reason: "見出しに # を含められません（## は自動で付きます）" };
  if (value.includes("<!--") || value.includes("-->")) {
    return { ok: false, reason: "見出しに HTML コメント記号（<!-- / -->）を含められません" };
  }
  if (LLM_REFERENCE_HEADING_RE.test(`## ${value}`)) {
    return { ok: false, reason: `「${value}」は LLM 製参考節の見出しと衝突します（別表現を選んでください）` };
  }
  return { ok: true, value };
}

// run の参考章見出しを解決する（未設定・空は既定 `参考`）。
export function resolveReferencesHeading(meta: Pick<RunMeta, "referencesHeading">): string {
  return meta.referencesHeading?.trim() || DEFAULT_REFERENCES_HEADING;
}

// LLM 製の参考リスト節（上記見出し＋URL を含む）を除去する。`## 参考`（機械生成）は対象外。
// URL を含まない同名見出しの散文節は誤除去しない（hasUrl ガード）。sources マーカーを含む節も触らない。
// configuredHeading（カスタム参考章見出し）は機械生成側なので、万一 LLM 正規表現に当たっても除去しない（二重防御）。
export function stripLlmReferenceSections(
  body: string,
  configuredHeading?: string
): { body: string; removed: string[] } {
  const lines = body.split("\n");
  const out: string[] = [];
  const removed: string[] = [];
  const configuredRe = configuredHeading ? headingMatcher(configuredHeading) : null;
  let i = 0;
  while (i < lines.length) {
    if (LLM_REFERENCE_HEADING_RE.test(lines[i]) && !(configuredRe && configuredRe.test(lines[i]))) {
      // 節の範囲＝見出し直下〜次の見出し（# または ##）/ EOF。
      let j = i + 1;
      while (j < lines.length && !/^#{1,2}\s+/.test(lines[j])) {
        j++;
      }
      const section = lines.slice(i, j);
      const hasUrl = section.some((l) => /https?:\/\//.test(l));
      const isMachineBlock = section.some((l) => l.includes(SOURCES_BEGIN));
      if (hasUrl && !isMachineBlock) {
        removed.push(lines[i].replace(/^##\s+/, "").trim());
        i = j; // 節をまるごと飛ばす
        continue;
      }
    }
    out.push(lines[i]);
    i++;
  }
  return { body: out.join("\n"), removed };
}

// present かつ verified な claim が参照する source だけを、id 昇順で返す（重複排除）。
// id は SOURCE_ID_RE（^S\d{3}$）で3桁ゼロ詰め固定なので、文字列ソートでそのまま番号順になる。
// 防御として reachable:"dead" は参考章に出さない（死リンクを焼かない。台帳不整合の検出は verify-artifacts）。
export function selectReferenceSources(claims: Claim[], sources: Source[]): Source[] {
  const citedIds = collectCitedSourceIds(claims);
  const byId = new Map(sources.map((s) => [s.id, s] as const));
  const picked: Source[] = [];
  const seen = new Set<string>();
  for (const id of citedIds) {
    const s = byId.get(id);
    if (s && !seen.has(s.id) && s.reachable !== "dead") {
      seen.add(s.id);
      picked.push(s);
    }
  }
  return picked.sort((a, b) => a.id.localeCompare(b.id));
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
// warnings は純関数として返すだけ（stderr 出力は呼び出し側 article:references の責務）。
export type ReplaceResult = { content: string; status: ReplaceStatus; warnings?: string[] };

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
}

// 参考ブロックを本文へ反映する（heading＝参考章見出し・既定 `参考`）。
// (1) マーカーがちょうど1組・正順 → その範囲を block で置換（見出し行は触らない＝既存カスタム見出しを保持）。
// (2) マーカー無しで参考章見出しがある → 章本文（見出し直下〜次見出し/EOF）を丸ごと block で置換（二重化防止）。
//     2a: 設定見出しに一致する章 → 章本文だけ置換（見出し保持）。
//     2b: 設定見出しが無く旧 `## 参考` がある → その章本文を置換し、見出しを `## <heading>` に rename（adoption）。
//         初回生成で LLM が本文に旧 `## 参考` を書いていても二重見出しを作らないため。
//     異常系: 設定見出し（≠参考）と旧 `## 参考` が両方ある → 設定見出しを置換し旧 `## 参考` は残置＋warning。
// (3) 参考章見出しも無い → 末尾に `## <heading>` ＋ block を新規作成。
// マーカーが欠落・複数・逆順なら破損とみなし throw（壊れた本文を機械置換でさらに壊さない）。
export function replaceMarkedBlock(
  body: string,
  begin: string,
  end: string,
  block: string,
  heading: string = DEFAULT_REFERENCES_HEADING
): ReplaceResult {
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

  // マーカー無し: 既存の参考章見出しがあれば章本文を置換。
  const lines = body.split("\n");
  const configuredRe = headingMatcher(heading);
  const warnings: string[] = [];
  const isDefault = heading === DEFAULT_REFERENCES_HEADING;

  // 2a: 設定見出しを最優先で探す。無ければ 2b: 旧 `## 参考` を adoption（rename）。
  let headingIdx = lines.findIndex((l) => configuredRe.test(l));
  let rename = false;
  if (headingIdx < 0 && !isDefault) {
    headingIdx = lines.findIndex((l) => REFERENCES_HEADING_RE.test(l));
    rename = headingIdx >= 0;
  }

  if (headingIdx >= 0) {
    // 異常系: 設定見出し（≠参考）を採用したが、別に旧 `## 参考` も残っている。
    if (!isDefault && !rename) {
      const legacyIdx = lines.findIndex((l) => REFERENCES_HEADING_RE.test(l));
      if (legacyIdx >= 0 && legacyIdx !== headingIdx) {
        warnings.push("参考章の見出しが複数あります（旧 ## 参考 が残存）。手で統合してください");
      }
    }
    let sectionEnd = lines.length;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      if (/^#{1,2}\s+/.test(lines[i])) {
        sectionEnd = i;
        break;
      }
    }
    const headingLine = rename ? `## ${heading}` : lines[headingIdx]; // adoption 時は rename
    const before = [...lines.slice(0, headingIdx), headingLine]; // 見出しは残す
    const after = lines.slice(sectionEnd); // 次見出し以降
    const merged = [...before, "", block, "", ...after].join("\n");
    return { content: merged, status: "section-replaced", ...(warnings.length ? { warnings } : {}) };
  }

  // 参考章見出しも無い: 末尾に新規作成。
  const trimmed = body.replace(/\s+$/, "");
  return { content: `${trimmed}\n\n## ${heading}\n\n${block}\n`, status: "created" };
}

// claims.json / sources.json を読んで参考ブロックを作る（I/O ラッパ）。
// claims/sources が無ければ「claims-normalize を先に」、verified source 0件なら明確なエラー。
export async function prepareReferencesBlock(
  store: RunStore,
  runId: string
): Promise<{ block: string; count: number; warnings: string[] }> {
  const claims = await readLedger(store, runId, CLAIMS_FILE, ClaimsSchema);
  const sources = await readLedger(store, runId, SOURCES_FILE, SourcesSchema);
  const selected = selectReferenceSources(claims, sources);
  // cited な source の到達性 warn を返す（CLI が stderr 出力）。
  // - dead: 参考章から防御的に除外したもの。
  // - unknown: 参考章には載せる（除外しない＝refine ループを壊さない）が、公開直前に解決すべき注意。
  //   除外・停止の判断は公開前ゲート（linkGate / article:export）に集約する（C-2）。
  const citedIds = collectCitedSourceIds(claims);
  const warnings = sources
    .filter((s) => citedIds.has(s.id) && (s.reachable === "dead" || s.reachable === "unknown"))
    .map((s) =>
      s.reachable === "dead"
        ? `参考章から除外（reachable=dead）: ${s.id} ${s.url}`
        : `参考章に掲載（reachable=unknown・公開前に解決を）: ${s.id} ${s.url}`
    );
  if (selected.length === 0) {
    throw new Error(
      "参考に載せる検証済み source がありません（present かつ verified の claim が参照する source なし／到達可能なもの無し）。factcheck / article:claims-normalize を確認してください。"
    );
  }
  return { block: renderReferencesBlock(selected), count: selected.length, warnings };
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
