import { RunStore } from "../storage/RunStore";
import { RunProgress } from "../progress/RunProgress";
import { renderProgressMarkdown } from "../progress/renderMarkdown";
import type { ProgressSnapshot } from "../progress/types";

export type StatusResult = {
  snapshot: ProgressSnapshot;
  markdown: string;
};

// 進捗スナップショットを取得（読む直前に events から再生成）。progress.md 相当の表も返す。
// run の存在を meta.json で確認してから読む（runId の typo で「全 pending の架空 run」を作らない）。
export async function getRunStatus(runId: string): Promise<StatusResult> {
  const store = new RunStore();
  await assertRunExists(store, runId);
  const progress = new RunProgress(store);
  const snapshot = await progress.readSnapshot(runId);
  return { snapshot, markdown: renderProgressMarkdown(snapshot) };
}

async function assertRunExists(store: RunStore, runId: string): Promise<void> {
  try {
    await store.readMeta(runId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Run ${runId} が見つかりません（runs/${runId}/meta.json なし）。runId を確認してください。`);
    }
    throw error;
  }
}
