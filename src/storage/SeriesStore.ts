import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parse as parseYaml } from "yaml";
import { validateSlug } from "./meta";
import { withTrailingNewline } from "./RunStore";
import { validateGlossaryData, type GlossaryData } from "./glossaryMeta";
import {
  SERIES_FORMAT_VERSION,
  validateSeriesData,
  validateSeriesId,
  type SeriesData,
  type SeriesVoiceProvenance,
} from "./seriesMeta";

const SERIES_FILE = "series.json";
const VOICE_FILE = "voice.md";
const README_FILE = "README.md";
const GLOSSARY_FILE = "glossary.yaml";
const GLOSSARY_REPORT_FILE = "series-check-report.json";
// シリーズ単位ロックの置き場所（series root 直下・slug 衝突回避のため .locks は RESERVED_KEYS で予約）。
const LOCK_DIR = ".locks";
const LOCK_TIMEOUT_MS = 5000; // 取得待ちの上限。臨界区間は ms 想定なので十分。超過は奪取せずエラー。
const LOCK_RETRY_MS = 25; // 取得失敗時のリトライ間隔。

// 保存後 UTF-8（末尾改行正規化済み）に対する sha256 hex。RunStore.save とバイト等価の規則で
// hash を取るため withTrailingNewline を通す（series-c1-plan §5.3 / D2）。
export function voiceHash(content: string): string {
  return createHash("sha256").update(withTrailingNewline(content), "utf8").digest("hex");
}

// glossary.yaml の監査キー。voiceHash と同一規則（withTrailingNewline 後 UTF-8 の sha256 hex）だが、
// 対象は「パース前の生 YAML 文字列」＝ファイルそのもの（パース→再シリアライズの揺れを避ける・実装計画 T2）。
export function glossaryHash(rawYaml: string): string {
  return createHash("sha256").update(withTrailingNewline(rawYaml), "utf8").digest("hex");
}

// series/<slug>/ の read/write・voice 凍結・hash を担う。runs/ とは独立（RunStore は使わない）。
export class SeriesStore {
  private readonly root: string;

  constructor(root = "series") {
    this.root = resolve(root);
  }

  seriesPath(slug: string): string {
    const safe = validateSlug(slug);
    const candidate = resolve(this.root, safe);
    if (!isInside(this.root, candidate)) {
      throw new Error("Series path escapes series root");
    }
    return candidate;
  }

  private filePath(slug: string, fileName: string): string {
    if (fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) {
      throw new Error(`Invalid file name: ${fileName}`);
    }
    const candidate = resolve(join(this.seriesPath(slug), fileName));
    if (!isInside(this.seriesPath(slug), candidate)) {
      throw new Error("File path escapes series directory");
    }
    return candidate;
  }

  async exists(slug: string): Promise<boolean> {
    return access(this.filePath(slug, SERIES_FILE)).then(
      () => true,
      () => false
    );
  }

