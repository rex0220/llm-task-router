import { RouterError } from "../router/errors";

export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const extracted = extractJsonCandidate(trimmed);
    if (!extracted) {
      throw new RouterError("Model output was not valid JSON", "schema_validation");
    }

    try {
      return JSON.parse(extracted);
    } catch {
      throw new RouterError("Model output JSON could not be parsed", "schema_validation");
    }
  }
}

export function extractJsonCandidate(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const firstObject = text.indexOf("{");
  const lastObject = text.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) {
    return text.slice(firstObject, lastObject + 1);
  }

  const firstArray = text.indexOf("[");
  const lastArray = text.lastIndexOf("]");
  if (firstArray >= 0 && lastArray > firstArray) {
    return text.slice(firstArray, lastArray + 1);
  }

  return undefined;
}
