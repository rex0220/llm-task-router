import { RunStore } from "../storage/RunStore";
import { SeriesStore } from "../storage/SeriesStore";
import type { GlossaryData, GlossaryNoun, GlossaryTerm } from "../storage/glossaryMeta";
import type { SeriesMember } from "../storage/seriesMeta";
// 参考章マーカーは references.ts と共有（定数 drift を避ける）。
import { SOURCES_BEGIN, SOURCES_END } from "./references";

// シリーズ横断の用語・表記一貫性チェック（series:check・実装計画 T3/T4）。
// - 各メンバーの final.md を glossary.yaml に照合し、揺れ（非推奨表記）を列挙する。
// - read-only（本文・series.json は書かない）。事実の正誤は判定しない（factcheck の責務）。
// - 判定は段落単位・context は OR・コードブロック除外・firstUseAlias 例外（提案 §3.1）。

const SNIPPET_RADIUS = 24; // finding 周辺の抜粋（前後の文字数）。可読性のための目安。

// 段落: コードブロックは照合対象外（code: true で除外する）。
export type Paragraph = { text: string; code: boolean };

export type Finding = {
  kind: "term" | "noun";
  preferred: string; // 寄せたい正
  found: string; // 本文に出た揺れ側
  attribute?: string; // noun のとき（location 等）
  paragraphIndex: number;
  snippet: string;
};

// 構造行（見出し・箇条書き項目・順序付き項目・表の行）の先頭判定。
// これらは空行が無くても「別段落」として切る（context OR を同一段落内で見るため、別項目の
// canonical/context と variant が同じ塊に混ざって誤検出するのを防ぐ・実装計画 §3.1）。
const STRUCTURAL_START = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|\|)/;

// 本文を段落に分割する。空行・コードフェンス・構造行の開始で区切り、フェンス内は code:true。
// 構造行（見出し/リスト項目/表の行）は各行を単独段落にし、続く非構造行は別段落になる
// （細かく割れるが、別項目の混在による誤検出を防ぐ＝false-negative 許容）。
export function splitParagraphs(markdown: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const lines = markdown.split(/\r?\n/);
  let buf: string[] = [];
  let inFence = false;
  let fenceMarker = "";

  const flushText = () => {
    if (buf.length > 0) {
      const text = buf.join("\n").trim();
      if (text !== "") {
        paragraphs.push({ text, code: false });
      }
      buf = [];
    }
  };

  let fenceBuf: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const fence = /^(```+|~~~+)/.exec(line);
    if (fence) {
      if (!inFence) {
        // フェンス開始: 直前までのテキスト段落を確定。
        flushText();
        inFence = true;
        fenceMarker = fence[1][0];
        fenceBuf = [raw];
      } else if (line.startsWith(fenceMarker)) {
        // フェンス終了: コード段落として確定（照合対象外）。
        fenceBuf.push(raw);
        paragraphs.push({ text: fenceBuf.join("\n"), code: true });
        inFence = false;
        fenceMarker = "";
        fenceBuf = [];
      } else {
        fenceBuf.push(raw);
      }
      continue;
    }
    if (inFence) {
      fenceBuf.push(raw);
      continue;
    }
    if (line === "") {
      flushText();
    } else if (STRUCTURAL_START.test(line)) {
      // 見出し/リスト項目/表の行は、空行が無くても各行を単独の段落として切る
      // （継続行は次の段落になる＝細かく割れるが、別項目の混在による誤検出を防ぐ）。
      flushText();
      paragraphs.push({ text: line, code: false });
    } else {
      buf.push(raw);
    }
  }
  // 終端処理（閉じられていないフェンスもコード扱いで残す＝本文照合から外す）。
  if (inFence && fenceBuf.length > 0) {
    paragraphs.push({ text: fenceBuf.join("\n"), code: true });
  } else {
    flushText();
  }
  return paragraphs;
}

// 段落を文に割る（句点「。」区切り・最小）。firstUseAlias の「同一文内」判定に使う。
export function splitSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=。)/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function snippetAround(text: string, index: number, term: string): string {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + term.length + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).replace(/\n/g, " ")}${suffix}`;
}

// 用語の揺れ（terms.variants）を検出する。firstUseAlias の例外（§3.1）を適用する。
// 第1段では variants の「ある段落・ある文に出たか」を見る最小実装（記事＝1 final.md 単位）。
// series-wide は型のみ受け、第1段では per-article と同経路で扱い未対応を warnings に積む（呼び出し側）。
export function matchTerms(paragraphs: Paragraph[], terms: GlossaryTerm[]): Finding[] {
  const findings: Finding[] = [];
  for (const term of terms) {
    // まず全 variant の出現を集め、本文上の順（段落→段落内位置）に並べる。
    // これで「初回」は variants 配列の並びではなく実際の出現順で決まる（P3）。
    const occurrences: { pIdx: number; at: number; variant: string }[] = [];
    for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
      const para = paragraphs[pIdx];
      if (para.code) {
        continue;
      }
      for (const variant of term.variants) {
        let from = 0;
        for (;;) {
          const at = para.text.indexOf(variant, from);
          if (at < 0) {
            break;
          }
          occurrences.push({ pIdx, at, variant });
          from = at + variant.length;
        }
      }
    }
    occurrences.sort((a, b) => (a.pIdx !== b.pIdx ? a.pIdx - b.pIdx : a.at - b.at));

    occurrences.forEach((occ, i) => {
      const para = paragraphs[occ.pIdx];
      // per-article 例外は記事内の初回1回だけ許容（series-wide も第1段は per-article 扱い）。
      if (
        i === 0 &&
        term.firstUseAlias !== false &&
        isAllowedAlias(para.text, occ.at, occ.variant, term.preferred)
      ) {
        return; // 正しい初出併記＝検出しない
      }
      findings.push({
        kind: "term",
        preferred: term.preferred,
        found: occ.variant,
        paragraphIndex: occ.pIdx,
        snippet: snippetAround(para.text, occ.at, occ.variant),
      });
    });
  }
  return findings;
}

