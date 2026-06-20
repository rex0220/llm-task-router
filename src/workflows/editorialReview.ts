import { createHash } from "node:crypto";
import { ModelRouter } from "../router/ModelRouter";
import type { ModelCandidate } from "../router/types";
import type { ModelStamp, RunStore } from "../storage/RunStore";
import { DEFAULT_PLATFORM } from "./qiitaSteps";

// editorial-review-spec §5.2 のスキーマ（raw 独立モード。weakness に id は無い）。
type WeaknessSeverity = "major" | "minor" | "preference";
type WeaknessStatus = "open" | "partial" | "resolved";

type RawWeakness = {
  severity: WeaknessSeverity;
  location?: string;
  problem: string;
  recommendation: string;
};

type RawEditorialReview = {
  verdict: "publication-candidate" | "needs-revision" | "rework";
  scores: { axis: string; score: number }[];
  strengths: string[];
  weaknesses: RawWeakness[];
  summary: string;
};

export type NormalizedWeakness = RawWeakness & { id: string; status: WeaknessStatus };
export type NormalizedEditorialReview = Omit<RawEditorialReview, "weaknesses"> & {
  weaknesses: NormalizedWeakness[];
};

export type EditorialReviewOptions = {
  allowSameProvider?: boolean;
  allowSameModel?: boolean;
  criteria?: string; // 編集 rubric（固定）＋追加コンテキストの合成済みテキスト
};

export type EditorialReviewResult = {
  runId: string;
  reviewerModel: ModelStamp;
  verdict: string;
  candidateCount: number; // editorial-instruction.candidates.md に入った件数（major|minor かつ open|partial）
};

// finalAuthorModel と override から、候補除外のパラメータを決める（spec §5.1）。
function computeExclusions(
  finalAuthor: ModelStamp,
  options: EditorialReviewOptions
): { excludeProviders?: string[]; excludeCandidates?: ModelCandidate[] } {
  if (options.allowSameModel) {
    return {}; // 完全同一まで許可
  }
  if (options.allowSameProvider) {
    // 同 provider の別 model は使うが、完全同一 model だけ落として次候補へ進む。
    return { excludeCandidates: [{ provider: finalAuthor.provider, model: finalAuthor.model }] };
  }
  return { excludeProviders: [finalAuthor.provider] };
}

// 実応答が override レベルの許可範囲かを再チェック（事前 filter の安全網）。
function assertIndependentResponse(
  finalAuthor: ModelStamp,
  reviewer: ModelStamp,
  options: EditorialReviewOptions
): void {
  if (options.allowSameModel) {
    return;
  }
  const sameProvider = reviewer.provider === finalAuthor.provider;
  const sameModel = sameProvider && reviewer.model === finalAuthor.model;
  if (options.allowSameProvider) {
    if (sameModel) {
      throw new Error(
        `Editorial reviewer (${reviewer.provider}/${reviewer.model}) is the exact final-author model; independence violated`
      );
    }
    return;
  }
  if (sameProvider) {
    throw new Error(
      `Editorial reviewer provider (${reviewer.provider}) matches the final author; pass --allow-same-provider to override`
    );
  }
}

const HASH_LEN = 8;

// weakness の内容ハッシュ（同じ指摘の再出現照合に使う）。spec §8-3。
function weaknessHash(w: RawWeakness): string {
  const norm = [w.severity, w.location ?? "", w.problem, w.recommendation]
    .map((s) => s.replace(/\s+/g, " ").trim())
    .join("|");
  return createHash("sha256").update(norm).digest("hex").slice(0, HASH_LEN);
}

// raw → normalized（新規 weakness に WNNN-<hash8> 採番＋status:"open" 起票）。
// 独立モードは毎回まっさらなので連番は 1 起点（継続モードの台帳は WS7）。
function normalize(raw: RawEditorialReview): NormalizedEditorialReview {
  const weaknesses: NormalizedWeakness[] = raw.weaknesses.map((w, i) => ({
    ...w,
    id: `W${String(i + 1).padStart(3, "0")}-${weaknessHash(w)}`,
    status: "open" as const,
  }));
  return { ...raw, weaknesses };
}

const SEVERITY_ORDER: WeaknessSeverity[] = ["major", "minor", "preference"];

