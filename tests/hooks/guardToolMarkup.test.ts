import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// テンプレート同梱の UserPromptSubmit フック（init で配布される実体）の判定ロジックを直接検証する。
// @ts-expect-error: untyped .mjs asset imported for runtime-logic verification
import { containsLeakedToolMarkup, GUIDANCE } from "../../templates/.claude/hooks/guard-tool-markup.mjs";

// fixture 方針（汚染を持ち込まない）: 連続した生シグネチャをソースに直書きせず、実行時に連結して組み立てる。
// こうすると本テストのソースを grep しても `<` + invoke + name=... の連続形がヒットしない。
const LT = "<";
const GT = ">";
function buildLeaked(): string {
  return [
    "前のセッションからの貼り付け:",
    LT + 'invoke name="Bash"' + GT,
    LT + 'parameter name="command"' + GT + "echo hi" + LT + "/parameter" + GT,
    LT + "/invoke" + GT,
    "（ここまで）",
  ].join("\n");
}

describe("guard-tool-markup hook: containsLeakedToolMarkup", () => {
  it("detects a leaked invoke+parameter signature", () => {
    expect(containsLeakedToolMarkup(buildLeaked())).toBe(true);
  });

  it("does not fire on bare tag-name mentions (言及は許容)", () => {
    expect(containsLeakedToolMarkup("invoke と parameter のタグについて説明する")).toBe(false);
    expect(containsLeakedToolMarkup("`invoke` / `parameter` の生マークアップを再掲しない")).toBe(false);
    // 属性なしの素タグ単独も発火しない（name 属性つきの開きタグが両方必要）。
    expect(containsLeakedToolMarkup(LT + "invoke" + GT)).toBe(false);
  });

  it("requires BOTH invoke-open and parameter-open with name attribute", () => {
    // invoke だけ（parameter 無し）→ 発火しない。
    expect(containsLeakedToolMarkup(LT + 'invoke name="Bash"' + GT)).toBe(false);
    // parameter だけ（invoke 無し）→ 発火しない。
    expect(containsLeakedToolMarkup(LT + 'parameter name="command"' + GT)).toBe(false);
  });

  it("returns false for empty / nullish input", () => {
    expect(containsLeakedToolMarkup("")).toBe(false);
    expect(containsLeakedToolMarkup(undefined)).toBe(false);
    expect(containsLeakedToolMarkup(null)).toBe(false);
  });

  it("GUIDANCE itself contains no raw tag signature (再掲せず再掲禁止を伝える)", () => {
    expect(containsLeakedToolMarkup(GUIDANCE)).toBe(false);
  });
});

describe("guard-tool-markup hook: stdin/stdout contract", () => {
  const hook = join(process.cwd(), "templates", ".claude", "hooks", "guard-tool-markup.mjs");
  function runHook(prompt: string): string {
    return execFileSync(process.execPath, [hook], { input: JSON.stringify({ prompt }), encoding: "utf8" });
  }

  it("emits additionalContext when the prompt contains leaked markup", () => {
    const out = runHook(buildLeaked());
    const parsed = JSON.parse(out) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput?.additionalContext).toMatch(/再掲/);
  });

  it("emits nothing for a clean prompt (no false positive)", () => {
    expect(runHook("article:finalize の進め方を教えて").trim()).toBe("");
  });
});