// 初出併記の許容条件（§3.1）: preferred と同一文内に併記、または括弧内（（）/()）にある。
function isAllowedAlias(paragraph: string, at: number, variant: string, preferred: string): boolean {
  // (b) 括弧内: variant の直前後に開閉括弧があるか（直近の括弧ペアに包まれている簡易判定）。
  const before = paragraph.slice(0, at);
  const after = paragraph.slice(at + variant.length);
  const openIdx = Math.max(before.lastIndexOf("（"), before.lastIndexOf("("));
  if (openIdx >= 0) {
    const closeRel = Math.min(
      ...[after.indexOf("）"), after.indexOf(")")].filter((i) => i >= 0).concat(Infinity)
    );
    // 開き括弧以降に preferred を挟まず variant に到達し、かつ後ろに閉じ括弧があれば括弧内とみなす。
    const between = before.slice(openIdx + 1);
    if (closeRel !== Infinity && !between.includes("（") && !between.includes("(")) {
      return true;
    }
  }
  // (a) 同一文内に preferred が併記されているか。
  for (const sentence of splitSentences(paragraph)) {
    if (sentence.includes(variant) && sentence.includes(preferred)) {
      return true;
    }
  }
  return false;
}

// 固有名詞の属性の揺れ（nouns.attributes.<attr>.variants）を検出する。
// 同一段落内に canonical または contextPatterns のいずれか（OR）があり、かつ同一段落内に
// variants のいずれかが出たら finding（§3.1）。
export function matchNouns(paragraphs: Paragraph[], nouns: GlossaryNoun[]): Finding[] {
  const findings: Finding[] = [];
  for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
    const para = paragraphs[pIdx];
    if (para.code) {
      continue;
    }
    for (const noun of nouns) {
      for (const [attrName, attr] of Object.entries(noun.attributes)) {
        const contextHit =
          para.text.includes(noun.canonical) || attr.contextPatterns.some((c) => para.text.includes(c));
        if (!contextHit) {
          continue;
        }
        for (const variant of attr.variants) {
          const at = para.text.indexOf(variant);
          if (at >= 0) {
            findings.push({
              kind: "noun",
              preferred: attr.preferred,
              found: variant,
              attribute: attrName,
              paragraphIndex: pIdx,
              snippet: snippetAround(para.text, at, variant),
            });
          }
        }
      }
    }
  }
  return findings;
}

// 機械生成の参考章（## 参考）を照合対象から外す（第1.5段・rereview-findings §3-A）。
// 参考章のソース正式名（例「（青森県公式）」）は本文の表記ゆれではないので、本文照合から除く。
// 参考章の台帳一致は verify-artifacts が別途担保する（series:check は本文に集中）。
// fallback 用の参考見出し（references で機械生成の `## 参考` に一本化済みだが、旧 run の別名も拾う）。
const REF_HEADING = /^##\s+(参考|参考リンク|出典)\s*$/;
// 同階層以上（# / ##）の見出し＝参考章の終端。### 以下は参考章の内側とみなす。
const SAME_OR_HIGHER_HEADING = /^#{1,2}\s/;
const FENCE = /^(```+|~~~+)/;

// 各行が「コードフェンスの外か」を返す（fence 区切り行自体は false＝トリガにしない）。
// コード例の中の <!-- sources:begin --> や `## 参考` を参考章と誤認して後続本文を削らないため。
function fenceOutsideFlags(lines: string[]): boolean[] {
  const outside: boolean[] = new Array(lines.length).fill(true);
  let inFence = false;
  let marker = "";
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const fence = FENCE.exec(t);
    if (fence) {
      outside[i] = false; // 区切り行は判定対象外
      if (!inFence) {
        inFence = true;
        marker = fence[1][0];
      } else if (t.startsWith(marker)) {
        inFence = false;
        marker = "";
      }
      continue;
    }
    outside[i] = !inFence;
  }
  return outside;
}