function buildSummary(review: NormalizedEditorialReview): string {
  const lines = [
    "# 編集レビュー",
    "",
    `- 判定(verdict): ${review.verdict}`,
    "",
    "## スコア",
    "",
    "| 軸 | スコア |",
    "| --- | --- |",
    ...review.scores.map((s) => `| ${s.axis} | ${s.score} |`),
    "",
    "## 強み",
    "",
    ...(review.strengths.length ? review.strengths.map((s) => `- ${s}`) : ["（なし）"]),
    "",
    "## 弱み",
    "",
  ];
  for (const sev of SEVERITY_ORDER) {
    const items = review.weaknesses.filter((w) => w.severity === sev);
    if (items.length === 0) {
      continue;
    }
    lines.push(`### ${sev}${sev === "preference" ? "（好みレベル・自動適用しない）" : ""}`);
    for (const w of items) {
      const loc = w.location ? `（${w.location}）` : "";
      lines.push(`- [${w.id}] **${w.problem}**${loc}`);
      lines.push(`  - 推奨: ${w.recommendation}`);
    }
    lines.push("");
  }
  lines.push("## 総評", "", review.summary, "");
  return lines.join("\n");
}

// ② 候補ファイル（editorial-instruction.candidates.md）。severity major|minor かつ status open|partial のみ。
// preference・resolved は除外。これは「候補」であり③編集長が確定するまで適用しない。
function buildCandidates(review: NormalizedEditorialReview): { text: string; count: number } {
  const applicable = review.weaknesses.filter(
    (w) => (w.severity === "major" || w.severity === "minor") && (w.status === "open" || w.status === "partial")
  );
  const lines = [
    "# 編集レビュー 修正候補（②機械フィルタ / 未確定）",
    "",
    "> これは候補です。③編集長が取捨して `editorial-instruction.md` に確定したものだけを `article:revise` で適用します。",
    "> preference と resolved は除外済み。",
    "",
  ];
  for (const sev of ["major", "minor"] as const) {
    const items = applicable.filter((w) => w.severity === sev);
    if (items.length === 0) {
      continue;
    }
    lines.push(`## ${sev}`);
    for (const w of items) {
      const loc = w.location ? `（${w.location}）` : "";
      lines.push(`- [${w.id}] 問題${loc}: ${w.problem}`);
      lines.push(`  - 推奨: ${w.recommendation}`);
    }
    lines.push("");
  }
  if (applicable.length === 0) {
    lines.push("（適用候補はありません）", "");
  }
  return { text: lines.join("\n"), count: applicable.length };
}

function buildInput(platform: string, final: string, criteria?: string): string {
  return [
    `次の${platform}記事を、読者・編集視点でレビューしてください。`,
    "内容の事実正誤の確定はしないでください（それは別系統のファクトチェックの担当）。構成・読みやすさ・専門性の届き方を評価します。",
    "weakness に id は付けないでください（id は後段で採番します）。",
    ...(criteria ? ["", "評価観点:", criteria] : []),
    "",
    "記事:",
    final,
  ].join("\n");
}

// 編集レビュー（独立モード）。spec §5.1/§5.2/§5.4。
export async function runEditorialReview(
  router: ModelRouter,
  store: RunStore,
  runId: string,
  options: EditorialReviewOptions = {}
): Promise<EditorialReviewResult> {
  const meta = await store.readMeta(runId);
  const platform = meta.platform ?? DEFAULT_PLATFORM;
  const final = await store.read(runId, "final.md");

  // 独立性の前提を解決（spec §5.1）。
  const finalAuthor = meta.finalAuthorModel;
  const exempt = finalAuthor === "external" || meta.imported === true;
  if (!exempt && !finalAuthor) {
    throw new Error(
      `Run ${runId} の finalAuthorModel が未記録です。一度 article:revise で final.md を改稿（または article:review で再生成）して記録してから editorial review を回してください。（article:resume は完了 step をスキップするため記録されません）`
    );
  }
  // exempt が false なら finalAuthor は "external" ではない（ModelStamp）と TS も推論する。
  const exclusions = exempt || !finalAuthor ? {} : computeExclusions(finalAuthor, options);

  const response = await router.run({
    task: "editorial_review",
    input: buildInput(platform, final, options.criteria),
    schemaName: "EditorialReview",
    ...exclusions,
  });
  const reviewerModel: ModelStamp = { provider: response.provider, model: response.model };
  await store.setReviewerModel(runId, reviewerModel);

  // 実応答の独立性 recheck（免除でなければ。!exempt なら finalAuthor は ModelStamp）。
  if (!exempt && finalAuthor) {
    assertIndependentResponse(finalAuthor, reviewerModel, options);
  }

  const raw = JSON.parse(response.text) as RawEditorialReview;
  const normalized = normalize(raw);

  await store.save(runId, "editorial-review.json", JSON.stringify(normalized, null, 2));
  await store.save(runId, "editorial-review.md", buildSummary(normalized));
  const candidates = buildCandidates(normalized);
  await store.save(runId, "editorial-instruction.candidates.md", candidates.text);

  return {
    runId,
    reviewerModel,
    verdict: normalized.verdict,
    candidateCount: candidates.count,
  };
}
