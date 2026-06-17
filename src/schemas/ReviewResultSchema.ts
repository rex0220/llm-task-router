import { z } from "zod";

export const ReviewResultSchema = z.object({
  summary: z.string(),
  issues: z.array(
    z.object({
      severity: z.enum(["critical", "major", "minor", "suggestion"]),
      location: z.string().optional(),
      problem: z.string(),
      recommendation: z.string(),
    })
  ),
  approved: z.boolean().optional(),
});
