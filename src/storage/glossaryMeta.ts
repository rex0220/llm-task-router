// glossary.yaml（シリーズの用語・表記辞書）のスキーマと検証。
// series-glossary-consistency-proposal §3 / 実装計画 T1 の正本。
// series.json（横の束）とは別ファイル・別正本で、series:check が本文照合に使う。
import { validateSeriesId } from "./seriesMeta";

// 既知のファイル形式版。未知版は throw（古いコードで新形式を黙って読まない）。
export const GLOSSARY_SCHEMA_VERSION = 1;

// attribute キーの安全文字種（ASCII の小文字スネーク）。非 ASCII（「所在地」等）は
// 第1段では拒否する（許すならプロトタイプ汚染とは別のガードが要る・実装計画 T1 軽微）。
const ATTR_KEY = /^[a-z][a-z0-9_]*$/;
// プロトタイプ汚染対策（attributes を素の object に蓄積する前に弾く）。
const RESERVED_ATTR_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// 別称併記の許容範囲（§3.1）。
//   per-article: 各記事の初回1回だけ preferred 同一文内 or 括弧内なら許容（既定）
//   series-wide: シリーズ全体で最初の1記事の初出1回だけ許容（第1段は型のみ・未対応 warning）
//   false      : 例外なし（variants は常に検出）
export type FirstUseAlias = "per-article" | "series-wide" | false;

const FIRST_USE_ALIASES: readonly (string | boolean)[] = ["per-article", "series-wide", false];

export function parseFirstUseAlias(value: unknown): FirstUseAlias {
  return FIRST_USE_ALIASES.includes(value as string | boolean) ? (value as FirstUseAlias) : "per-article";
}

export type GlossaryTerm = {
  preferred: string;
  variants: string[];
  firstUseAlias: FirstUseAlias;
  note?: string;
};

export type GlossaryAttr = {
  preferred: string;
  variants: string[];
  contextPatterns: string[];
};

export type GlossaryNoun = {
  canonical: string;
  attributes: Record<string, GlossaryAttr>;
};

export type GlossaryData = {
  schemaVersion: number;
  revision?: number;
  seriesId: string;
  terms: GlossaryTerm[];
  nouns: GlossaryNoun[];
};

// glossary.yaml を検証する。破損（非オブジェクト・型不一致・未知版・予約キー）は throw（空扱いにしない）。
// seriesId は「形式」だけ検証する（series.json との一致は形を持たない validator では判定できないため
// runSeriesCheck 側で比較する・実装計画 T1/T4 / P1）。numbers/format キーは第1段では無視（前方互換）。
export function validateGlossaryData(parsed: unknown, source = "glossary.yaml"): GlossaryData {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Corrupt ${source} (expected a YAML mapping).`);
  }
  const data = parsed as Record<string, unknown>;

  if (typeof data.schemaVersion !== "number" || !Number.isInteger(data.schemaVersion)) {
    throw new Error(`Corrupt ${source} (schemaVersion must be an integer).`);
  }
  if (data.schemaVersion !== GLOSSARY_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported ${source} schemaVersion ${data.schemaVersion} (this build supports ${GLOSSARY_SCHEMA_VERSION}).`
    );
  }

  const seriesId = validateSeriesId(String(data.seriesId ?? ""));

  let revision: number | undefined;
  if (data.revision !== undefined) {
    if (typeof data.revision !== "number" || !Number.isInteger(data.revision)) {
      throw new Error(`Corrupt ${source} (revision must be an integer when present).`);
    }
    revision = data.revision;
  }

  const terms = validateTerms(data.terms, source);
  const nouns = validateNouns(data.nouns, source);

  return revision === undefined
    ? { schemaVersion: GLOSSARY_SCHEMA_VERSION, seriesId, terms, nouns }
    : { schemaVersion: GLOSSARY_SCHEMA_VERSION, revision, seriesId, terms, nouns };
}

function validateTerms(value: unknown, source: string): GlossaryTerm[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Corrupt ${source} (terms must be an array).`);
  }
  return value.map((t, i) => {
    if (t === null || typeof t !== "object" || Array.isArray(t)) {
      throw new Error(`Corrupt ${source} (terms[${i}] must be an object).`);
    }
    const term = t as Record<string, unknown>;
    const preferred = requireNonEmptyString(term.preferred, `terms[${i}].preferred`, source);
    const variants = validateStringArray(term.variants, `terms[${i}].variants`, source);
    const firstUseAlias = parseFirstUseAlias(term.firstUseAlias);
    const note = typeof term.note === "string" && term.note.trim() !== "" ? term.note.trim() : undefined;
    return note === undefined
      ? { preferred, variants, firstUseAlias }
      : { preferred, variants, firstUseAlias, note };
  });
}

function validateNouns(value: unknown, source: string): GlossaryNoun[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Corrupt ${source} (nouns must be an array).`);
  }
  return value.map((n, i) => {
    if (n === null || typeof n !== "object" || Array.isArray(n)) {
      throw new Error(`Corrupt ${source} (nouns[${i}] must be an object).`);
    }
    const noun = n as Record<string, unknown>;
    const canonical = requireNonEmptyString(noun.canonical, `nouns[${i}].canonical`, source);
    const attributes = validateAttributes(noun.attributes, `nouns[${i}].attributes`, source);
    return { canonical, attributes };
  });
}

function validateAttributes(value: unknown, path: string, source: string): Record<string, GlossaryAttr> {
  // attributes 省略は空（属性を持たない固有名詞＝混同検出の note だけ等を許す）。
  if (value === undefined) {
    return Object.create(null) as Record<string, GlossaryAttr>;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Corrupt ${source} (${path} must be an object).`);
  }
  const out: Record<string, GlossaryAttr> = Object.create(null);
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (RESERVED_ATTR_KEYS.has(key)) {
      throw new Error(`Corrupt ${source} (${path}.${key} is a reserved key).`);
    }
    if (!ATTR_KEY.test(key)) {
      throw new Error(`Corrupt ${source} (${path} key "${key}" must match ${ATTR_KEY} — non-ASCII keys are not supported yet).`);
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Corrupt ${source} (${path}.${key} must be an object).`);
    }
    const attr = raw as Record<string, unknown>;
    out[key] = {
      preferred: requireNonEmptyString(attr.preferred, `${path}.${key}.preferred`, source),
      variants: validateStringArray(attr.variants, `${path}.${key}.variants`, source),
      contextPatterns: validateStringArray(attr.contextPatterns, `${path}.${key}.contextPatterns`, source),
    };
  }
  return out;
}

function requireNonEmptyString(value: unknown, path: string, source: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Corrupt ${source} (${path} must be a non-empty string).`);
  }
  return value.trim();
}

// 文字列配列を検証する。欠落は空配列。要素は非空文字列（トリム）。
function validateStringArray(value: unknown, path: string, source: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Corrupt ${source} (${path} must be an array).`);
  }
  return value.map((v, i) => requireNonEmptyString(v, `${path}[${i}]`, source));
}
