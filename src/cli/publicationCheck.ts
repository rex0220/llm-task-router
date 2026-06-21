// publication-check.md のパース規約を1箇所に集約する。
// verify-artifacts（ゲート宣言の機械チェック）と completion-report（転記）の両方から使う。
// ここを正本にしてコピペ実装のドリフトを防ぐ（編集長が書く publication-check.md が唯一の入力）。

export type GateState = "done" | "skipped" | "missing";

// ゲート行 "- <gate>: done|skipped"。値は done か skipped の単独のみ有効。
// 未記入テンプレの "done / skipped" を done と誤読しないよう行末を固定する（no silent skip）。
export function gateState(publicationCheck: string, gate: string): GateState {
  const m = new RegExp(`^-\\s*${escapeRe(gate)}:\\s*(done|skipped)\\s*$`, "im").exec(publicationCheck);
  if (!m) {
    return "missing";
  }
  return m[1].toLowerCase() === "done" ? "done" : "skipped";
}

// "- <gate> summary: ..." のスキップ理由/要約が埋まっているか。
export function hasSkipReason(publicationCheck: string, gate: string): boolean {
  return parseGateSummary(publicationCheck, gate) !== undefined;
}

// "- <gate> summary: ..." の要約テキスト（無ければ undefined）。
export function parseGateSummary(publicationCheck: string, gate: string): string | undefined {
  return parseField(publicationCheck, `${gate} summary`);
}

// "- GO/NO-GO: ..." の値（無ければ undefined）。
export function parseGoNoGo(publicationCheck: string): string | undefined {
  return parseField(publicationCheck, "GO/NO-GO");
}

// "- reason: ..." の値（無ければ undefined）。
export function parseReason(publicationCheck: string): string | undefined {
  return parseField(publicationCheck, "reason");
}

// "- <label>: <値>" 行から値を取り出す共通実装。値が空（テンプレ未記入）は undefined。
// 桁内空白は [^\S\n]*（水平空白のみ）に限定する。\s* だと colon 後の改行を食って
// 次行の値を誤って拾う（空欄なのに下の行が値に見える）ため。
function parseField(publicationCheck: string, label: string): string | undefined {
  const m = new RegExp(`^-[^\\S\\n]*${escapeRe(label)}:[^\\S\\n]*(\\S.*?)[^\\S\\n]*$`, "im").exec(
    publicationCheck
  );
  return m ? m[1] : undefined;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
