import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProfile } from "../../src/workflows/profile";

describe("loadProfile", () => {
  it("loads the bundled qiita profile", async () => {
    const profile = await loadProfile("qiita");
    expect(profile.platform).toBe("Qiita");
    expect(profile.style).toContain(":::note");
    expect(profile.criteriaFile).toBe("config/criteria/default.md");
    expect(profile.editorialCriteriaFile).toBe("config/criteria/editorial.md");
  });

  it("loads the bundled zenn profile", async () => {
    const profile = await loadProfile("zenn");
    expect(profile.platform).toBe("Zenn");
    expect(profile.style).toContain(":::message");
  });

  it("points the note profile at its own criteria file", async () => {
    const profile = await loadProfile("note");
    expect(profile.platform).toBe("note");
    expect(profile.criteriaFile).toBe("config/criteria/note.md");
  });

  it("rejects a missing profile with a config error", async () => {
    await expect(loadProfile("does-not-exist")).rejects.toMatchObject({ kind: "config" });
  });

  it("rejects an unsafe profile name", async () => {
    await expect(loadProfile("../secret")).rejects.toMatchObject({ kind: "config" });
  });

  it("parses platform and style from a custom profile dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "profiles-"));
    await writeFile(join(dir, "custom.yaml"), "platform: Custom\nstyle: |\n  作法A\n  作法B\n", "utf8");

    const profile = await loadProfile("custom", dir);
    expect(profile.platform).toBe("Custom");
    expect(profile.style).toContain("作法A");
  });
});
