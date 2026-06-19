// published / lineage / export index の書き込み経路で使う検証。
// readMeta は無検証（後方互換）なので、値の正しさは「書き込む側」で担保する。

// runId と同じ安全文字種。slug / articleId を JSON object のキーや
// パス様の文字列として安全に扱うための共通ガード。
export const SAFE_ID = /^[A-Za-z0-9._-]+$/;

// JSON object のキーに使う slug のプロトタイプ汚染対策。
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function validateSafeId(value: string, label: string): string {
  if (!SAFE_ID.test(value) || value === "." || value === ".." || value.includes("..")) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value;
}

// slug は export/index.json のキーになる。安全文字種＋予約キー拒否。
export function validateSlug(slug: string): string {
  if (RESERVED_KEYS.has(slug)) {
    throw new Error(`Invalid slug (reserved key): ${slug}`);
  }
  return validateSafeId(slug, "slug");
}

export function validateUrl(url: string): string {
  if (!/^https?:\/\/\S+$/.test(url)) {
    throw new Error(`Invalid url: ${url} (must start with http:// or https://)`);
  }
  return url;
}

export function validateVersion(version: number): number {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`Invalid version: ${version} (use an integer >= 1)`);
  }
  return version;
}

export type PublicationInput = {
  url: string;
  articleId: string;
  version: number;
};

// published 用の入力を検証する（updatedAt は呼び出し側が時刻方針に従って付ける）。
export function validatePublicationInput(input: PublicationInput): PublicationInput {
  return {
    url: validateUrl(input.url),
    articleId: validateSafeId(input.articleId, "articleId"),
    version: validateVersion(input.version),
  };
}
