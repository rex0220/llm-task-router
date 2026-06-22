// 進捗ログの型。正本は runs/<runId>/progress.events.jsonl（append-only / 1イベント=1行）。
// progress.json / progress.md はこの events から再生成する派生スナップショット。

// events に載る状態。記録時はこの4種のみ（pending は「未着手」を表す表示専用で events には現れない）。
export type ProgressEventStatus = "start" | "done" | "skip" | "error";

// 集約後の表示状態。canonical 工程でまだイベントが無いものは "pending"。
export type ProgressStepStatus = ProgressEventStatus | "pending";

export type ProgressEvent = {
  at: string; // ISO8601
  runId: string;
  version?: string; // 記録した llm-task-router のバージョン（RunProgress が append 時に stamp）
  step: string;
  status: ProgressEventStatus;
  task?: string;
  provider?: string;
  model?: string;
  editorModel?: string; // 編集長（ワークフローを駆動する Claude）の AI モデル ID。記録時に編集長が明示する
  codeCheck?: boolean; // 構文/型チェック（build-verify）を実施対象とするか。create で作成時に固定（first-write-wins）。未指定＝既定オフ
  elapsedMs?: number;
  costUsd?: number;
  inputTokens?: number; // モデル呼び出しの入力トークン（LLM 工程のみ。集約は append 単位で積算）
  outputTokens?: number; // モデル呼び出しの出力トークン
  output?: string; // 主な出力パス（runs/<id>/... など）
  note?: string; // skip 理由・補足（silent skip 禁止）
};

// 集約後の1工程。
export type ProgressStep = {
  step: string;
  label: string;
  index: number; // 1-based の表示順
  canonical: boolean; // 標準工程定義に含まれるか（含まれない記録は末尾に並ぶ）
  status: ProgressStepStatus;
  startedAt?: string;
  finishedAt?: string;
  elapsedMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  output?: string;
  note?: string;
  provider?: string;
  model?: string;
};

// 完成（全 canonical が done/skip）後に記録された1イベントの写像。集約せず生の時系列で並べる。
// 集約表（canonical 畳み）とは役割が異なり、実操作の時系列ビューとして step は raw を保つ。
export type PostCompletionEntry = {
  at: string; // ISO8601（UTC）。表示時にローカル HH:MM:SS へ
  step: string; // 記録された生の操作名（evaluate / direction-check 等をそのまま保つ）
  canonicalStep?: string; // resolveCanonicalKey(step) が canonical キーに解決されるとき、その畳み先。非 canonical は undefined
  label: string; // 表示用ラベル。canonical なら canonical ラベル、非 canonical は step 名そのまま
  status: ProgressEventStatus; // start/done/skip/error
  costUsd?: number;
  inputTokens?: number; // LLM 工程のみ。完成後のトークン内訳を新節で復元するため保持
  outputTokens?: number;
  note?: string;
  output?: string;
};

export type ProgressSnapshot = {
  runId: string;
  steps: ProgressStep[];
  total: number; // 表示する全行数（canonical ＋ 追加工程）
  canonicalTotal: number; // canonical 工程数（現在地「N / M」の分母。非 canonical 追加工程で膨らまない）
  toolVersion?: string; // 記録した llm-task-router のバージョン（at 最大のイベント由来。無ければ undefined）
  editorModel?: string; // 編集長（駆動する Claude）の AI モデル ID（editorModel を持つ at 最大のイベント由来）
  codeCheck?: boolean; // 構文/型チェックを実施対象とするか（codeCheck を持つ at 最小のイベント由来＝first-write-wins）。undefined＝旧 run（未刻印）
  currentIndex?: number; // 1-based。最初の未完 canonical 工程（pending/start/error）。全 canonical done/skip なら undefined（=完了）
  complete: boolean; // canonical 工程がすべて done/skip
  totalCostUsd?: number; // costUsd が判明した工程のみ合算（不明は除外）
  totalInputTokens?: number; // トークンが判明した工程のみ合算（LLM 工程のみ。無ければ undefined）
  totalOutputTokens?: number;
  startedAt?: string; // run の開始時刻（全イベントの at 最小。イベントが無ければ undefined）
  // 完成（全 canonical が done/skip）に初めて到達した完成イベントの at。未完なら undefined。
  completedAt?: string;
  // 完成イベントより後ろに記録されたイベント（時系列）。完成後の編集経過。無ければ undefined。
  postCompletion?: PostCompletionEntry[];
  updatedAt: string;
};
