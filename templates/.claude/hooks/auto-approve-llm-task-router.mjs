#!/usr/bin/env node
// PreToolUse hook: 記事ワークフローの llm-task-router コマンドを自動承認する。
// Bash ツールと PowerShell ツール（Windows の既定シェル）の両方を対象にする。
//   settings.json の matcher は "Bash|PowerShell"。tool_name で分岐し、シェルごとの
//   構文規則でコマンドを検証する。
// オペレーターが別ディレクトリから `bash -c 'cd "<記事フォルダー>" && llm-task-router article:...'`
// （あるいは PowerShell で直に `llm-task-router article:...`）の形で実行すると、Bash 側は
// 先頭が `bash` になり前方一致 allowlist が効かず、PowerShell 側はそもそも Bash() の allowlist と
// 別経路なので毎回プロンプトになる。このフックはコマンドを構文的に検証し、「実行される主コマンドが
// ディレクトリ変更（cd 系）と llm-task-router の許可サブコマンドだけ」のときに限り自動承認する。
// - article:* は既存方針として接頭辞で広く許可（公開相当 export / record-publication も含む。
//   公開ゲートは編集長の GO/NO-GO ＋ ユーザー承認という会話レベルで担保する）。
// - series は新設のため接頭辞ではなく明示コマンド名リストに絞る（ローカルのファイル操作のみ。
//   将来 series:extract-voice 等モデル呼び出し系が増えても先取り承認しない＝settings.json と一貫）。
//
// 重要（安全性）: 単純な部分一致では `llm-task-router article:status; rm -rf /` や
// `echo llm-task-router article:create && <別コマンド>` のような連結も丸ごと自動承認されてしまう。
// そこでクォートを考慮して top-level の `&&` で分割し、各セグメントの主コマンドが cd 系 /
// llm-task-router article:* のみであることを確認する。連結・パイプ・バックグラウンド・コマンド置換
// （`;` `|` 単独 `&` 改行 `` ` `` `$(` 等）が top-level に現れたら自動承認しない（通常プロンプトへ）。
// 例外として、**末尾の無害な装飾**だけは剥がしてから判定する:
//   - stderr/標準出力リダイレクト（fd 複製 `2>&1`/`1>&2`・null への破棄 `2>/dev/null` `2>$null` 等）。
//   - 出力ページャパイプ（`| tail`/`| head`、PowerShell は `| Select-Object -First/-Last N`）。
//     出力行数を絞る読み取り専用イディオムで、`article:create ... 2>&1 | tail -20` のような形を自動承認できる。
// これらは末尾を削るだけで、その後に必ず既存の演算子ゲートを再通過する（新たな top-level 演算子を生まない）。
// 任意ファイルへの `> file`・`| tee file`・`| sh`・`| Out-File` 等は剥がさず、`>`/`|` として演算子検査で弾く
// （上書き・任意実行の防止）。なお Bash/PowerShell ツールは stderr を自動捕捉するので `2>&1` は本来不要。

import { readFileSync } from "node:fs";

// article:* は接頭辞で広く許可（既存方針）。series は新設のため明示コマンド名のみ許可（先取り承認を防ぐ）。
// いずれもローカルのファイル操作のみ（series:plan は series.json への候補名 upsert、series:check は
// glossary 照合とレポート出力＝read-only）。モデル呼び出し系（将来の series:extract-voice 等）は
// 引き続きリストに入れない。
const ALLOWED_ARTICLE_PREFIX = "article:";
const ALLOWED_SERIES_COMMANDS = new Set(["series:init", "series:freeze-voice", "series:status", "series:check", "series:plan"]);

// ディレクトリ変更のみ（無害）として許可する先頭コマンド。シェルごとに別集合。
const BASH_DIR_HEADS = new Set(["cd"]);
const PWSH_DIR_HEADS = new Set(["cd", "set-location", "sl", "pushd", "push-location"]);

function isAllowedSubcommand(sub) {
  return !!sub && (sub.startsWith(ALLOWED_ARTICLE_PREFIX) || ALLOWED_SERIES_COMMANDS.has(sub));
}

