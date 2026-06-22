import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { assertSafeInputPath, resolveText } from "../../src/cli/inputs";

describe("cli inputs", () => {
  let stderrSpy: any;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses inline text when only inline is provided", async () => {
    const text = await resolveText("hello", undefined, "topic", "--topic", "--topic-file");
    expect(text).toBe("hello");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("rejects an inline value that points at an existing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inputs-"));
    const file = join(dir, "topic.txt");
    await writeFile(file, "from file", "utf8");

    await expect(resolveText(file, undefined, "topic", "--topic", "--topic-file")).rejects.toThrow(
      /--topic looks like a file path/
    );
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("reads file content when only the file is provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inputs-"));
    const file = join(dir, "topic.txt");
    await writeFile(file, "  from file  ", "utf8");

    const text = await resolveText(undefined, file, "topic", "--topic", "--topic-file");
    expect(text).toBe("from file");

    expect(stderrSpy).toHaveBeenCalled();
    const calls = stderrSpy.mock.calls.map((c: any) => c[0]).join("");
    expect(calls).toContain("Warning: reading a file outside the workspace");
  });

  it("rejects when both inline and file are provided", async () => {
    await expect(resolveText("a", "b.txt", "topic", "--topic", "--topic-file")).rejects.toThrow(
      /only one of --topic or --topic-file/
    );
  });

  it("rejects when neither is provided", async () => {
    await expect(resolveText(undefined, undefined, "topic", "--topic", "--topic-file")).rejects.toThrow(
      /Provide topic/
    );
  });

  it("rejects an empty file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inputs-"));
    const file = join(dir, "empty.txt");
    await writeFile(file, "   \n", "utf8");

    await expect(resolveText(undefined, file, "topic", "--topic", "--topic-file")).rejects.toThrow(/is empty/);

    expect(stderrSpy).toHaveBeenCalled();
    const calls = stderrSpy.mock.calls.map((c: any) => c[0]).join("");
    expect(calls).toContain("Warning: reading a file outside the workspace");
  });

  it("refuses to read secret env files regardless of case", () => {
    expect(() => assertSafeInputPath(".env")).toThrow(/secret file/);
    expect(() => assertSafeInputPath("config/.env.local")).toThrow(/secret file/);
    expect(() => assertSafeInputPath(".ENV")).toThrow(/secret file/);
    expect(() => assertSafeInputPath("config/.Env.local")).toThrow(/secret file/);
  });
});
