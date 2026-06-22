import { mkdir, appendFile, writeFile, readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RunStore } from "../storage/RunStore";
import type { ProgressEvent, ProgressSnapshot } from "./types";
import { aggregate } from "./aggregate";
import { renderProgressMarkdown } from "./renderMarkdown";

const EVENTS_FILE = "progress.events.jsonl";
const JSON_FILE = "progress.json";
const MD_FILE = "progress.md";

// 記録は at/runId を埋める前の最小入力で渡せる。
// version は呼び出し側に渡させない（stamp は RunProgress の責務）ため Omit する。
export type ProgressEventInput = Omit<ProgressEvent, "at" | "runId" | "version"> & { at?: string };

// 進捗の記録・再生成。正本は append-only の progress.events.jsonl。
// progress.json / progress.md は events から再生成する派生物（このクラス以外は書かない）。
export class RunProgress {
  // version は index.ts から注入する（RunProgress 内で package.json を読むと dev/prod で相対パスがズレる）。
  // 読み取り専用（readSnapshot 等）では省略可（append しないため）。
  constructor(
    private readonly store: RunStore,
    private readonly version?: string
  ) {}

  private eventsPath(runId: string): string {
    return join(this.store.runPath(runId), EVENTS_FILE);
  }
  private jsonPath(runId: string): string {
    return join(this.store.runPath(runId), JSON_FILE);
  }
  private mdPath(runId: string): string {
    return join(this.store.runPath(runId), MD_FILE);
  }

  // 進捗台帳（正本 events.jsonl と派生 json/md）を丸ごと削除する。
  // run を作り直すとき（import --force の置き換え）に、旧版の進捗履歴を残さないために使う。
  // 残すと aggregate の first-write-wins（editorModel / codeCheck）が旧値を引き継いでしまう。
  async reset(runId: string): Promise<void> {
    await rm(this.eventsPath(runId), { force: true });
    await rm(this.jsonPath(runId), { force: true });
    await rm(this.mdPath(runId), { force: true });
  }

  // 1イベント追記（append-only なので並行でも行が壊れにくい）。
  async append(runId: string, input: ProgressEventInput): Promise<void> {
    await this.appendMany(runId, [input]);
  }

  // 複数イベントをまとめて追記（アクション側で集約 → 最後に flush する用途）。
  async appendMany(runId: string, inputs: ProgressEventInput[]): Promise<void> {
    if (inputs.length === 0) {
      return;
    }
    const dir = this.store.runPath(runId);
    await mkdir(dir, { recursive: true });
    const body = inputs
      .map((input) => {
        // version は RunProgress が stamp（stripAt の後に置き、入力側の残骸を上書きしない）。
        const event: ProgressEvent = {
          at: input.at ?? new Date().toISOString(),
          runId,
          ...stripAt(input),
          version: this.version,
        };
        return JSON.stringify(withoutUndefined(event));
      })
      .join("\n");
    await appendFile(this.eventsPath(runId), `${body}\n`, "utf8");
  }

  // events.jsonl を読む（at 昇順に安定ソート。壊れた行はスキップして残りを活かす）。
  async readEvents(runId: string): Promise<ProgressEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.eventsPath(runId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const events: ProgressEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") {
        continue;
      }
      try {
        events.push(JSON.parse(trimmed) as ProgressEvent);
      } catch {
        // 壊れた行は無視（append-only なので末尾の書きかけ等を握りつぶす）。
      }
    }
    return events
      .map((e, i) => ({ e, i }))
      .sort((a, b) => (a.e.at === b.e.at ? a.i - b.i : a.e.at < b.e.at ? -1 : 1))
      .map(({ e }) => e);
  }

  // events から progress.json / progress.md を再生成して snapshot を返す。
  async regenerate(runId: string): Promise<ProgressSnapshot> {
    const events = await this.readEvents(runId);
    const snapshot = aggregate(runId, events);
    await mkdir(this.store.runPath(runId), { recursive: true });
    await writeFile(this.jsonPath(runId), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await writeFile(this.mdPath(runId), renderProgressMarkdown(snapshot), "utf8");
    return snapshot;
  }

  // 読む直前に再生成（events が progress.json より新しい / json 不在なら作り直す）。
  async readSnapshot(runId: string): Promise<ProgressSnapshot> {
    const eventsMtime = await mtime(this.eventsPath(runId));
    const jsonMtime = await mtime(this.jsonPath(runId));
    if (jsonMtime === undefined || eventsMtime === undefined || eventsMtime > jsonMtime) {
      return this.regenerate(runId);
    }
    const raw = await readFile(this.jsonPath(runId), "utf8");
    return JSON.parse(raw) as ProgressSnapshot;
  }
}

async function mtime(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

function stripAt(input: ProgressEventInput): Omit<ProgressEvent, "at" | "runId" | "version"> {
  const { at: _at, ...rest } = input;
  return rest;
}

function withoutUndefined(entry: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined));
}
