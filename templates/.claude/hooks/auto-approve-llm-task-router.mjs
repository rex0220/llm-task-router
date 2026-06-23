#!/usr/bin/env node
// PreToolUse hook: 記事ワークフローの llm-task-router コマンドを自動承認する。
// オペレーターが別ディレクトリから `bash -c 'cd "<記事フォルダー>" && llm-task-router article:...'`
// の形で実行すると、コマンド先頭が `bash` になり settings.json の前方一致 allowlist が効かない。
// このフックはコマンドを構文的に検証し、「実行される主コマンドが cd と llm-task-router の
// 許可サブコマンドだけ」のときに限り自動承認する。
// - article:* は既存方針として接頭辞で広く許可（公開相当 export / record-publication も含む。
//   公開ゲートは編集長の GO/NO-GO ＋ ユーザー承認という会話レベルで担保する）。
// - series は新設のため接頭辞ではなく明示コマンド名リストに絞る（ローカルのファイル操作のみ。
//   将来 series:extract-voice 等モデル呼び出し系が増えても先取り承認しない＝settings.json と一貫）。
//
// 重要（安全性）: 単純な部分一致では `llm-task-router article:status; rm -rf /` や
// `echo llm-task-router article:create && <別コマンド>` のような連結も丸ごと自動承認されてしまう。
// そこでクォートを考慮して top-level の `&&` で分割し、各セグメントの主コマンドが cd / llm-task-router
// article:* のみであることを確認する。連結・パイプ・バックグラウンド・リダイレクト・コマンド置換
// （`;` `|` 単独 `&` `<` `>` 改行 `` ` `` `$(`）が top-level に現れたら自動承認しない（通常プロンプトへ）。

import { readFileSync } from "node:fs";

// article:* は接頭辞で広く許可（既存方針）。series は新設のため明示コマンド名のみ許可（先取り承認を防ぐ）。
const ALLOWED_ARTICLE_PREFIX = "article:";
const ALLOWED_SERIES_COMMANDS = new Set(["series:init", "series:freeze-voice", "series:status"]);

function isAllowedSubcommand(sub) {
  return !!sub && (sub.startsWith(ALLOWED_ARTICLE_PREFIX) || ALLOWED_SERIES_COMMANDS.has(sub));
}

// command が「cd と llm-task-router の許可サブコマンドだけ」で構成されるか構文的に検証する。
export function isWorkflowOnlyCommand(command) {
  let inner = String(command ?? "").trim();

  // `bash -c '<script>'` / `sh -c "<script>"` の1段ラップを剥がす（末尾に余計な追記が無いことも担保）。
  const wrap = /^(?:bash|sh)\s+-c\s+(['"])([\s\S]*)\1\s*$/.exec(inner);
  if (wrap) {
    inner = wrap[2].trim();
  }

  // クォートを追跡しながら top-level の `&&` で分割。危険な演算子が top-level に出たら不許可。
  const segments = [];
  let cur = "";
  let quote = null; // "'" | '"' | null
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    const next = inner[i + 1];
    if (quote === "'") {
      // シングルクォート内は全リテラル（置換も演算子も無効）。閉じだけ見る。
      if (ch === "'") quote = null;
      cur += ch;
      continue;
    }
    if (quote === '"') {
      // ダブルクォート内でもコマンド置換は有効なので検出する（演算子は無効＝リテラル）。
      if (ch === "`") return false;
      if (ch === "$" && next === "(") return false;
      if (ch === '"') quote = null;
      cur += ch;
      continue;
    }
    // クォート外。
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "&" && next === "&") {
      segments.push(cur);
      cur = "";
      i++; // 2文字目の & を読み飛ばす
      continue;
    }
    // top-level の連結/パイプ/背景実行/リダイレクト/置換は不許可。
    if (ch === ";" || ch === "|" || ch === "&" || ch === "<" || ch === ">" || ch === "\n" || ch === "`") {
      return false;
    }
    if (ch === "$" && next === "(") {
      return false; // コマンド置換
    }
    cur += ch;
  }
  if (quote !== null) {
    return false; // クォート不一致
  }
  segments.push(cur);

  let sawWorkflow = false;
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (trimmed === "") {
      return false; // 空セグメント（先頭/末尾/連続 && 等）
    }
    const words = trimmed.split(/\s+/);
    const head = words[0];
    if (head === "cd") {
      continue; // 作業ディレクトリ変更は無害
    }
    if (head === "llm-task-router") {
      if (!isAllowedSubcommand(words[1])) {
        return false; // article:* と許可された series コマンド以外（--help・未許可 series 等）は対象外
      }
      sawWorkflow = true;
      continue;
    }
    return false; // cd / llm-task-router 以外の主コマンドが混ざる
  }
  return sawWorkflow;
}

function main() {
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

  if (isWorkflowOnlyCommand(input?.tool_input?.command)) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "記事ワークフローの llm-task-router コマンドを自動承認（cd ＋ article:* / series:* のみ）",
        },
      })
    );
  }

  process.exit(0);
}

// import されたとき（テスト）は main を実行しない。
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("auto-approve-llm-task-router.mjs")) {
  main();
}
