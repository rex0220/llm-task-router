import type { RunStore } from "../storage/RunStore";
import { BuildVerifyReportSchema, ClaimsSchema } from "../schemas/ClaimsSchema";
import { CLAIMS_FILE, isBlocking } from "./claimsNormalize";

// 公開前ゲート: 成果物の揃い・スキーマ・blocking を機械的にチェックする（外部通信なし）。
// 各検証の中身は再判定しない（factcheck/build/editorial の判断は各担当に委ねる）。
// docs/claude-editor-improvement-spec.md #5 / docs/claims-schema-notes.md。

export type VerifyArtifactsResult = {
  runId: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
};

type GateState = "done" | "skipped" | "missing";

async function readOrNull(store: RunStore, runId: string, file: string): Promise<string | null> {
  return store.read(runId, file).then(
    (c) => c,
    () => null
  );
}

function gateState(publicationCheck: string, gate: string): GateState {
  const m = new RegExp(`^-\\s*${gate}:\\s*(done|skipped)\\b`, "im").exec(publicationCheck);
  if (!m) {
    return "missing";
  }
  return m[1].toLowerCase() === "done" ? "done" : "skipped";
}

export async function verifyArtifacts(store: RunStore, runId: string): Promise<VerifyArtifactsResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const final = await readOrNull(store, runId, "final.md");
  if (final === null) {
    errors.push("final.md が存在しません。");
  }
  if ((await readOrNull(store, runId, "final-review.md")) === null) {
    errors.push("final-review.md が存在しません。");
  }

  const publicationCheck = await readOrNull(store, runId, "publication-check.md");
  if (publicationCheck === null) {
    errors.push("publication-check.md が存在しません（編集長が GO/NO-GO 前に作成する）。");
  } else {
    const go = /^-\s*GO\/NO-GO:\s*(\S.*)$/im.exec(publicationCheck);
    if (!go) {
      errors.push("publication-check.md に GO/NO-GO の記載がありません。");
    }
  }

  const pc = publicationCheck ?? "";

  // --- factcheck ゲート ---
  const factcheck = gateState(pc, "factcheck");
  const factcheckInstruction = await readOrNull(store, runId, "factcheck-instruction.md");
  const claimsRaw = await readOrNull(store, runId, CLAIMS_FILE);
  if (factcheck === "missing") {
    errors.push("publication-check.md に factcheck ゲート（done/skipped）の記載がありません。");
  } else if (factcheck === "done" && factcheckInstruction === null && claimsRaw === null) {
    errors.push("factcheck=done ですが factcheck-instruction.md も claims.json もありません。");
  }

  // --- build-verify ゲート ---
  const buildVerify = gateState(pc, "build-verify");
  const reportRaw = await readOrNull(store, runId, "build-verify-report.json");
  if (reportRaw !== null) {
    const parsed = BuildVerifyReportSchema.safeParse(safeJson(reportRaw));
    if (!parsed.success) {
      errors.push(`build-verify-report.json がスキーマ不適合: ${formatIssues(parsed.error)}`);
    } else if (parsed.data.status === "skipped") {
      warnings.push("build-verify-report.json は status=skipped です（コードを含む記事なら要確認）。");
    }
  } else if (buildVerify === "missing") {
    errors.push("publication-check.md に build-verify ゲート（done/skipped）の記載がありません。");
  } else if (buildVerify === "done") {
    errors.push("build-verify=done ですが build-verify-report.json がありません。");
  }

  // --- editorial-review ゲート ---
  const editorial = gateState(pc, "editorial-review");
  const editorialReview = await readOrNull(store, runId, "editorial-review.md");
  if (editorial === "missing") {
    errors.push("publication-check.md に editorial-review ゲート（done/skipped）の記載がありません。");
  } else if (editorial === "done" && editorialReview === null) {
    errors.push("editorial-review=done ですが editorial-review.md がありません。");
  }

  // --- claims.json（あれば）スキーマ適合 + blocking ゼロ ---
  if (claimsRaw !== null) {
    const parsed = ClaimsSchema.safeParse(safeJson(claimsRaw));
    if (!parsed.success) {
      errors.push(`claims.json がスキーマ不適合: ${formatIssues(parsed.error)}`);
    } else {
      const blocking = parsed.data.filter(isBlocking);
      if (blocking.length > 0) {
        errors.push(
          `claims.json に blocking な claim が ${blocking.length} 件残っています: ${blocking
            .map((c) => `${c.id}(${c.severity}/${c.status})`)
            .join(", ")}`
        );
      }
    }
  }

  return { runId, ok: errors.length === 0, errors, warnings };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function formatIssues(error: { issues: { path: (string | number)[]; message: string }[] }): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
