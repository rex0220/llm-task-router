import type { RunStore } from "../storage/RunStore";
import { BuildVerifyReportSchema, ClaimsSchema, SourcesSchema } from "../schemas/ClaimsSchema";
import { CLAIMS_FILE, SOURCES_FILE, isBlocking } from "./claimsNormalize";

// 公開前ゲート: 成果物の揃い・スキーマ・blocking を機械的にチェックする（外部通信なし）。
// 各検証の中身は再判定しない（factcheck/build/editorial の判断は各担当に委ねる）。
// docs/claude-editor-improvement-spec.md #5 / docs/claims-schema-notes.md。
//
// no silent skip: 各ゲートは publication-check.md で done|skipped を必ず宣言する。
// - done なら成果物（claims.json / build-verify-report.json / editorial-review.md）を必須にする。
// - skipped なら publication-check.md 側の "<gate> summary:"（スキップ理由）を必須にする（P4 の skipReason と揃える）。

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

// skipped ゲートのスキップ理由（publication-check の "<gate> summary:" 行）が埋まっているか。
function hasSkipReason(publicationCheck: string, gate: string): boolean {
  const m = new RegExp(`^-\\s*${gate} summary:\\s*(\\S.*)$`, "im").exec(publicationCheck);
  return m !== null;
}

export async function verifyArtifacts(store: RunStore, runId: string): Promise<VerifyArtifactsResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if ((await readOrNull(store, runId, "final.md")) === null) {
    errors.push("final.md が存在しません。");
  }
  if ((await readOrNull(store, runId, "final-review.md")) === null) {
    errors.push("final-review.md が存在しません。");
  }

  const publicationCheck = await readOrNull(store, runId, "publication-check.md");
  if (publicationCheck === null) {
    errors.push("publication-check.md が存在しません（編集長が GO/NO-GO 前に作成する）。");
  } else if (!/^-\s*GO\/NO-GO:\s*\S.*$/im.test(publicationCheck)) {
    errors.push("publication-check.md に GO/NO-GO の記載がありません。");
  }

  const pc = publicationCheck ?? "";

  // 各ゲートは report 等の有無と独立に「宣言（done/skipped）」を必須にする。
  const claimsJson = await readOrNull(store, runId, CLAIMS_FILE);
  checkGate(pc, "factcheck", errors, {
    done: () => {
      if (claimsJson === null) {
        errors.push("factcheck=done ですが normalized claims.json がありません（article:claims-normalize を実行）。");
      }
    },
  });

  const buildVerify = gateState(pc, "build-verify");
  const reportRaw = await readOrNull(store, runId, "build-verify-report.json");
  checkGate(pc, "build-verify", errors, {
    done: () => {
      if (reportRaw === null) {
        errors.push("build-verify=done ですが build-verify-report.json がありません。");
      }
    },
  });
  // report があれば宣言と独立にスキーマ検証 + 実機検証の成否・整合性を見る。
  if (reportRaw !== null) {
    const parsed = BuildVerifyReportSchema.safeParse(safeJson(reportRaw));
    if (!parsed.success) {
      errors.push(`build-verify-report.json がスキーマ不適合: ${formatIssues(parsed.error)}`);
    } else {
      const report = parsed.data;
      // ブロック単位の失敗/部分成功は機械可読な「落ちた」なので通さない。
      const badBlocks = report.checkedBlocks.filter((b) => b.result === "failed" || b.result === "partial");
      if (badBlocks.length > 0) {
        errors.push(
          `build-verify-report.json に失敗/部分成功のブロックが残っています: ${badBlocks
            .map((b) => `${b.id}(${b.result})`)
            .join(", ")}`
        );
      }
      // report 全体の status が落ちていれば error（LLM の要約判断に戻さない）。
      if (report.status === "failed" || report.status === "partial") {
        errors.push(`build-verify-report.json が status=${report.status} です（実機検証が通っていません）。`);
      }
      // 宣言と report status の整合性。
      if (buildVerify === "done" && report.status === "skipped") {
        errors.push("build-verify=done ですが build-verify-report.json は status=skipped（宣言と不整合）。");
      }
      if (buildVerify === "skipped" && report.status !== "skipped") {
        errors.push(`build-verify=skipped ですが build-verify-report.json は status=${report.status}（宣言と不整合）。`);
      }
      if (report.status === "skipped" && buildVerify !== "done") {
        warnings.push("build-verify-report.json は status=skipped です（コードを含む記事なら要確認）。");
      }
    }
  }

  const editorialReview = await readOrNull(store, runId, "editorial-review.md");
  checkGate(pc, "editorial-review", errors, {
    done: () => {
      if (editorialReview === null) {
        errors.push("editorial-review=done ですが editorial-review.md がありません。");
      }
    },
  });

  // claims.json があればスキーマ適合 + blocking ゼロ + 出典 integrity を検査する
  // （factcheck=done では claims.json 必須なので必ず通る）。
  if (claimsJson !== null) {
    const parsed = ClaimsSchema.safeParse(safeJson(claimsJson));
    if (!parsed.success) {
      // verified かつ sourceIds 空などはここで弾かれる（ClaimSchema の refine）。
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

      // sources.json の存在・スキーマ・参照 integrity（claims[].sourceIds が実在するか）。
      const sourcesJson = await readOrNull(store, runId, SOURCES_FILE);
      if (sourcesJson === null) {
        errors.push("claims.json があるのに sources.json がありません（article:claims-normalize を実行）。");
      } else {
        const sources = SourcesSchema.safeParse(safeJson(sourcesJson));
        if (!sources.success) {
          errors.push(`sources.json がスキーマ不適合: ${formatIssues(sources.error)}`);
        } else {
          const sourceIds = new Set(sources.data.map((s) => s.id));
          const dangling = new Set<string>();
          for (const c of parsed.data) {
            for (const sid of c.sourceIds) {
              if (!sourceIds.has(sid)) {
                dangling.add(`${c.id}->${sid}`);
              }
            }
          }
          if (dangling.size > 0) {
            errors.push(`claims.json の sourceId が sources.json に存在しません: ${[...dangling].join(", ")}`);
          }
        }
      }
    }
  }

  return { runId, ok: errors.length === 0, errors, warnings };
}

// ゲート宣言の検査を共通化する: missing は常に error、done は成果物検査、skipped は理由必須。
function checkGate(
  pc: string,
  gate: string,
  errors: string[],
  handlers: { done: () => void }
): void {
  const state = gateState(pc, gate);
  if (state === "missing") {
    errors.push(`publication-check.md に ${gate} ゲート（done/skipped）の記載がありません。`);
    return;
  }
  if (state === "done") {
    handlers.done();
    return;
  }
  // skipped
  if (!hasSkipReason(pc, gate)) {
    errors.push(`${gate}=skipped ですが publication-check.md に "${gate} summary"（スキップ理由）がありません。`);
  }
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