  // series.json を読む。不在は null、破損は validateSeriesData が throw（空扱いにしない）。
  async read(slug: string): Promise<SeriesData | null> {
    const raw = await readFile(this.filePath(slug, SERIES_FILE), "utf8").then(
      (c) => c,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return null;
        }
        throw error;
      }
    );
    if (raw === null) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Corrupt ${SERIES_FILE} (invalid JSON): ${this.filePath(slug, SERIES_FILE)}`);
    }
    return validateSeriesData(parsed, SERIES_FILE);
  }

  async write(slug: string, data: SeriesData): Promise<void> {
    await mkdir(this.seriesPath(slug), { recursive: true });
    await writeFile(this.filePath(slug, SERIES_FILE), withTrailingNewline(JSON.stringify(data, null, 2)), "utf8");
  }

  // シリーズ単位の排他ロック（series-spec §6.2 / 課題 C9）。並行 recordMember の
  // series.json read-modify-write を直列化して R1（order 二重採番）・R2（lost update）を防ぐ。
  // ロックは series 本体 series/<slug>/ ではなく series/.locks/<slug>.lock/ に置く:
  //   - 未作成シリーズでもロック取得が ENOENT にならず、本来の "Series not found" 経路に入れる。
  //   - ロック取得がシリーズ本体ディレクトリを副作用で作らない。
  // mkdir は存在時に失敗する atomic test-and-set。タイムアウトしたら奪取せずエラー（手動復旧）。
  async withLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    const safe = validateSlug(slug);
    const lockRoot = resolve(this.root, LOCK_DIR);
    if (!isInside(this.root, lockRoot)) {
      throw new Error("Lock path escapes series root");
    }
    const lockDir = join(lockRoot, `${safe}.lock`);
    await mkdir(lockRoot, { recursive: true });

    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        await mkdir(lockDir, { recursive: false });
        break; // 取得成功
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `Could not acquire series lock for "${safe}" within ${LOCK_TIMEOUT_MS}ms. ` +
              `別プロセスが記帳中か、異常終了でロックが残っています。残っている場合は手動で削除してください: ` +
              `rm -rf ${lockDir}`
          );
        }
        await sleep(LOCK_RETRY_MS);
      }
    }

    try {
      return await fn();
    } finally {
      // トークンファイルを置く設計でなくても recursive 削除で確実に消す。
      await rm(lockDir, { recursive: true, force: true });
    }
  }

  private async saveText(slug: string, fileName: string, content: string): Promise<void> {
    await mkdir(this.seriesPath(slug), { recursive: true });
    await writeFile(this.filePath(slug, fileName), withTrailingNewline(content), "utf8");
  }

  // 人が読む一覧（series:status --write・追加課題C）。series.json が正本で README は派生ビュー。
  async writeReadme(slug: string, content: string): Promise<string> {
    await this.saveText(slug, README_FILE, content);
    return this.seriesPath(slug);
  }

  // README.md が既にあるか（自動再生成を「一度 --write した束だけ」に限定する判定に使う）。
  async hasReadme(slug: string): Promise<boolean> {
    return access(this.filePath(slug, README_FILE)).then(
      () => true,
      () => false
    );
  }

  async readVoice(slug: string): Promise<string> {
    return readFile(this.filePath(slug, VOICE_FILE), "utf8");
  }

  // 履歴の voice ファイル（voice.md / voice-v<N>.md のみ許可）を安全に読む。
  // series.json が壊れて file に ../ 等が入っても、名前パターン＋filePath 検証で外に出さない。
  async readVoiceVersionFile(slug: string, file: string): Promise<string> {
    if (!/^voice(-v\d+)?\.md$/.test(file)) {
      throw new Error(`Unsafe voice file name: ${file}`);
    }
    return readFile(this.filePath(slug, file), "utf8");
  }

  // glossary.yaml を読む（series:check の正本・実装計画 T2）。不在は null（glossary 未設定のシリーズ）。
  // 生 YAML で hash を取ってから parse→validate する（hash 対象はファイルそのもの＝glossaryHash）。
  async readGlossary(slug: string): Promise<{ data: GlossaryData; hash: string } | null> {
    const raw = await readFile(this.filePath(slug, GLOSSARY_FILE), "utf8").then(
      (c) => c,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return null;
        }
        throw error;
      }
    );
    if (raw === null) {
      return null;
    }
    const hash = glossaryHash(raw);
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch {
      throw new Error(`Corrupt ${GLOSSARY_FILE} (invalid YAML): ${this.filePath(slug, GLOSSARY_FILE)}`);
    }
    return { data: validateGlossaryData(parsed, GLOSSARY_FILE), hash };
  }

  // series:check のレポートを書く（series.json が正本・レポートは派生／最新を上書き・実装計画 T4）。
  // 整形は series.json と同じ 2 スペースで固定し差分を安定させる。
  async writeGlossaryReport(slug: string, report: unknown): Promise<string> {
    await this.saveText(slug, GLOSSARY_REPORT_FILE, JSON.stringify(report, null, 2));
    return this.filePath(slug, GLOSSARY_REPORT_FILE);
  }

  // 枠を作る。series.json（未凍結）と空の voice.md を置く。既存があればエラー（--force 相当は将来）。
  async init(slug: string, profile: string, provenance: SeriesVoiceProvenance[] = []): Promise<SeriesData> {
    const seriesId = validateSeriesId(slug);
    if (await this.exists(slug)) {
      throw new Error(`Series already exists: ${slug} (remove series/${slug} to recreate)`);
    }
    const data: SeriesData = {
      version: SERIES_FORMAT_VERSION,
      seriesId,
      profile,
      voice: { frozen: false, version: 0, frozenAt: "", hash: "", history: [], provenance },
      members: [],
    };
    await this.write(slug, data);
    // 手書き用の空 placeholder（正規化せず真に空。create ゲートは空/空白のみを未記入扱いにする）。
    await writeFile(this.filePath(slug, VOICE_FILE), "", "utf8");
    return data;
  }

  // voice を凍結する（series-c1-plan §5.3）。
  // 初回（未凍結）: voice.md を凍結し version=1。再 freeze（凍結済み）: ① 現 voice.md を
  // voice-v<currentVersion>.md に退避 → ② 新 voice を voice.md に保存 → ③ version+1・history 更新。
  // newContent は CLI が解決した本文（初回は省略時 in-place の voice.md・再 freeze は別ファイル必須）。
  async freezeVoice(slug: string, newContent: string): Promise<SeriesData> {
    const data = await this.read(slug);
    if (!data) {
      throw new Error(`Series not initialized: ${slug} (run series:init first)`);
    }
    const now = new Date().toISOString();

    if (!data.voice.frozen) {
      // 初回凍結。
      await this.saveText(slug, VOICE_FILE, newContent);
      const hash = voiceHash(newContent);
      data.voice = {
        frozen: true,
        version: 1,
        frozenAt: now,
        hash,
        history: [{ version: 1, hash, file: VOICE_FILE }],
        provenance: data.voice.provenance,
      };
      await this.write(slug, data);
      return data;
    }

    // 再 freeze。同内容は no-op として拒否（無意味な version 増加を防ぐ）。
    const newHash = voiceHash(newContent);
    if (newHash === data.voice.hash) {
      throw new Error("Refusing to re-freeze identical voice content (no-op)");
    }
    const currentVersion = data.voice.version;
    const retiredFile = `voice-v${currentVersion}.md`;
    // ① 現 voice.md を退避（先に退避してから上書き）。
    const currentVoice = await this.readVoice(slug);
    await this.saveText(slug, retiredFile, currentVoice);
    // ② 新 voice を保存。
    await this.saveText(slug, VOICE_FILE, newContent);
    // ③ version+1・history 更新（旧版の file を退避先に付け替え、新版を末尾に）。
    const nextVersion = currentVersion + 1;
    const history = data.voice.history.map((h) =>
      h.version === currentVersion ? { ...h, file: retiredFile } : h
    );
    history.push({ version: nextVersion, hash: newHash, file: VOICE_FILE });
    data.voice = {
      ...data.voice,
      version: nextVersion,
      frozenAt: now,
      hash: newHash,
      history,
    };
    await this.write(slug, data);
    return data;
  }
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}
