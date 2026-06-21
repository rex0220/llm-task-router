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

export type ProgressSnapshot = {
  runId: string;
  steps: ProgressStep[];
  total: number; // 表示する全行数（canonical ＋ 追加工程）
  canonicalTotal: number; // canonical 工程数（現在地「N / M」の分母。非 canonical 追加工程で膨らまない）
  toolVersion?: string; // 記録した llm-task-router のバージョン（at 最大のイベント由来。無ければ undefined）
  currentIndex?: number; // 1-based。最初の未完 canonical 工程（pending/start/error）。全 canonical done/skip なら undefined（=完了）
  complete: boolean; // canonical 工程がすべて done/skip
  totalCostUsd?: number; // costUsd が判明した工程のみ合算（不明は除外）
  totalInputTokens?: number; // トークンが判明した工程のみ合算（LLM 工程のみ。無ければ undefined）
  totalOutputTokens?: number;
  updatedAt: string;
};
