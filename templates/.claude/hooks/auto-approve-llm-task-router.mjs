#!/usr/bin/env node
// PreToolUse hook: 記事ワークフローの llm-task-router コマンドを自動承認する。
// オペレーターが別ディレクトリから `bash -c 'cd "<記事フォルダー>" && llm-task-router article:...'`
// の形で実行すると、コマンド先頭が `bash` になり settings.json の前方一致 allowlist が効かない。
// このフックはコマンド全文を見て判定するので、包みに依存せず自動承認できる。
// （公開相当 export / record-publication も含め全 article コマンドを許可。公開ゲートは
//  編集長の GO/NO-GO ＋ ユーザー承認という会話レベルで担保する＝settings.json の allowlist と一貫）。

import { readFileSync } from "node:fs";

let raw = "";
try {
  raw = readFileSync(0, "utf8");
} catch {
  process.exit(0);
}

let input;
try {
  input = JSON.parse(raw || "{}");
} catch {
  process.exit(0);
}

if (input.tool_name !== "Bash") process.exit(0);

const command = String(input?.tool_input?.command ?? "");

if (command.includes("llm-task-router article:")) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "記事ワークフローの llm-task-router コマンドを自動承認",
      },
    })
  );
}

process.exit(0);
