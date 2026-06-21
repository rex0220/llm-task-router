// 所要時間を人が読みやすい M:SS.mmm に整形する（例 241362ms → 4:01.362、1200ms → 0:01.200）。
// 分は桁あふれそのまま（例 72:05.000）。正本（progress.json / events）は raw な ms のまま保つ。
export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const millis = ms % 1000;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}
