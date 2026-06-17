import { z } from "zod";

export const ArticleBriefSchema = z.object({
  title: z.string(),
  targetReaders: z.array(z.string()),
  goal: z.array(z.string()),
  mainClaim: z.string(),
  sections: z.array(
    z.object({
      heading: z.string(),
      points: z.array(z.string()),
    })
  ),
  codeExamples: z.array(
    z.object({
      language: z.string(),
      purpose: z.string(),
    })
  ),
});
