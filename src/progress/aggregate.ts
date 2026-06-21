import type { ProgressEvent, ProgressSnapshot, ProgressStep, ProgressStepStatus } from "./types";
import { QIITA_CANONICAL_STEPS, resolveCanonicalKey, type CanonicalStep } from "./stepOrder";

// 状態の優先度（高いほど確定的）。同一工程に複数イベントが来たとき、最高優先度を最終状態とする。
// done > error > skip > start。これにより resume 時の done→skip 退行や、error 後の done（リトライ成功）を正しく扱う。
const STATUS_PRIORITY: Record<ProgressStepStatus, number> = {
  pending: 0,
  start: 1,
  skip: 2,
  error: 3,
  done: 4,
};

type Accumulated = {
  key: string;
  firstSeenOrder: number;
  startedAt?: string;
  earliestAt?: string;
  // 最終状態（最高優先度）とその代表イベント（同優先度なら後勝ち＝リトライ後を採用）
  finalStatus: ProgressStepStatus;
  representative?: ProgressEvent;
  // costUsd/elapsedMs はイベント単位（呼び出し単位）の実測値なので、同じ工程に複数回かかった分（例:
  // create→後日の resume/review）を後勝ちで上書きせず、すべて積算する。これをしないと resume/review の
  // 小さい done が create 本体の費用を消してしまい、合計コストが過小表示になる。
  costUsd?: number;
  elapsedMs?: number;
};

// events 列 → ProgressSnapshot への純関数（I/O なし）。
export function aggregate(
  runId: string,
  events: ProgressEvent[],
  canonicalSteps: CanonicalStep[] = QIITA_CANONICAL_STEPS
): ProgressSnapshot {
  const canonicalKeys = new Set(canonicalSteps.map((s) => s.key));
  const acc = new Map<string, Accumulated>();
  let order = 0;

  for (const ev of events) {
    const key = resolveCanonicalKey(ev.step);
    let a = acc.get(key);
    if (!a) {
      a = { key, firstSeenOrder: order++, finalStatus: "pending" };
      acc.set(key, a);
    }

    if (a.earliestAt === undefined || ev.at < a.earliestAt) {
      a.earliestAt = ev.at;
    }
    if (ev.status === "start" && a.startedAt === undefined) {
      a.startedAt = ev.at;
    }

    if (ev.costUsd !== undefined) {
      a.costUsd = Number(((a.costUsd ?? 0) + ev.costUsd).toFixed(6));
    }
    if (ev.elapsedMs !== undefined) {
      a.elapsedMs = (a.elapsedMs ?? 0) + ev.elapsedMs;
    }

    // 最高優先度を最終状態に。同優先度は後勝ち（リトライ後の done/error を採用）。
    // note/output/provider/model は「代表イベント（＝最終状態を決めたイベント）」に紐づける。
    // こうしないと done 行に後続の skip/error の note（"already done"/"FAIL"）が混ざり、状態と説明が矛盾する。
    // cost/elapsed は上で積算済みなので代表イベント側からは持たない（後勝ちで上書きしない）。
    if (STATUS_PRIORITY[ev.status] >= STATUS_PRIORITY[a.finalStatus]) {
      a.finalStatus = ev.status;
      a.representative = ev;
    }
  }

  const labelOf = new Map(canonicalSteps.map((s) => [s.key, s.label] as const));

  const toStep = (a: Accumulated, index: number): ProgressStep => {
    const rep = a.representative;
    return {
      step: a.key,
      label: labelOf.get(a.key) ?? a.key,
      index,
      canonical: canonicalKeys.has(a.key),
      status: a.finalStatus,
      startedAt: a.startedAt ?? a.earliestAt,
      finishedAt: isTerminal(a.finalStatus) ? rep?.at : undefined,
      elapsedMs: a.elapsedMs,
      costUsd: a.costUsd,
      output: rep?.output,
      note: rep?.note,
      provider: rep?.provider,
      model: rep?.model,
    };
  };

  const steps: ProgressStep[] = [];
  let index = 1;

  // 1) canonical 工程を定義順に。記録があれば集約、無ければ pending 行。
  for (const c of canonicalSteps) {
    const a = acc.get(c.key);
    if (a) {
      steps.push(toStep(a, index++));
    } else {
      steps.push({ step: c.key, label: c.label, index: index++, canonical: true, status: "pending" });
    }
  }

  // 2) canonical 外の記録を登場順に末尾へ（アドホックなサブエージェント記録など）。
  const extras = [...acc.values()]
    .filter((a) => !canonicalKeys.has(a.key))
    .sort((x, y) => x.firstSeenOrder - y.firstSeenOrder);
  for (const a of extras) {
    steps.push(toStep(a, index++));
  }

  // 現在地は canonical 未完を優先する。非 canonical の追加工程（revise / direction-draft 等）が
  // 現在地を乗っ取らないように canonical に限定する（「N工程中M番目」の意味を保つ）。
  const currentRow = steps.find(
    (s) => s.canonical && (s.status === "pending" || s.status === "start" || s.status === "error")
  );
  const canonicalSteps2 = steps.filter((s) => s.canonical);
  const complete = canonicalSteps2.every((s) => s.status === "done" || s.status === "skip");

  const costs = steps.map((s) => s.costUsd).filter((c): c is number => c !== undefined);
  const totalCostUsd = costs.length > 0 ? Number(costs.reduce((sum, c) => sum + c, 0).toFixed(6)) : undefined;

  // 記録したツール版は「version を持ち at 最大のイベント」から採る（配列順ではなく時刻基準。
  // aggregate は純関数で未ソート配列が来うるため）。
  const versioned = events.filter((e) => e.version !== undefined);
  const toolVersion =
    versioned.length > 0 ? versioned.reduce((a, b) => (a.at >= b.at ? a : b)).version : undefined;

  return {
    runId,
    steps,
    total: steps.length,
    canonicalTotal: canonicalSteps2.length, // 現在地の分母（canonical のみ）
    toolVersion,
    currentIndex: currentRow?.index,
    complete,
    totalCostUsd,
    updatedAt: new Date().toISOString(),
  };
}

function isTerminal(status: ProgressStepStatus): boolean {
  return status === "done" || status === "skip" || status === "error";
}
