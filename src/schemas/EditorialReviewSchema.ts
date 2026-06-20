import { z } from "zod";

// 編集レビュー（独立モード）のモデル生出力スキーマ。
// id は付けない（パイプラインが normalize 時に WNNN-<hash8> を採番する）。spec §5.2。
export const EditorialReviewSchema = z.object({
  verdict: z.enum(["publication-candidate", "needs-revision", "rework"]),
  scores: z.array(
    z.object({
      axis: z.string(),
      score: z.number(),
    })
  ),
  strengths: z.array(z.string()),
  weaknesses: z.array(
    z.object({
      severity: z.enum(["major", "minor", "preference"]),
      location: z.string().optional(),
      problem: z.string(),
      recommendation: z.string(),
    })
  ),
  summary: z.string(),
});
