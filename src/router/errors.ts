export type RouterErrorKind =
  | "rate_limit"
  | "timeout"
  | "overloaded"
  | "service_unavailable"
  | "connection"
  | "auth"
  | "billing_quota"
  | "context_length"
  | "schema_validation"
  | "bad_request"
  | "config"
  | "unknown";

export class RouterError extends Error {
  readonly kind: RouterErrorKind;
  readonly statusCode?: number;

  constructor(message: string, kind: RouterErrorKind, statusCode?: number) {
    super(message);
    this.name = "RouterError";
    this.kind = kind;
    this.statusCode = statusCode;
  }
}

export function isRouterError(error: unknown): error is RouterError {
  return error instanceof RouterError;
}

export function normalizeProviderError(error: unknown): RouterError {
  if (isRouterError(error)) {
    return error;
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return new RouterError("Provider request was aborted", "timeout");
  }

  const maybeError = error as {
    name?: unknown;
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    type?: unknown;
    message?: unknown;
  };

  const statusCode = toNumber(maybeError.status ?? maybeError.statusCode);
  const code = toLowerString(maybeError.code);
  const type = toLowerString(maybeError.type);
  const name = toLowerString(maybeError.name);
  const message = safeMessage(maybeError.message ?? String(error));
  const haystack = `${name} ${code} ${type}`;

  if (statusCode === 401 || statusCode === 403 || includesAny(haystack, ["authentication", "permission", "auth"])) {
    return new RouterError(message, "auth", statusCode);
  }

  if (includesAny(haystack, ["insufficient_quota", "billing", "payment", "credit"])) {
    return new RouterError(message, "billing_quota", statusCode);
  }

  if (statusCode === 429 || includesAny(haystack, ["rate_limit", "ratelimit"])) {
    return new RouterError(message, "rate_limit", statusCode);
  }

  if (includesAny(haystack, ["timeout", "timedout", "abort"])) {
    return new RouterError(message, "timeout", statusCode);
  }

  if (statusCode === 529 || includesAny(haystack, ["overloaded"])) {
    return new RouterError(message, "overloaded", statusCode);
  }

  if (statusCode === 503 || statusCode === 502 || statusCode === 504) {
    return new RouterError(message, "service_unavailable", statusCode);
  }

  if (statusCode && statusCode >= 500) {
    return new RouterError(message, "service_unavailable", statusCode);
  }

  if (includesAny(haystack, ["connection", "network", "fetch", "econnreset", "enotfound"])) {
    return new RouterError(message, "connection", statusCode);
  }

  if (statusCode === 400 || includesAny(haystack, ["badrequest", "bad_request", "invalid_request"])) {
    return new RouterError(message, "bad_request", statusCode);
  }

  if (includesAny(haystack, ["context_length", "too_large", "token"])) {
    return new RouterError(message, "context_length", statusCode);
  }

  return new RouterError(message, "unknown", statusCode);
}

export function shouldFallback(kind: RouterErrorKind): boolean {
  return [
    "rate_limit",
    "timeout",
    "overloaded",
    "service_unavailable",
    "connection",
    "schema_validation",
  ].includes(kind);
}

export function errorForLog(error: unknown): {
  kind: RouterErrorKind;
  message: string;
  statusCode?: number;
} {
  const normalized = normalizeProviderError(error);
  return {
    kind: normalized.kind,
    message: safeMessage(normalized.message),
    statusCode: normalized.statusCode,
  };
}

function includesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function toLowerString(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function safeMessage(value: unknown): string {
  const text = typeof value === "string" ? value : "Provider request failed";
  return text.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 300);
}
