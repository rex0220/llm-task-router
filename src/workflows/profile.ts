import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { RouterError } from "../router/errors";

export type ArticleProfile = {
  platform: string;
  language?: string;
  style?: string;
  criteriaFile?: string;
  // 編集レビュー専用の固定 rubric（criteria_file とは別系統。brushup-criteria に上書きされない）。
  editorialCriteriaFile?: string;
};

const profileSchema = z.object({
  platform: z.string().min(1),
  language: z.string().optional(),
  style: z.string().optional(),
  criteria_file: z.string().optional(),
  editorial_criteria_file: z.string().optional(),
});

// プロファイル名から config/profiles/<name>.yaml を読み込む。
// name はファイル名のみ許可（パストラバーサル防止）。
export async function loadProfile(name: string, dir = "config/profiles"): Promise<ArticleProfile> {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes("..")) {
    throw new RouterError(`Invalid profile name: ${name}`, "config");
  }

  const path = join(dir, `${basename(name)}.yaml`);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new RouterError(`Profile not found: ${name} (expected ${path})`, "config");
  }

  const parsed = profileSchema.safeParse(parse(raw));
  if (!parsed.success) {
    throw new RouterError(`Invalid profile ${name}: ${parsed.error.message}`, "config");
  }

  return {
    platform: parsed.data.platform,
    language: parsed.data.language,
    style: parsed.data.style?.trim() || undefined,
    criteriaFile: parsed.data.criteria_file?.trim() || undefined,
    editorialCriteriaFile: parsed.data.editorial_criteria_file?.trim() || undefined,
  };
}
