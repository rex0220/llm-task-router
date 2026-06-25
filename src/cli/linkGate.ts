import type { Claim, Source } from "../schemas/ClaimsSchema";
import { collectCitedSourceIds } from "./claimsNormalize";

// 公開前の到達性ゲート（提案B）。純関数・通信しない。
// cited な source の到達性メタ（reachable / checkedAt）だけを見て、公開可否の素材を返す。
// 実際の HTTP 到達確認は article:sources-check の責務（ここは「回したか／結果が clean か」を記録から判定）。
//
// 判定の柱（docs/課題-対策-実装計画-死リンク再発防止.md §提案B / §6）:
// - checkedAt が無い＝一度も HTTP 確認していない＝「未検証」。factchecker 自己申告の reachable:"ok"
//   でも checkedAt は sources-check しか書かないので、「checkedAt あり」を http 検証済みの代理にできる
//   （A 軽量版と連動。maibun=未確認のまま出荷、を弾く本丸）。
// - reachable:"dead" は cited に残してはいけない（死リンク公開）。
// - reachable:"unknown"（確認したが断定不能）は公開直前に黙って素通りさせない。
// - checkedAt が古い（既定 90 日超）＝鮮度切れ（link rot 懸念）。

export const DEFAULT_FRESHNESS_DAYS = 90;

export type LinkGateCategory = "dead" | "unverified" | "unknown" | "stale";

export type LinkGateFinding = {
  id: string;
  url: string;
  category: LinkGateCategory;
  message: string;
};

export type LinkGateResult = {
  pass: boolean; // fails.length === 0
  fails: LinkGateFinding[];
  warnings: LinkGateFinding[];
  checkedCited: number; // 判定対象になった cited source 数
};

export type LinkGateMode = "export" | "bulk";

export type LinkGateOptions = {
  today: string; // YYYY-MM-DD（呼び出し側が確定。純関数に now を持ち込まない）
  freshnessDays?: number; // 既定 90
  // export: 鮮度切れ stale を FAIL（新規 export）/ bulk: stale を warning（公開済み一括点検）。既定 export。
  mode?: LinkGateMode;
  // 旧 run の救済（§6 #8）: checkedAt を一度も持たない旧 run は「未検証」を FAIL でなく warning に降格する。
  // 呼び出し側が meta.createdAt のカットオフ等で判定して渡す（純関数側では時代を判定しない）。
  legacyGrace?: boolean;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// YYYY-MM-DD 同士の経過日数（a - b）。UTC 正午で解釈し DST/タイムゾーンのズレを避ける。
// 不正な日付は NaN を返し、呼び出し側は「鮮度判定不能」として stale 扱いにしない（保守的）。
export function daysBetween(a: string, b: string): number {
  if (!DATE_RE.test(a) || !DATE_RE.test(b)) {
    return Number.NaN;
  }
  const toMs = (d: string): number => {
    const [y, m, day] = d.split("-").map((v) => Number.parseInt(v, 10));
    return Date.UTC(y, m - 1, day, 12, 0, 0);
  };
  return Math.round((toMs(a) - toMs(b)) / 86_400_000);
}

// cited な source の到達性メタから公開可否の素材を作る（通信なし）。
export function linkGate(claims: Claim[], sources: Source[], opts: LinkGateOptions): LinkGateResult {
  const freshnessDays = opts.freshnessDays ?? DEFAULT_FRESHNESS_DAYS;
  const mode: LinkGateMode = opts.mode ?? "export";
  const citedIds = collectCitedSourceIds(claims);
  const byId = new Map(sources.map((s) => [s.id, s] as const));

  const fails: LinkGateFinding[] = [];
  const warnings: LinkGateFinding[] = [];
  let checkedCited = 0;

  // id 昇順で安定した出力にする（SNNN は文字列ソートで番号順）。
  for (const id of [...citedIds].sort((a, b) => a.localeCompare(b))) {
    const s = byId.get(id);
    // cited なのに source が無い（dangling）は verify-artifacts の領分。ここでは触らない。
    if (!s) {
      continue;
    }
    checkedCited += 1;

    if (s.reachable === "dead") {
      fails.push({ id, url: s.url, category: "dead", message: `到達不能（dead）の source を引用しています: ${id} ${s.url}` });
      continue;
    }

    // checkedAt 無し＝一度も HTTP 確認していない＝未検証（factchecker の自己申告 ok もここで弾かれる）。
    if (!s.checkedAt) {
      const f: LinkGateFinding = {
        id,
        url: s.url,
        category: "unverified",
        message: `未検証（checkedAt 無し＝sources-check 未実行）: ${id} ${s.url}`,
      };
      // 旧 run の救済: 未検証だけは warning に降格（dead/unknown/stale は降格しない）。
      (opts.legacyGrace ? warnings : fails).push(f);
      continue;
    }

    if (s.reachable === "unknown") {
      fails.push({
        id,
        url: s.url,
        category: "unknown",
        message: `到達性 unknown（確認したが断定不能）を公開前に解決してください: ${id} ${s.url}`,
      });
      continue;
    }

    // ここに来るのは checkedAt あり かつ reachable が ok（または未記録だが checkedAt あり）。鮮度を見る。
    const age = daysBetween(opts.today, s.checkedAt);
    if (!Number.isNaN(age) && age > freshnessDays) {
      const f: LinkGateFinding = {
        id,
        url: s.url,
        category: "stale",
        message: `到達確認が古い（${age}日前 > ${freshnessDays}日）。再確認を推奨: ${id} ${s.url}`,
      };
      // export は止める／bulk 一括点検は warning 一覧（§提案B モード別）。
      (mode === "export" ? fails : warnings).push(f);
    }
  }

  return { pass: fails.length === 0, fails, warnings, checkedCited };
}

// --- 提案E: 複数 run（シリーズ／公開済み）の一括再確認（記録ベース・通信しない） ---
// checkedAt が古い（鮮度切れ）cited source を「再確認推奨」として一覧にするための集約。
// 実際の HTTP 再確認は各 run に sources-check --only-cited を回す（このコマンドは台帳から拾うだけ）。

export type RunLinkAudit = {
  runId: string;
  result: LinkGateResult | null; // claims/sources が無い run は null（skipped）
  skippedReason?: string;
};

// 各 run を bulk モードで判定する（stale は warning・dead/unknown/unverified は fails に出る）。
// claims/sources が読めなかった run は null（理由つき）でスキップする。
export function auditRuns(
  runs: { runId: string; claims: Claim[] | null; sources: Source[] | null }[],
  opts: { today: string; freshnessDays?: number }
): RunLinkAudit[] {
  return runs.map(({ runId, claims, sources }) => {
    if (claims === null || sources === null) {
      return { runId, result: null, skippedReason: "claims.json/sources.json が無い（normalize 未実行）" };
    }
    const result = linkGate(claims, sources, {
      today: opts.today,
      freshnessDays: opts.freshnessDays,
      mode: "bulk",
    });
    return { runId, result };
  });
}
