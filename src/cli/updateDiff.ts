import type { RunStore } from "../storage/RunStore";

// 差分の正本（§5.4）。update-base.md（import 直後の版）と現 final.md の差分を生成し、
// 2検証（factchecker / build-verifier）が「変更箇所＋周辺」だけを入力にできるようにする。

type DiffOp = { type: "equal" | "del" | "add"; text: string };

export type ChangedSection = {
  heading: string; // 直近の見出しテキスト（前文なら "(前文)"）
  level: number; // 見出しレベル（前文は 0）
  added: number;
  removed: number;
};

export type UpdateDiffResult = {
  diffText: string; // update-diff.md の本文（unified 風）
  changedSections: ChangedSection[];
  added: number; // 追加行数
  removed: number; // 削除行数
};

function splitLines(text: string): string[] {
  // 末尾の単一改行は行として数えない（store.save が付ける末尾改行のブレを吸収）。
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  return normalized.length === 0 ? [] : normalized.split("\n");
}

// 行単位の LCS 差分。記事規模（数百行）なら O(n*m) で十分。
function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", text: a[i] });
      i++;
    } else {
      ops.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "del", text: a[i++] });
  }
  while (j < m) {
    ops.push({ type: "add", text: b[j++] });
  }
  return ops;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

function headingOf(line: string): { level: number; text: string } | undefined {
  const match = HEADING_RE.exec(line);
  return match ? { level: match[1].length, text: match[2] } : undefined;
}

// unified 風の diff テキストを context 行付きで組む（git diff の hunk に近い形）。
function toUnifiedDiff(ops: DiffOp[], context: number): string {
  const changeIdx = ops.flatMap((op, idx) => (op.type === "equal" ? [] : [idx]));
  if (changeIdx.length === 0) {
    return "";
  }

  // 変更同士が context*2 行以内なら 1 hunk にまとめる。
  const clusters: Array<[number, number]> = [];
  let start = changeIdx[0];
  let end = changeIdx[0];
  for (const idx of changeIdx.slice(1)) {
    if (idx - end <= context * 2) {
      end = idx;
    } else {
      clusters.push([start, end]);
      start = idx;
      end = idx;
    }
  }
  clusters.push([start, end]);

  const lines: string[] = [];
  for (const [s, e] of clusters) {
    const from = Math.max(0, s - context);
    const to = Math.min(ops.length - 1, e + context);
    lines.push(`@@ ${describeHunkHeading(ops, from)} @@`);
    for (let k = from; k <= to; k++) {
      const op = ops[k];
      const prefix = op.type === "add" ? "+" : op.type === "del" ? "-" : " ";
      lines.push(`${prefix}${op.text}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

// hunk 見出し補助: その hunk が属する直近の見出しを示す（読みやすさ用）。
function describeHunkHeading(ops: DiffOp[], from: number): string {
  for (let k = from; k >= 0; k--) {
    const h = headingOf(ops[k].text);
    if (h) {
      return h.text;
    }
  }
  return "(前文)";
}

export function generateUpdateDiff(base: string, final: string): UpdateDiffResult {
  const ops = diffLines(splitLines(base), splitLines(final));

  const sections = new Map<string, ChangedSection>();
  let current: ChangedSection | null = null;
  const keyOf = (level: number, heading: string): string => `${level}:${heading}`;
  const ensure = (level: number, heading: string): ChangedSection => {
    const key = keyOf(level, heading);
    let sec = sections.get(key);
    if (!sec) {
      sec = { heading, level, added: 0, removed: 0 };
      sections.set(key, sec);
    }
    return sec;
  };

  let preface: ChangedSection | null = null;
  let added = 0;
  let removed = 0;

  for (const op of ops) {
    const h = headingOf(op.text);
    if (h) {
      // 見出し行は equal/add/del いずれでも「現在地」を更新する。
      // del 見出し（セクション丸ごと削除）でも、その配下の削除本文を当該セクションへ寄せる
      // （前のセクションへの誤帰属を防ぐ。changed-sections.json は差分集中検証の地図）。
      current = ensure(h.level, h.text);
    }
    const target = current ?? (preface ??= { heading: "(前文)", level: 0, added: 0, removed: 0 });
    if (op.type === "add") {
      target.added++;
      added++;
    } else if (op.type === "del") {
      target.removed++;
      removed++;
    }
  }

  const changedSections: ChangedSection[] = [];
  if (preface && (preface.added > 0 || preface.removed > 0)) {
    changedSections.push(preface);
  }
  for (const sec of sections.values()) {
    if (sec.added > 0 || sec.removed > 0) {
      changedSections.push(sec);
    }
  }

  return { diffText: toUnifiedDiff(ops, 3), changedSections, added, removed };
}

// update-base.md と final.md から差分成果物を生成して runs/<id>/ に保存する。
export async function writeUpdateDiff(store: RunStore, runId: string): Promise<UpdateDiffResult> {
  const base = await store.read(runId, "update-base.md"); // 無ければここで失敗（import 起点でない run）
  const final = await store.read(runId, "final.md");
  const result = generateUpdateDiff(base, final);

  const header = [
    "# 更新差分（update-base.md → final.md）",
    "",
    `- 追加: ${result.added} 行 / 削除: ${result.removed} 行`,
    `- 変更セクション: ${result.changedSections.length}`,
    "",
    result.diffText ? "```diff" : "（差分なし）",
  ];
  const body = result.diffText ? [...header, result.diffText.trimEnd(), "```", ""].join("\n") : `${header.join("\n")}\n`;
  await store.save(runId, "update-diff.md", body);
  await store.save(runId, "changed-sections.json", JSON.stringify(result.changedSections, null, 2));

  return result;
}
