import type { RunStore } from "../storage/RunStore";
import { BuildVerifyReportSchema, ClaimsSchema, SourcesSchema } from "../schemas/ClaimsSchema";
import { CLAIMS_FILE, SOURCES_FILE, isBlocking, canonicalUrl, collectCitedSourceIds } from "./claimsNormalize";
import { gateState, hasSkipReason, parseGoNoGo } from "./publicationCheck";
import { SOURCES_BEGIN, SOURCES_END } from "./references";
import { RunProgress } from "../progress/RunProgress";
import { aggregate } from "../progress/aggregate";
import { collectUnsettledWeaknesses } from "../workflows/editorialReview";
import { strongEmphasisWarnings } from "../utils/text";

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

async function readOrNull(store: RunStore, runId: string, file: string): Promise<string | null> {
  return store.read(runId, file).then(
    (c) => c,
    () => null
  );
}

export async function verifyArtifacts(store: RunStore, runId: string): Promise<VerifyArtifactsResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const finalMd = await readOrNull(store, runId, "final.md");
  if (finalMd === null) {
    errors.push("final.md が存在しません。");
  } else {
    // Phase 2（非ブロック）: 強調 **…** のレンダリング不備を warning で可視化する。
    // error 化（公開ブロック）は Phase 3。検出ロジックは src/utils/text.ts。
    warnings.push(...strongEmphasisWarnings(finalMd, { label: "final.md" }));
  }
  if ((await readOrNull(store, runId, "final-review.md")) === null) {
    errors.push("final-review.md が存在しません。");
  }

  const publicationCheck = await readOrNull(store, runId, "publication-check.md");
  if (publicationCheck === null) {
    errors.push("publication-check.md が存在しません（編集長が GO/NO-GO 前に作成する）。");
  } else if (parseGoNoGo(publicationCheck) === undefined) {
    // 共通パーサに寄せる（旧 regex の \s* は改行を食い、空欄 GO/NO-GO を「記載あり」と誤判定した）。
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
  // 構文/型チェックは既定オフ。作成時に --code-check 非指定（codeCheck===false）の run は build-verify を
  // 「対象外」とし、publication-check のゲート宣言を必須にしない。これは silent skip ではなく、create で
  // first-write-wins 固定された監査済みの宣言（progress.md / completion-report に「対象外」と出る）。
  // codeCheck が未刻印（undefined＝旧 run）や true のときは従来どおり done|skipped の宣言を要求する。
  // ※ 手動で build-verify-report.json を残した場合は、下のブロックで宣言と独立に成否・整合性を検査する。
  const events = await new RunProgress(store).readEvents(runId).catch(() => []);
  const codeCheckOptedOut = aggregate(runId, events).codeCheck === false;
  if (!codeCheckOptedOut) {
    checkGate(pc, "build-verify", errors, {
      done: () => {
        if (reportRaw === null) {
          errors.push("build-verify=done ですが build-verify-report.json がありません。");
        }
      },
    });
  }
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
      // done かつ passed なのに検証ブロックが空＝実際には何も検証していない passed を防ぐ。
      if (buildVerify === "done" && report.status === "passed" && report.checkedBlocks.length === 0) {
        errors.push("build-verify=done かつ status=passed ですが checkedBlocks が空です（実際に検証したブロックがありません）。");
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
  // checkGate の done は同期コールバックのため、台帳集計は事前に await して渡す。
  // skip 宣言の run は done 経路に入らない＝台帳なしでも素通り（既存の skip 運用を壊さない）。
  const editorialGate = await collectUnsettledWeaknesses(store, runId);
  checkGate(pc, "editorial-review", errors, {
    done: () => {
      if (editorialReview === null) {
        errors.push("editorial-review=done ですが editorial-review.md がありません。");
        return;
      }
      // editorial-review=done を宣言した以上、採否を記録する台帳も必須にする。
      if (!editorialGate.hasLedger) {
        errors.push("editorial-review=done ですが editorial-ledger.json がありません。");
        return;
      }
      // major/minor の未確定（未解決 or 上申中）は公開ブロック。preference は warning のみ。
      const blocking = [...editorialGate.major, ...editorialGate.minor];
      if (blocking.length > 0) {
        const list = blocking.map((w) => `${w.id}(${w.severity}/${w.reason})`).join(", ");
        errors.push(
          `editorial-ledger に未確定の weakness が ${blocking.length} 件あります` +
            `（unresolved は article:editorial-resolve で採否を、escalated はユーザー承認後に` +
            ` --resolution user-approved で確定してください）: ${list}`
        );
      }
      if (editorialGate.preference.length > 0) {
        warnings.push(
          `editorial-ledger に未確定の preference が ${editorialGate.preference.length} 件あります（任意・waived 推奨）。`
        );
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

  // 参考章のリンク検査（過剰にしない）:
  // - 参考マーカーブロック内のリンクは sources.json と完全一致を必須（偽 URL を弾く）。
  // - ブロック外の本文リンクで sources.json に無いものは warning（GitHub・公式 doc・画像等の正当リンクを壊さない）。
  await checkReferenceLinks(store, runId, errors, warnings);

  // sources の到達性／差し替え／cited 焼き込みの整合性（read-only・外部通信なし）。
  await checkSourceMeta(store, runId, errors);

  return { runId, ok: errors.length === 0, errors, warnings };
}

const URL_RE = /https?:\/\/[^\s)<>"'`\]]+/g;

function normalizeForCompare(url: string): string | null {
  try {
    return canonicalUrl(url.replace(/[.,;]+$/, "")); // 末尾句読点を除いて正規化
  } catch {
    return null;
  }
}

async function checkReferenceLinks(
  store: RunStore,
  runId: string,
  errors: string[],
  warnings: string[]
): Promise<void> {
  const final = await readOrNull(store, runId, "final.md");
  const sourcesJson = await readOrNull(store, runId, SOURCES_FILE);
  if (final === null || sourcesJson === null) {
    return; // final/sources が無ければリンク検査はスキップ（他チェックが別途扱う）
  }
  const sources = SourcesSchema.safeParse(safeJson(sourcesJson));
  if (!sources.success) {
    return; // sources スキーマ不適合は上で別途 error 済み
  }
  const known = new Set<string>();
  const deadByUrl = new Set<string>(); // 正規化 URL → reachable:"dead" な source の URL
  for (const s of sources.data) {
    const n = normalizeForCompare(s.url);
    if (n) {
      known.add(n);
      if (s.reachable === "dead") {
        deadByUrl.add(n);
      }
    }
  }

  // 参考マーカーブロックの範囲を特定（あれば）。
  // article:references と同じく「begin/end がちょうど1組・正順」のみ正常。片方欠落・複数・逆順は
  // 破損として error（warning 止まりだと偽 URL を見逃すため。生成側のガードと対称にする）。
  const bCount = final.split(SOURCES_BEGIN).length - 1;
  const eCount = final.split(SOURCES_END).length - 1;
  const bIdx = final.indexOf(SOURCES_BEGIN);
  const eIdx = final.indexOf(SOURCES_END);
  const wellFormed = bCount === 1 && eCount === 1 && bIdx < eIdx;
  if ((bCount > 0 || eCount > 0) && !wellFormed) {
    errors.push(
      "参考ブロックのマーカーが壊れています（begin/end が1組・正順ではありません）。手でマーカーを修復してから article:references を再実行してください。"
    );
    return; // 破損時はリンク分類しない（偽判定を避ける）
  }
  const hasBlock = wellFormed;
  const inBlock = (pos: number): boolean => hasBlock && pos >= bIdx && pos < eIdx + SOURCES_END.length;

  const blockMissing = new Set<string>();
  const blockDead = new Set<string>();
  const bodyUnknown = new Set<string>();
  for (const m of final.matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,;]+$/, "");
    const norm = normalizeForCompare(raw);
    if (norm === null) {
      continue;
    }
    if (inBlock(m.index ?? 0)) {
      if (!known.has(norm)) {
        blockMissing.add(raw);
      } else if (deadByUrl.has(norm)) {
        blockDead.add(raw);
      }
    } else if (!known.has(norm)) {
      bodyUnknown.add(raw);
    }
  }

  if (blockMissing.size > 0) {
    errors.push(
      `参考ブロック内に sources.json に無いリンクがあります（偽/未登録 URL）: ${[...blockMissing].join(", ")}`
    );
  }
  if (blockDead.size > 0) {
    errors.push(
      `参考ブロック内に reachable=dead の source へのリンクがあります（死リンクを公開しない）: ${[...blockDead].join(", ")}`
    );
  }
  if (bodyUnknown.size > 0) {
    warnings.push(
      `本文（参考ブロック外）に sources.json 未登録のリンクがあります（出典なら参考章へ）: ${[...bodyUnknown].join(", ")}`
    );
  }
}

// sources の到達性／差し替え／cited 焼き込みの整合性（read-only・外部通信しない）。
// メタ無し（旧 run）は新エラーを出さない: dead/replacedBy が明示されたとき・cited 不一致時のみ発火。
async function checkSourceMeta(store: RunStore, runId: string, errors: string[]): Promise<void> {
  const claimsJson = await readOrNull(store, runId, CLAIMS_FILE);
  const sourcesJson = await readOrNull(store, runId, SOURCES_FILE);
  if (claimsJson === null || sourcesJson === null) {
    return; // 不在は他チェックが扱う
  }
  const claims = ClaimsSchema.safeParse(safeJson(claimsJson));
  const sources = SourcesSchema.safeParse(safeJson(sourcesJson));
  if (!claims.success || !sources.success) {
    return; // スキーマ不適合は上で別途 error 済み
  }

  const ids = new Set(sources.data.map((s) => s.id));
  // cited の正本は claims（焼き込み値ではなく再導出を使う）。
  const derived = collectCitedSourceIds(claims.data);

  // 1. claims が引用しているのに dead（死リンクを引用している台帳不整合）。
  // 焼き込み cited(optional) ではなく claims 再導出で判定する（cited 未 materialize でも検出する）。
  const deadCited = sources.data.filter((s) => derived.has(s.id) && s.reachable === "dead").map((s) => s.id);
  if (deadCited.length > 0) {
    errors.push(
      `claims が引用しているのに reachable=dead の source があります（claim を到達可能な代替へ張り替えてください）: ${deadCited.join(", ")}`
    );
  }

  // 2. replacedBy の自己参照 / dangling。
  for (const s of sources.data) {
    if (s.replacedBy === undefined) {
      continue;
    }
    if (s.replacedBy === s.id) {
      errors.push(`source ${s.id} の replacedBy が自己参照です。`);
    } else if (!ids.has(s.replacedBy)) {
      errors.push(`source ${s.id} の replacedBy=${s.replacedBy} が sources.json に存在しません（dangling）。`);
    }
  }

  // 3. cited 焼き込みと claims 再導出の一致（cited を正本扱いしない担保／焼き込みの手編集 drift 検出）。
  // cited が materialize された新 run のみ検査（旧 run は cited 未記録なので対象外＝back-compat）。
  const materialized = sources.data.some((s) => s.cited !== undefined);
  if (materialized) {
    const mismatched = sources.data.filter((s) => (s.cited ?? false) !== derived.has(s.id)).map((s) => s.id);
    if (mismatched.length > 0) {
      errors.push(
        `sources.json の cited が claims から再導出した集合と不一致です（article:claims-normalize を再実行してください）: ${mismatched.join(", ")}`
      );
    }
  }
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
