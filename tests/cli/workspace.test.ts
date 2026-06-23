import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertArticleWorkspace } from "../../src/cli/workspace";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ltr-ws-"));
}

async function writeFileAt(dir: string, rel: string, content = ""): Promise<void> {
  const full = join(dir, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content, "utf8");
}

describe("assertArticleWorkspace", () => {
  it("passes in an initialized workspace (config/models.yaml, no source markers)", async () => {
    const cwd = tmp();
    await writeFileAt(cwd, "config/models.yaml", "tasks: {}\n");
    await expect(assertArticleWorkspace({ cwd })).resolves.toBeUndefined();
  });

  it("refuses in the source repo even though config/models.yaml exists (src/index.ts marker)", async () => {
    const cwd = tmp();
    await writeFileAt(cwd, "config/models.yaml", "tasks: {}\n");
    await writeFileAt(cwd, "src/index.ts", "// cli");
    await expect(assertArticleWorkspace({ cwd })).rejects.toThrow(/source repo/);
  });

  it("refuses in the source repo via templates/.claude marker", async () => {
    const cwd = tmp();
    await writeFileAt(cwd, "config/models.yaml", "tasks: {}\n");
    await writeFileAt(cwd, "templates/.claude/settings.json", "{}");
    await expect(assertArticleWorkspace({ cwd })).rejects.toThrow(/source repo/);
  });

  it("refuses in the source repo via the package name marker", async () => {
    const cwd = tmp();
    await writeFileAt(cwd, "config/models.yaml", "tasks: {}\n");
    await writeFileAt(cwd, "package.json", JSON.stringify({ name: "@rex0220/llm-task-router" }));
    await expect(assertArticleWorkspace({ cwd })).rejects.toThrow(/source repo/);
  });

  it("refuses in an uninitialized directory (no config/models.yaml)", async () => {
    const cwd = tmp();
    await expect(assertArticleWorkspace({ cwd })).rejects.toThrow(/Not an initialized article workspace/);
  });

  it("allows an unrelated package.json (different name) in a workspace", async () => {
    const cwd = tmp();
    await writeFileAt(cwd, "config/models.yaml", "tasks: {}\n");
    await writeFileAt(cwd, "package.json", JSON.stringify({ name: "my-articles" }));
    await expect(assertArticleWorkspace({ cwd })).resolves.toBeUndefined();
  });

  it("bypasses every check with allowOutsideWorkspace", async () => {
    const cwd = tmp();
    await writeFileAt(cwd, "src/index.ts", "// cli"); // would otherwise be flagged as source repo
    await expect(assertArticleWorkspace({ cwd, allowOutsideWorkspace: true })).resolves.toBeUndefined();
  });
});
