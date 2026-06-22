import type { PostCompletionEntry, ProgressEvent, ProgressSnapshot, ProgressStep, ProgressStepStatus } from "./types";
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
  inputTokens?: number;
  outputTokens?: number;
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
    // トークンも cost と同様に append 単位で積算（複数 invocation を畳む工程で総量を保つ）。
    if (ev.inputTokens !== undefined) {
      a.inputTokens = (a.inputTokens ?? 0) + ev.inputTokens;
    }
    if (ev.outputTokens !== undefined) {
      a.outputTokens = (a.outputTokens ?? 0) + ev.outputTokens;
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

  // 構文/型チェックの実施対象フラグも run 単位の不変属性。create で1回固定する想定なので、
  // codeCheck を持つ「at 最小（＝最初に申告された）」イベントから採る（first-write-wins）。
  // undefined＝旧 run（未刻印）。false＝既定オフ（作成時にコードチェック非指定）。
  const codeCheckEvents = events.filter((e) => e.codeCheck !== undefined);
  const codeCheck =
    codeCheckEvents.length > 0
      ? codeCheckEvents.reduce((a, b) => (a.at <= b.at ? a : b)).codeCheck
      : undefined;

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
      inputTokens: a.inputTokens,
      outputTokens: a.outputTokens,
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
    } else if (c.key === "build-verify" && codeCheck === false) {
      // 既定オフ: 作成時にコードチェック非指定。実イベントが無い build-verify は「対象外」として skip 表示にし、
      // 現在地・完了判定で「未実施の必須工程」に見えないようにする（手動で done/skip を記録すれば実イベントが優先）。
      steps.push({
        step: c.key,
        label: c.label,
        index: index++,
        canonical: true,
        status: "skip",
        note: "作成時にコードチェック非指定（既定オフ・必要なら手動で実施可）",
      });
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

  // トークン合計（判明した工程＝LLM 工程のみ。1つも無ければ undefined で列ごと出さない）。
  const inTokens = steps.map((s) => s.inputTokens).filter((t): t is number => t !== undefined);
  const outTokens = steps.map((s) => s.outputTokens).filter((t): t is number => t !== undefined);
  const totalInputTokens = inTokens.length > 0 ? inTokens.reduce((sum, t) => sum + t, 0) : undefined;
  const totalOutputTokens = outTokens.length > 0 ? outTokens.reduce((sum, t) => sum + t, 0) : undefined;

  // 記録したツール版は「version を持ち at 最大のイベント」から採る（配列順ではなく時刻基準。
  // aggregate は純関数で未ソート配列が来うるため）。
  const versioned = events.filter((e) => e.version !== undefined);
  const toolVersion =
    versioned.length > 0 ? versioned.reduce((a, b) => (a.at >= b.at ? a : b)).version : undefined;

  // 編集長（駆動する Claude）の AI モデルは run 単位の不変属性。create 時に1回固定する想定なので、
  // editorModel を持つ「at 最小（＝最初に申告された）」イベントから採る（first-write-wins）。
  // 後続イベントや旧 run への追記、別セッションの値で run の編集長が遡及・上書きされないようにする。
  const edited = events.filter((e) => e.editorModel !== undefined);
  const editorModel =
    edited.length > 0 ? edited.reduce((a, b) => (a.at <= b.at ? a : b)).editorModel : undefined;

  // run の開始時刻＝全イベントの at 最小（未ソート配列が来うるので min を取る）。
  const startedAt = events.length > 0 ? events.reduce((min, e) => (e.at < min ? e.at : min), events[0].at) : undefined;

  // 完成（全 canonical が done/skip）後の編集経過。最終状態が complete のときだけ求める
  // （瞬間的に完成→退行して現在 error 等の run では現在地と矛盾しないよう節を出さない）。
  const { completedAt, postCompletion } = complete
    ? computePostCompletion(events, canonicalKeys, labelOf, codeCheck)
    : { completedAt: undefined, postCompletion: undefined };

  return {
    runId,
    steps,
    total: steps.length,
    canonicalTotal: canonicalSteps2.length, // 現在地の分母（canonical のみ）
    toolVersion,
    editorModel,
    codeCheck,
    currentIndex: currentRow?.index,
    complete,
    totalCostUsd,
    totalInputTokens,
    totalOutputTokens,
    startedAt,
    completedAt,
    postCompletion,
    updatedAt: new Date().toISOString(),
  };
}

function isTerminal(status: ProgressStepStatus): boolean {
  return status === "done" || status === "skip" || status === "error";
}

// 完成境界（全 canonical が初めて done/skip を満たした点）を求め、それより後ろのイベントを写像する。
// events から決定的に計算する純関数（推定アンカーを持ち込まない）。呼び出し側で final complete を確認済み。
function computePostCompletion(
  events: ProgressEvent[],
  canonicalKeys: Set<string>,
  labelOf: Map<string, string>,
  codeCheck: boolean | undefined
): { completedAt?: string; postCompletion?: PostCompletionEntry[] } {
  // at 昇順の安定ソート（同時刻は入力配列順を保つ＝tie-break は入力順）。
  const sorted = events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.at === b.e.at ? a.i - b.i : a.e.at < b.e.at ? -1 : 1))
    .map(({ e }) => e);

  // build-verify 既定オフ（codeCheck=false）かつ実イベントなし → 最初から synthetic skip（terminal）。
  // 実イベントが1件でもあれば synthetic は使わず、その status に従ってリプレイする（done/skip 到達で terminal）。
  const hasBuildVerifyEvent = sorted.some((e) => resolveCanonicalKey(e.step) === "build-verify");
  const statusByKey = new Map<string, ProgressStepStatus>();
  for (const key of canonicalKeys) {
    const syntheticSkip = key === "build-verify" && codeCheck === false && !hasBuildVerifyEvent;
    statusByKey.set(key, syntheticSkip ? "skip" : "pending");
  }

  const allComplete = (): boolean =>
    [...canonicalKeys].every((k) => {
      const s = statusByKey.get(k)!;
      return s === "done" || s === "skip";
    });

  let boundary = -1;
  let completedAt: string | undefined;
  for (let i = 0; i < sorted.length; i++) {
    const key = resolveCanonicalKey(sorted[i].step);
    if (canonicalKeys.has(key)) {
      const cur = statusByKey.get(key)!;
      const next = sorted[i].status;
      // 集約と同じ優先度で単調更新（done>error>skip>start）。start/error だけでは terminal にしない。
      if (STATUS_PRIORITY[next] >= STATUS_PRIORITY[cur]) {
        statusByKey.set(key, next);
      }
    }
    if (boundary === -1 && allComplete()) {
      boundary = i;
      completedAt = sorted[i].at;
    }
  }

  if (boundary === -1) {
    return { completedAt: undefined, postCompletion: undefined };
  }

  const post = sorted.slice(boundary + 1).map((e): PostCompletionEntry => {
    const key = resolveCanonicalKey(e.step);
    const canonicalStep = canonicalKeys.has(key) ? key : undefined;
    return {
      at: e.at,
      step: e.step, // raw を保つ（evaluate / direction-check 等を畳まない）
      canonicalStep,
      label: (canonicalStep ? labelOf.get(canonicalStep) : undefined) ?? e.step,
      status: e.status,
      costUsd: e.costUsd,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      note: e.note,
      output: e.output,
    };
  });

  return { completedAt, postCompletion: post.length > 0 ? post : undefined };
}
