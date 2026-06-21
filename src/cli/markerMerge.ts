// auto ブロック（機械生成部）と editor 欄（人が書く部）を分け、再生成で auto だけ差し替える
// マーカー保護の共通実装。completion-report / direction-check の両方から使う（コピペ防止）。

export const AUTO_BEGIN = "<!-- auto:begin -->";
export const AUTO_END = "<!-- auto:end -->";

export type MergeResult = { content: string; recovered: boolean };

// head: タイトル ＋ auto ブロック（AUTO_END で終わる、再生成で差し替える部分）。
// freshFull: 初回生成 / マーカー破損時に使う全文（head ＋ 既定 editor テンプレ）。
// existing: 既存ファイル内容（無ければ null）。
//
// 既存に begin/end が「ちょうど1つずつ・正順」で在れば、AUTO_END 以降（editor 欄）を残して
// head だけ最新化する。欠落・逆順・重複は破損とみなし recovered=true で全文再生成（呼び出し側で bak 退避）。
export function mergeMarkered(head: string, freshFull: string, existing: string | null): MergeResult {
  if (existing === null) {
    return { content: freshFull, recovered: false };
  }
  const beginFirst = existing.indexOf(AUTO_BEGIN);
  const beginLast = existing.lastIndexOf(AUTO_BEGIN);
  const endFirst = existing.indexOf(AUTO_END);
  const endLast = existing.lastIndexOf(AUTO_END);
  const wellFormed =
    beginFirst >= 0 &&
    beginFirst === beginLast && // begin は1つだけ
    endFirst >= 0 &&
    endFirst === endLast && // end は1つだけ
    beginFirst < endFirst; // begin が end より前
  if (!wellFormed) {
    return { content: freshFull, recovered: true };
  }
  const editorTail = existing.slice(endFirst + AUTO_END.length);
  return { content: `${head}${editorTail}`, recovered: false };
}