// 末尾の「無害な stderr/標準出力の捨て先」リダイレクトだけを剥がす（コマンドはそのまま発行される）。
// fd 複製（2>&1 / 1>&2）と null/devnull への破棄のみ許可する。任意ファイルへの `> file` は剥がさない
// ＝後段の演算子検査で弾かれる（上書き事故を防ぐ）。クォート外の末尾トークンだけを対象にするため、
// 文字列末尾 `$` 直前のトークンを1つずつ繰り返し剥がす（例: `>/dev/null 2>&1` の2連結も解ける）。
// 注: クォートで閉じた文字列（例: `--note "x 2>&1"`）は末尾が `"` で一致しないため剥がれない。
const BASH_SAFE_REDIRECT = /\s+(?:[12]>&[12]|2>\/dev\/null|>\/dev\/null|&>\/dev\/null)\s*$/;
const PWSH_SAFE_REDIRECT = /\s+(?:[12]>&[12]|2>\$null|>\$null|\*>\$null)\s*$/i;

function stripTrailingSafeRedirects(text, pattern) {
  let out = text;
  for (;;) {
    const next = out.replace(pattern, "");
    if (next === out) {
      return out;
    }
    out = next;
  }
}

// 末尾の「無害な出力ページャ」パイプ（`| tail`/`| head`、PowerShell は `| Select-Object -First/-Last N`）
// だけを剥がす。出力行数を絞る読み取り専用イディオムで、ファイル書き込み・別コマンド実行を伴わない。
// tee / sh / Out-File 等は許可しない（ページャ正規表現に一致しないため剥がれず、後段の `|` 検査で deny）。
// 引数はフラグ・数値のみ許可し、位置引数（ファイルパス）や `-f`（follow）等は弾く＝ファイル読み出しもさせない。
const BASH_PAGER = /^(?:tail|head)(?:\s+(?:-\d+|-[nc]\s*\d+|--lines=\d+|--bytes=\d+|\+\d+))*\s*$/;
const PWSH_PAGER = /^(?:select-object|select)(?:\s+-(?:first|last)\s+\d+)+\s*$/i;

// クォート外（top-level）の最後の単一 `|` の位置を返す（`||` は対象外＝後段で deny）。未閉じクォートは -1。
// クォート判定は ' と " のトグルのみ（保守的）。誤判定はいずれも「剥がさない→後段で deny」に倒れるので安全側。
function lastTopLevelPipeIndex(text) {
  let quote = null;
  let idx = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "|") {
      if (text[i + 1] === "|" || text[i - 1] === "|") {
        i++; // `||`（論理OR）はページャではない。後段の `|` 検査で deny。
        continue;
      }
      idx = i;
    }
  }
  return quote ? -1 : idx;
}

// 末尾が安全なページャパイプなら、その手前（左側コマンド）だけを返す。違えば入力をそのまま返す
// （後段の `|` 検査で deny に倒れる）。ページャ右側の末尾リダイレクト（`| tail -20 2>&1`）も許容する。
function stripTrailingPager(text, pagerPattern, redirectPattern) {
  const idx = lastTopLevelPipeIndex(text);
  if (idx < 0) {
    return text;
  }
  const left = text.slice(0, idx).trimEnd();
  const right = stripTrailingSafeRedirects(text.slice(idx + 1).trim(), redirectPattern);
  return pagerPattern.test(right) ? left : text;
}

// 末尾の無害な装飾（リダイレクト＋ページャパイプ）を、組み合わせ・順序によらず安定するまで繰り返し剥がす。
// 例: `... 2>&1 | tail -20` / `... | tail -20 2>&1` のどちらも素のコマンドへ畳める。
function stripTrailingDecorations(text, redirectPattern, pagerPattern) {
  let out = text;
  for (;;) {
    let next = stripTrailingSafeRedirects(out, redirectPattern);
    next = stripTrailingPager(next, pagerPattern, redirectPattern);
    if (next === out) {
      return out;
    }
    out = next;
  }
}

// 分割済みセグメント群が「ディレクトリ変更 ＋ llm-task-router の許可サブコマンド」だけかを検証する。
// dirHeads は cd 系の許可先頭コマンド集合、foldHead は先頭語の大小文字畳み込み（PowerShell 用）。
function segmentsAreWorkflowOnly(segments, dirHeads, foldHead) {
  let sawWorkflow = false;
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (trimmed === "") {
      return false; // 空セグメント（先頭/末尾/連続 && 等）
    }
    const words = trimmed.split(/\s+/);
    const head = foldHead(words[0]);
    if (dirHeads.has(head)) {
      continue; // 作業ディレクトリ変更は無害
    }
    if (head === "llm-task-router") {
      if (!isAllowedSubcommand(words[1])) {
        return false; // article:* と許可された series コマンド以外（--help・未許可 series 等）は対象外
      }
      sawWorkflow = true;
      continue;
    }
    return false; // cd 系 / llm-task-router 以外の主コマンドが混ざる
  }
  return sawWorkflow;
}

