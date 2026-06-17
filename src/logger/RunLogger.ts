import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ModelCandidate, ModelRequest, ModelResponse } from "../router/types";
import { errorForLog } from "../router/errors";
import { sha256 } from "../utils/hash";

export class RunLogger {
  constructor(private readonly logPath = "runs/router.log") {}

  async logSuccess(request: ModelRequest, response: ModelResponse): Promise<void> {
    await this.append({
      at: new Date().toISOString(),
      task: request.task,
      provider: response.provider,
      model: response.model,
      status: "success",
      input_hash: sha256(request.input),
      elapsed_ms: response.elapsedMs,
      input_tokens: response.usage?.inputTokens,
      output_tokens: response.usage?.outputTokens,
      cost_usd: response.usage?.costUsd,
    });
  }

  async logFailure(request: ModelRequest, candidate: ModelCandidate, error: unknown): Promise<void> {
    const normalized = errorForLog(error);
    await this.append({
      at: new Date().toISOString(),
      task: request.task,
      provider: candidate.provider,
      model: candidate.model,
      status: "failure",
      input_hash: sha256(request.input),
      error_kind: normalized.kind,
      error_message: normalized.message,
      status_code: normalized.statusCode,
    });
  }

  private async append(entry: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.logPath), { recursive: true });
    await appendFile(this.logPath, `${JSON.stringify(withoutUndefined(entry))}\n`, "utf8");
  }
}

function withoutUndefined(entry: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined));
}
