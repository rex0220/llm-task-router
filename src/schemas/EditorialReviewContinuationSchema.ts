import { z } from "zod";

// 編集レビュー（継続モード）のモデル生出力スキーマ。spec §5.2/§5.5。
// trackedWeaknesses: 入力で渡した既知 id について解決状況を返す（id は参照のみ）。
// newWeaknesses: 今回新たに見つけた弱み（id は付けない。パイプラインが採番する）。
export const EditorialReviewContinuationSchema = z.object({
  verdict: z.enum(["publication-candidate", "needs-revision", "rework"]),
  scores: z.array(
    z.object({
      axis: z.string(),
      score: z.number(),
    })
  ),
  strengths: z.array(z.string()),
  trackedWeaknesses: z.array(
    z.object({
      id: z.string(),
      status: z.enum(["open", "partial", "resolved"]),
      evidence: z.string().optional(),
    })
  ),
  newWeaknesses: z.array(
    z.object({
      severity: z.enum(["major", "minor", "preference"]),
      location: z.string().optional(),
      problem: z.string(),
      recommendation: z.string(),
    })
  ),
  summary: z.string(),
});