// Bash: クォートを追跡しながら top-level の `&&` で分割。危険な演算子・置換が出たら null。
function splitBashSegments(inner) {
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
      if (ch === "`") return null;
      if (ch === "$" && next === "(") return null;
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
      return null;
    }
    if (ch === "$" && next === "(") {
      return null; // コマンド置換
    }
    cur += ch;
  }
  if (quote !== null) {
    return null; // クォート不一致
  }
  segments.push(cur);
  return segments;
}

// PowerShell: クォートを追跡しながら top-level の `&&` で分割。危険な演算子・部分式が出たら null。
// PowerShell 特有: 単一引用符は '' でリテラルの ' をエスケープ、二重引用符内の補間は `$(` と
// バッククォート（エスケープ）で検出、部分式は `$(` / `@(`、`&` は背景/呼び出し演算子、`;` は文区切り。
function splitPwshSegments(inner) {
  const segments = [];
  let cur = "";
  let quote = null; // "'" | '"' | null
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    const next = inner[i + 1];
    if (quote === "'") {
      // 単一引用符内はリテラル。'' は1個のリテラル ' なので2文字まとめて取り込む。
      if (ch === "'") {
        if (next === "'") {
          cur += "''";
          i++;
          continue;
        }
        quote = null;
      }
      cur += ch;
      continue;
    }
    if (quote === '"') {
      // 二重引用符内は補間あり。バッククォート（エスケープ）と部分式 $(...) を検出して不許可。
      if (ch === "`") return null;
      if (ch === "$" && next === "(") return null;
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
    // top-level の文区切り/パイプ/背景・呼び出し/リダイレクト/エスケープ/改行は不許可。
    if (
      ch === ";" ||
      ch === "|" ||
      ch === "&" ||
      ch === "<" ||
      ch === ">" ||
      ch === "`" ||
      ch === "\n"
    ) {
      return null;
    }
    if (ch === "$" && next === "(") {
      return null; // 部分式 $(...)
    }
    if (ch === "@" && next === "(") {
      return null; // 配列部分式 @(...)
    }
    if (ch === "{" || ch === "}") {
      return null; // スクリプトブロック
    }
    cur += ch;
  }
  if (quote !== null) {
    return null; // クォート不一致
  }
  segments.push(cur);
  return segments;
}

// command が「cd ＋ llm-task-router の許可サブコマンドだけ」か構文的に検証する（Bash 形式）。
export function isWorkflowOnlyCommand(command) {
  let inner = String(command ?? "").trim();

  // ラップの外側に付いた末尾の安全装飾（例: `bash -c '...' 2>&1 | tail -20`）を先に剥がす。
  inner = stripTrailingDecorations(inner, BASH_SAFE_REDIRECT, BASH_PAGER);

  // `bash -c '<script>'` / `sh -c "<script>"` の1段ラップを剥がす（末尾に余計な追記が無いことも担保）。
  const wrap = /^(?:bash|sh)\s+-c\s+(['"])([\s\S]*)\1\s*$/.exec(inner);
  if (wrap) {
    inner = wrap[2].trim();
  }

  // スクリプト内側の末尾装飾（例: `... article:status --run r 2>&1 | tail -20`）も剥がす。
  inner = stripTrailingDecorations(inner, BASH_SAFE_REDIRECT, BASH_PAGER);

  const segments = splitBashSegments(inner);
  if (segments === null) return false;
  return segmentsAreWorkflowOnly(segments, BASH_DIR_HEADS, (s) => s);
}

// command が「cd 系 ＋ llm-task-router の許可サブコマンドだけ」か構文的に検証する（PowerShell 形式）。
export function isWorkflowOnlyPwsh(command) {
  const inner = stripTrailingDecorations(String(command ?? "").trim(), PWSH_SAFE_REDIRECT, PWSH_PAGER);
  const segments = splitPwshSegments(inner);
  if (segments === null) return false;
  // PowerShell のコマンド名は大文字小文字を区別しない（cd / Set-Location / LLM-Task-Router）。
  return segmentsAreWorkflowOnly(segments, PWSH_DIR_HEADS, (s) => s.toLowerCase());
}

function emitAllow() {
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

  const command = input?.tool_input?.command;
  let allowed = false;
  if (input.tool_name === "Bash") {
    allowed = isWorkflowOnlyCommand(command);
  } else if (input.tool_name === "PowerShell") {
    allowed = isWorkflowOnlyPwsh(command);
  } else {
    process.exit(0);
  }

  if (allowed) {
    emitAllow();
  }

  process.exit(0);
}

// import されたとき（テスト）は main を実行しない。
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("auto-approve-llm-task-router.mjs")) {
  main();
}
