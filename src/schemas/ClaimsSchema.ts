import { z } from "zod";

// claims / sources の機械可読台帳スキーマ（docs/claims-schema-notes.md / spec #3）。
// factchecker は idless raw を出し、article:claims-normalize（コード）が id 採番・台帳化する。

export const CLAIM_TYPES = ["api", "price", "version", "technical", "general"] as const;
export const CLAIM_STATUSES = ["unverified", "verified", "needs-source", "incorrect"] as const;
export const CLAIM_LIFECYCLES = ["present", "removed"] as const;
export const SEVERITIES = ["critical", "major", "minor", "suggestion"] as const;
export const SOURCE_TYPES = ["primary", "secondary"] as const;

export const CLAIM_ID_RE = /^C\d{3}-[0-9a-f]{8}$/;
export const SOURCE_ID_RE = /^S\d{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// --- factchecker 生出力（idless raw） ---

export const RawClaimSchema = z
  .object({
    claim: z.string().trim().min(1),
    location: z.object({ heading: z.string() }),
    type: z.enum(CLAIM_TYPES),
    status: z.enum(CLAIM_STATUSES),
    sourceRefs: z.array(z.string().min(1)),
    severity: z.enum(SEVERITIES),
    note: z.string().optional().default(""),
  })
  // 残リスク反映: verified は裏取り済みなので出典必須。
  .refine((c) => c.status !== "verified" || c.sourceRefs.length > 0, {
    message: "status 'verified' requires at least one sourceRef",
    path: ["sourceRefs"],
  });

export const RawSourceSchema = z.object({
  key: z.string().min(1),
  url: z.string().url(),
  title: z.string().default(""),
  retrievedAt: z.string().regex(DATE_RE),
  sourceType: z.enum(SOURCE_TYPES).default("secondary"),
  summary: z.string().default(""),
});

export const RawClaimsSchema = z.array(RawClaimSchema);
export const RawSourcesSchema = z.array(RawSourceSchema).superRefine((sources, ctx) => {
  const seen = new Map<string, number>();
  sources.forEach((source, index) => {
    const first = seen.get(source.key);
    if (first !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate source key '${source.key}' (first seen at index ${first})`,
        path: [index, "key"],
      });
      return;
    }
    seen.set(source.key, index);
  });
});

export type RawClaim = z.infer<typeof RawClaimSchema>;
export type RawSource = z.infer<typeof RawSourceSchema>;

// --- normalize 後の公開ビュー（claims.json / sources.json） ---

// base object（refine 前。.extend() で台帳スキーマに継承するため分離）。
export const ClaimFieldsSchema = z.object({
  id: z.string().regex(CLAIM_ID_RE),
  claim: z.string().min(1),
  location: z.object({ heading: z.string(), anchorHash: z.string().regex(/^[0-9a-f]{8}$/) }),
  type: z.enum(CLAIM_TYPES),
  status: z.enum(CLAIM_STATUSES),
  lifecycle: z.enum(CLAIM_LIFECYCLES),
  sourceIds: z.array(z.string().regex(SOURCE_ID_RE)),
  severity: z.enum(SEVERITIES),
  note: z.string(),
});

// verified は裏取り済み＝出典必須（raw だけでなく公開 claims.json でも担保）。
const verifiedHasSource = (c: { status: string; sourceIds: string[] }): boolean =>
  c.status !== "verified" || c.sourceIds.length > 0;
const verifiedHasSourceMsg = { message: "status 'verified' requires at least one sourceId", path: ["sourceIds"] };

export const ClaimSchema = ClaimFieldsSchema.refine(verifiedHasSource, verifiedHasSourceMsg);

export const SourceSchema = z.object({
  id: z.string().regex(SOURCE_ID_RE),
  url: z.string().url(),
  title: z.string(),
  retrievedAt: z.string().regex(DATE_RE),
  sourceType: z.enum(SOURCE_TYPES),
  summary: z.string(),
});

export const ClaimsSchema = z.array(ClaimSchema);
export const SourcesSchema = z.array(SourceSchema);

export type Claim = z.infer<typeof ClaimSchema>;
export type Source = z.infer<typeof SourceSchema>;

// --- run 内台帳（claims-ledger.json。コードが所有） ---

export const LedgerClaimSchema = ClaimFieldsSchema.extend({
  hash: z.string().regex(/^[0-9a-f]{8}$/),
  firstRound: z.number().int(),
  lastRound: z.number().int(),
}).refine(verifiedHasSource, verifiedHasSourceMsg);

export const LedgerSourceSchema = SourceSchema.extend({
  urlHash: z.string().regex(/^[0-9a-f]{8}$/),
});

export const ClaimsLedgerSchema = z.object({
  round: z.number().int().default(0),
  lastSeq: z.number().int().default(0),
  lastSourceSeq: z.number().int().default(0),
  claims: z.array(LedgerClaimSchema).default([]),
  sources: z.array(LedgerSourceSchema).default([]),
});

export type LedgerClaim = z.infer<typeof LedgerClaimSchema>;
export type LedgerSource = z.infer<typeof LedgerSourceSchema>;
export type ClaimsLedger = z.infer<typeof ClaimsLedgerSchema>;

// --- build-verify-report.json（build-verifier 出力。verify-artifacts が検証） ---

export const BuildVerifyReportSchema = z
  .object({
    status: z.enum(["passed", "failed", "partial", "skipped"]),
    skipReason: z.string().optional().default(""),
    environment: z
      .object({
        node: z.string().min(1),
        typescript: z.string().min(1).optional(),
      })
      .catchall(z.string())
      .optional(),
    checkedBlocks: z
      .array(
        z.object({
          id: z.string(),
          location: z.string().optional(),
          language: z.string().optional(),
          commands: z.array(z.string()).optional(),
          result: z.enum(["passed", "failed", "partial"]),
          notes: z.string().optional(),
        })
      )
      .default([]),
    // 検証できなかったブロック（外部API・有料依存など）。id と理由を機械可読に残す。
    unverified: z
      .array(z.object({ id: z.string(), reason: z.string(), location: z.string().optional() }))
      .default([]),
  })
  // 残リスク反映: skipped のときだけ skipReason 必須（checkedBlocks:[] でも理由が消えない）。
  .refine((r) => r.status !== "skipped" || r.skipReason.trim().length > 0, {
    message: "status 'skipped' requires a non-empty skipReason",
    path: ["skipReason"],
  })
  // 実機検証をした report は後から再現できるよう、最低限 Node 実行環境を必須にする。
  .refine((r) => r.status === "skipped" || r.environment?.node?.trim().length, {
    message: "status 'passed|failed|partial' requires environment.node",
    path: ["environment", "node"],
  })
  // passed は「全ブロック検証済みで通った」状態。未検証が残るなら partial にする（passed に混ぜない）。
  .refine((r) => r.status !== "passed" || r.unverified.length === 0, {
    message: "status 'passed' requires unverified to be empty (use 'partial' when blocks remain unverified)",
    path: ["unverified"],
  });

export type BuildVerifyReport = z.infer<typeof BuildVerifyReportSchema>;
