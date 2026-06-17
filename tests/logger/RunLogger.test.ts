import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { RunLogger } from "../../src/logger/RunLogger";
import { RouterError } from "../../src/router/errors";
import { tmpLogPath } from "../helpers/tmp";

describe("RunLogger", () => {
  it("stores input hashes and normalized errors without full input or secrets", async () => {
    const logPath = tmpLogPath();
    const logger = new RunLogger(logPath);
    const input = "secret prompt body sk-test-secret";

    await logger.logFailure(
      { task: "draft_markdown", input },
      { provider: "openai", model: "m" },
      new RouterError("failed with sk-test-secret", "auth", 401)
    );

    const log = await readFile(logPath, "utf8");

    expect(log).toContain("sha256:");
    expect(log).toContain("\"error_kind\":\"auth\"");
    expect(log).not.toContain(input);
    expect(log).not.toContain("sk-test-secret");
  });
});
