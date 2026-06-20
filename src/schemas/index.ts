import type { SchemaName, SchemaRegistry } from "../router/types";
import { ArticleBriefSchema } from "./ArticleBriefSchema";
import { ArticleOutlineSchema } from "./ArticleOutlineSchema";
import { EditorialReviewSchema } from "./EditorialReviewSchema";
import { ReviewResultSchema } from "./ReviewResultSchema";

export const schemaRegistry: SchemaRegistry = {
  ArticleBrief: ArticleBriefSchema,
  ArticleOutline: ArticleOutlineSchema,
  ReviewResult: ReviewResultSchema,
  EditorialReview: EditorialReviewSchema,
};

// 各スキーマが要求するJSONキー仕様。プロンプト/修復依頼でモデルに提示する。
export const schemaHints: Record<SchemaName, string> = {
  ArticleBrief: `{
  "title": "string",
  "targetReaders": ["string"],
  "goal": ["string"],
  "mainClaim": "string",
  "sections": [{ "heading": "string", "points": ["string"] }],
  "codeExamples": [{ "language": "string", "purpose": "string" }]
}`,
  ArticleOutline: `{
  "title": "string",
  "introduction": "string (任意)",
  "sections": [{
    "heading": "string",
    "summary": "string (任意)",
    "points": ["string"],
    "codeExample": { "language": "string", "purpose": "string" } (任意)
  }],
  "conclusion": "string (任意)"
}`,
  ReviewResult: `{
  "summary": "string",
  "issues": [{
    "severity": "critical | major | minor | suggestion",
    "location": "string (任意)",
    "problem": "string",
    "recommendation": "string"
  }],
  "approved": "boolean (任意)"
}`,
  EditorialReview: `{
  "verdict": "publication-candidate | needs-revision | rework",
  "scores": [{ "axis": "string", "score": 0 }],
  "strengths": ["string"],
  "weaknesses": [{
    "severity": "major | minor | preference",
    "location": "string (任意)",
    "problem": "string",
    "recommendation": "string"
  }],
  "summary": "string"
}`,
};

export function hasSchema(name: string): name is SchemaName {
  return Object.prototype.hasOwnProperty.call(schemaRegistry, name);
}
