import { z } from "zod";

export const ArticleBriefSchema = z.object({
  title: z.string(),
  // 投稿プラットフォーム向けタグ（Qiita は 1〜5 個・スペース不可）。3〜5 個を想定。
  tags: z.array(z.string()),
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
