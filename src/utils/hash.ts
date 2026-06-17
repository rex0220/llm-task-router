import { createHash } from "node:crypto";

export function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
