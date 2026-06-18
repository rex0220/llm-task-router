import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initConfig } from "../../src/cli/init";

// 同梱テンプレ（リポジトリ直下の config/ と .env.example）をソースに使う。
const sourceDir = process.cwd();

async function tmpTarget(): Promise<string> {
  return mkdtemp(join(tmpdir(), "init-target-"));
}

describe("initConfig", () => {
  it("scaffolds the config tree and .env.example into an empty target", async () => {
    const target = await tmpTarget();
    const result = await initConfig(target, sourceDir);

    expect(result.created.some((f) => f.endsWith("models.yaml"))).toBe(true);
    expect(result.created.some((f) => f.includes("profiles") && f.includes("qiita"))).toBe(true);
    expect(result.created.some((f) => f.includes("criteria") && f.includes("default"))).toBe(true);
    expect(result.created).toContain(".env.example");

    // 内容がコピーされている
    expect(await readFile(join(target, "config", "models.yaml"), "utf8")).toContain("providers");
  });

  it("scaffolds the editor-in-chief set (templates/) at the target root, prefix stripped", async () => {
    const target = await tmpTarget();
    const result = await initConfig(target, sourceDir);

    // templates/CLAUDE.md → CLAUDE.md（接頭辞が剥がれる）
    expect(result.created).toContain("CLAUDE.md");
    expect(
      result.created.some((f) => f.includes(join(".claude", "agents")) && f.includes("editor-in-chief"))
    ).toBe(true);
    expect(
      result.created.some((f) => f.includes(join(".claude", "agents")) && f.includes("factchecker"))
    ).toBe(true);

    // templates/ 接頭辞を含む形では作られない
    expect(result.created.some((f) => f.startsWith("templates"))).toBe(false);

    expect(await readFile(join(target, "CLAUDE.md"), "utf8")).toContain("article-editor-in-chief");
    expect(
      await readFile(join(target, ".claude", "agents", "article-editor-in-chief.md"), "utf8")
    ).toContain("name: article-editor-in-chief");
  });

  it("never creates a .env file", async () => {
    const target = await tmpTarget();
    const result = await initConfig(target, sourceDir);

    expect(result.created).not.toContain(".env");
    await expect(access(join(target, ".env"))).rejects.toBeTruthy();
  });

  it("skips existing files without force", async () => {
    const target = await tmpTarget();
    await mkdir(join(target, "config"), { recursive: true });
    await writeFile(join(target, "config", "models.yaml"), "MINE", "utf8");

    const result = await initConfig(target, sourceDir);

    expect(result.skipped.some((f) => f.endsWith("models.yaml"))).toBe(true);
    expect(await readFile(join(target, "config", "models.yaml"), "utf8")).toBe("MINE");
  });

  it("overwrites existing files with force", async () => {
    const target = await tmpTarget();
    await mkdir(join(target, "config"), { recursive: true });
    await writeFile(join(target, "config", "models.yaml"), "MINE", "utf8");

    const result = await initConfig(target, sourceDir, { force: true });

    expect(result.created.some((f) => f.endsWith("models.yaml"))).toBe(true);
    expect(await readFile(join(target, "config", "models.yaml"), "utf8")).toContain("providers");
  });
});
