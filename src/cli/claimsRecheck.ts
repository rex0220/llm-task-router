import type { RunStore } from "../storage/RunStore";
import { ClaimsSchema, type Claim } from "../schemas/ClaimsSchema";
import type { ChangedSection } from "./updateDiff";
import { CLAIMS_FILE } from "./claimsNormalize";

// P6: 公開済み記事の更新リライトで、全文を再検証せず「変更セクションに属する claim」だけを
// 重点再検証の対象に絞る。article:update-diff の changed-sections.json と claims.json を突き合わせる。
// 価格・API・バージョンなど陳腐化しやすい type を優先して並べ、factchecker の --scope diff 入力にする。

export const RECHECK_FILE = "claims-recheck.md";
const CHANGED_SECTIONS_FILE = "changed-sections.json";

// 陳腐化しやすい順（小さいほど優先）。価格・API・バージョンを先に出す。
const TYPE_PRIORITY: Record<Claim["type"], number> = {
  price: 0,
  api: 1,
  version: 2,
  technical: 3,
  general: 4,
};

export type RecheckCandidate = {
  id: string;
  claim: string;
  type: Claim["type"];
  status: Claim["status"];
  severity: Claim["severity"];
  heading: string;
};

export type RecheckResult = {
  runId: string;
  changedSections: number;
  candidates: RecheckCandidate[];
};

// 見出しの表記ゆれを吸収（先頭の # と前後空白を落とす）。
function normalizeHeading(heading: string): string {
  return heading.replace(/^#+\s*/, "").trim();
}

// present な claim のうち、location.heading が変更セクションに属するものを優先順に返す。
export function selectRecheckClaims(claims: Claim[], changed: ChangedSection[]): RecheckCandidate[] {
  const changedHeadings = new Set(changed.map((s) => normalizeHeading(s.heading)));
  return claims
    .filter((c) => c.lifecycle === "present" && changedHeadings.has(normalizeHeading(c.location.heading)))
    .map((c) => ({
      id: c.id,
      claim: c.claim,
      type: c.type,
      status: c.status,
      severity: c.severity,
      heading: normalizeHeading(c.location.heading),
    }))
    .sort((a, b) => TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type] || a.id.localeCompare(b.id));
}

function buildRecheckMarkdown(result: RecheckResult): string {
  const volatile = result.candidates.filter((c) => c.type === "price" || c.type === "api" || c.type === "version");
  const others = result.candidates.filter((c) => c.type === "technical" || c.type === "general");

  const lines = [
    "# Claim 差分再検証（変更セクションに属する claim）",
    "",
    `- 変更セクション: ${result.changedSections}`,
    `- 対象 claim: ${result.candidates.length}（陳腐化しやすい type を優先）`,
    "",
    "> factchecker は **これらの claim だけ**を `--scope diff` で再検証する（全文再検証しない）。",
    "> 再検証後は `claims.raw.json` を更新し `article:claims-normalize --scope diff` で戻す。",
    "",
  ];
  const section = (title: string, items: RecheckCandidate[]): void => {
    lines.push(`## ${title}`, "");
    if (items.length === 0) {
      lines.push("（なし）", "");
      return;
    }
    for (const c of items) {
      lines.push(`- [${c.id}] (${c.type}/${c.status}/${c.severity}) ${c.claim}（${c.heading}）`);
    }
    lines.push("");
  };
  section("優先（price / api / version）", volatile);
  section("その他（technical / general）", others);
  return lines.join("\n");
}

// claims.json と changed-sections.json から再検証対象を選び、claims-recheck.md を書き出す。
export async function writeClaimsRecheck(store: RunStore, runId: string): Promise<RecheckResult> {
  const claims = ClaimsSchema.parse(JSON.parse(await store.read(runId, CLAIMS_FILE)));
  // 無ければここで失敗（update-diff 未実行＝差分更新の run でない）。
  const changed = JSON.parse(await store.read(runId, CHANGED_SECTIONS_FILE)) as ChangedSection[];

  const candidates = selectRecheckClaims(claims, changed);
  const result: RecheckResult = { runId, changedSections: changed.length, candidates };
  await store.save(runId, RECHECK_FILE, buildRecheckMarkdown(result));
  return result;
}
