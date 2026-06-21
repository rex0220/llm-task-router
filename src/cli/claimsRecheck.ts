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
  claimsSourceRunId: string; // claims.json をどの run から読んだか（current か supersedes 元か）
  changedSections: number;
  candidates: RecheckCandidate[];
  discoverySections: string[];
};

// 見出しの表記ゆれを吸収（先頭の # と前後空白を落とす）。factcheck-scope からも使うため export。
export function normalizeHeading(heading: string): string {
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
    ...(result.claimsSourceRunId !== result.runId ? [`- claims 台帳の参照元: ${result.claimsSourceRunId}（更新前の版）`] : []),
    "",
    "> factchecker は **既存 claim の再検証**と、update-diff 内の**新規 claim 抽出**だけを `--scope diff` で行う（全文再検証しない）。",
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
  lines.push("## 新規 claim 抽出対象セクション", "");
  if (result.discoverySections.length === 0) {
    lines.push("（なし）", "");
  } else {
    lines.push(
      "以下の変更セクションについて、update-diff.md の追加行から新しく検証すべき claim（価格・API・モデルID・バージョン・技術仕様・固有名詞など）を抽出し、claims.raw.json に含める。",
      ""
    );
    for (const heading of result.discoverySections) {
      lines.push(`- ${heading}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function readClaims(store: RunStore, runId: string): Promise<Claim[] | null> {
  return store.read(runId, CLAIMS_FILE).then(
    (content) => ClaimsSchema.parse(JSON.parse(content)),
    () => null
  );
}

// claims.json の入手経路を解決する。
// 更新 run（import 起点）は自分の claims.json を持たないので、meta.lineage.supersedesRunId
// （更新前の版の run）の台帳を参照する。「今回変わった見出しに属する既存 claim」を選ぶ責務に合う。
async function resolveClaims(store: RunStore, runId: string): Promise<{ claims: Claim[]; sourceRunId: string }> {
  const own = await readClaims(store, runId);
  if (own) {
    return { claims: own, sourceRunId: runId };
  }
  const meta = await store.readMeta(runId).catch(() => null);
  const prev = meta?.lineage?.supersedesRunId;
  if (prev) {
    const prior = await readClaims(store, prev);
    if (prior) {
      return { claims: prior, sourceRunId: prev };
    }
  }
  throw new Error(
    `claims.json が現在の run にも supersedes 元 run にもありません（公開版で article:claims-normalize を実行済みか確認）。`
  );
}

// claims.json と changed-sections.json から再検証対象を選び、claims-recheck.md を書き出す。
export async function writeClaimsRecheck(store: RunStore, runId: string): Promise<RecheckResult> {
  // 無ければここで失敗（update-diff 未実行＝差分更新の run でない）。
  const changed = JSON.parse(await store.read(runId, CHANGED_SECTIONS_FILE)) as ChangedSection[];
  const { claims, sourceRunId } = await resolveClaims(store, runId);

  const candidates = selectRecheckClaims(claims, changed);
  const discoverySections = selectDiscoverySections(changed);
  const result: RecheckResult = {
    runId,
    claimsSourceRunId: sourceRunId,
    changedSections: changed.length,
    candidates,
    discoverySections,
  };
  await store.save(runId, RECHECK_FILE, buildRecheckMarkdown(result));
  return result;
}

// 追加行があるセクションは、既存 claims.json に無い新規 claim が生まれ得る。
// CLI は真偽や claim 抽出を判断せず、factchecker が見るべき変更セクションを明示する。
// factcheck-scope（優先度4）からも再利用するため export する。
export function selectDiscoverySections(changed: ChangedSection[]): string[] {
  const headings = new Set<string>();
  for (const section of changed) {
    if (section.added > 0) {
      headings.add(normalizeHeading(section.heading));
    }
  }
  return [...headings];
}
