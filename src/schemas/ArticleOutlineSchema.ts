import { z } from "zod";

export const ArticleOutlineSchema = z.object({
  title: z.string(),
  introduction: z.string().optional(),
  sections: z.array(
    z.object({
      heading: z.string(),
      summary: z.string().optional(),
      points: z.array(z.string()).default([]),
      codeExample: z
        .object({
          language: z.string(),
          purpose: z.string(),
        })
        .optional(),
    })
  ),
  conclusion: z.string().optional(),
});