export function stripReferenceBlock(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const outside = fenceOutsideFlags(lines);

  // 第一優先: マーカー区間 <!-- sources:begin --> … <!-- sources:end --> を除去（fence 外のみ）。
  const begin = lines.findIndex((l, i) => outside[i] && l.includes(SOURCES_BEGIN));
  if (begin >= 0) {
    let end = -1;
    for (let i = begin + 1; i < lines.length; i++) {
      if (outside[i] && lines[i].includes(SOURCES_END)) {
        end = i;
        break;
      }
    }
    // end 無し（閉じ忘れ）は begin 以降を EOF まで落とす保険。
    const cut = end >= 0 ? end + 1 : lines.length;
    return [...lines.slice(0, begin), ...lines.slice(cut)].join("\n");
  }

  // fallback: マーカーが無い場合のみ、`## 参考` 見出し（fence 外）から
  // 「次の同階層以上（# / ##・fence 外）の見出し、または EOF まで」を除去する。
  const start = lines.findIndex((l, i) => outside[i] && REF_HEADING.test(l.trim()));
  if (start < 0) {
    return markdown;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (outside[i] && SAME_OR_HIGHER_HEADING.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

// 本文 1 件分の照合（純関数・テスト容易）。参考章を除いてから段落分割する。
export function checkArticle(markdown: string, glossary: GlossaryData): Finding[] {
  const paragraphs = splitParagraphs(stripReferenceBlock(markdown));
  return [...matchTerms(paragraphs, glossary.terms), ...matchNouns(paragraphs, glossary.nouns)];
}

export type MemberReport = {
  order: number;
  slug: string;
  runId: string | null;
  findings: Finding[];
  skipped?: string; // skip 理由（planned / final.md missing 等・silent skip 禁止）
};

export type SeriesCheckReport = {
  seriesId: string;
  missingGlossary: boolean;
  glossary?: { hash: string; schemaVersion: number; revision?: number };
  checkedAt: string;
  members: MemberReport[];
  totalFindings: number;
  warnings: string[];
};

export type SeriesCheckDeps = { seriesStore?: SeriesStore; runStore?: RunStore; now?: () => string };

// シリーズ全メンバーを照合してレポートを返す（read-only・実装計画 T4）。
export async function runSeriesCheck(slug: string, deps: SeriesCheckDeps = {}): Promise<SeriesCheckReport> {
  const seriesStore = deps.seriesStore ?? new SeriesStore();
  const runStore = deps.runStore ?? new RunStore();
  const now = deps.now ?? (() => new Date().toISOString());

  const series = await seriesStore.read(slug);
  if (!series) {
    throw new Error(`Series not found: ${slug} (run series:init first)`);
  }

  const glossary = await seriesStore.readGlossary(slug);
  const warnings: string[] = [];

  if (!glossary) {
    // glossary 未設定: 落とさず missingGlossary を立てて全 skip（--strict 側で exit 1・実装計画 T4/T5）。
    return {
      seriesId: series.seriesId,
      missingGlossary: true,
      checkedAt: now(),
      members: series.members.map((m) => skipMember(m, "glossary not configured")),
      totalFindings: 0,
      warnings,
    };
  }

  // 別シリーズの glossary を取り違えて置いた事故を弾く（P1）。
  if (glossary.data.seriesId !== series.seriesId) {
    throw new Error(
      `glossary.yaml seriesId "${glossary.data.seriesId}" does not match series.json seriesId "${series.seriesId}"`
    );
  }

  // series-wide は第1段では per-article と同経路（初回1回許容）で扱う。差異を明示する。
  if (glossary.data.terms.some((t) => t.firstUseAlias === "series-wide")) {
    warnings.push(
      "firstUseAlias: series-wide is treated as per-article in this build (series-wide scope not implemented yet)."
    );
  }

  const members: MemberReport[] = [];
  let totalFindings = 0;
  for (const member of series.members) {
    if (member.runId === null) {
      members.push(skipMember(member, "planned"));
      continue;
    }
    let markdown: string;
    try {
      markdown = await runStore.read(member.runId, "final.md");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      const reason = err.code === "ENOENT" ? "final.md missing" : `final.md unreadable: ${err.message}`;
      members.push(skipMember(member, reason));
      continue;
    }
    const findings = checkArticle(markdown, glossary.data);
    totalFindings += findings.length;
    members.push({ order: member.order, slug: member.slug, runId: member.runId, findings });
  }

  return {
    seriesId: series.seriesId,
    missingGlossary: false,
    glossary:
      glossary.data.revision === undefined
        ? { hash: glossary.hash, schemaVersion: glossary.data.schemaVersion }
        : { hash: glossary.hash, schemaVersion: glossary.data.schemaVersion, revision: glossary.data.revision },
    checkedAt: now(),
    members,
    totalFindings,
    warnings,
  };
}

function skipMember(m: SeriesMember, reason: string): MemberReport {
  return { order: m.order, slug: m.slug, runId: m.runId, findings: [], skipped: reason };
}
