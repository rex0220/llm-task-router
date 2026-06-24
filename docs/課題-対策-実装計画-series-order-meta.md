# 課題・対策・実装計画: series order が meta.json に記録されない

## 現象

`article:create --series <slug>` で `--order` を省略して記事を作成すると、
`runs/<runId>/meta.json` の `series.order` フィールドが欠落する。

### e2e で確認した事実

`2026-06-23-programming-languages-intro`（`--order` 省略で第3番目に追加）:

```jsonc
// series.json.members（正しく記録される）
{ "order": 3, "slug": "programming-languages-intro", "runId": "...", "status": "done" }

// meta.json の series フィールド（order が欠落）
{
  "series": {
    "seriesId": "programming-languages",
    "role": "article",
    "voiceVersion": 1,
    "voiceHash": "e37419da..."
    // order が無い
  }
}
```

### 二次的な影響

`series:status --fix` の reconcile コードが `series.order == null` の run をスキップする設計
（[src/cli/series.ts:82-83](../src/cli/series.ts)）のため、
この状態を自動修復できない。

---

## 原因

### 実行フローのトレース

`src/index.ts`（`article:create`）の処理順：

```
1. order = options.order != null ? Number(options.order) : undefined   // --order 省略時は undefined
2. series = buildSeriesMeta(seriesRead.data, order)                    // order が undefined のまま渡る
3. createQiitaArticle(..., { ..., series })                            // 内部で meta.json に書き出す
        ↓ JSON.stringify は undefined フィールドを出力しないため order が欠落
4. recordMember(options.series, result.runId, order)                   // create 成功後
        ↓ upsertMember 内で max(members.order) + 1 を自動採番
        ↓ series.json には order: 3 が書かれる
        ↓ しかし meta.json はもう書き済みで更新されない
```

### 核心

`upsertMember` が自動採番する order（`max + 1`）は `recordMember` の内部で初めて確定するが、
`buildSeriesMeta` はその**前**に呼ばれ、`undefined` を `RunSeriesMeta.order` に持ったまま
`createQiitaArticle`（内部で `store.create`／中間 `writeMeta`）がファイルに書き出す。
`--order` を明示した場合は両者に同じ値が渡るため問題が出ない。

### 関係するコード

| ファイル | 箇所 | 内容 |
|---|---|---|
| `src/index.ts` | L162 | `order` を `undefined` に初期化 |
| `src/index.ts` | L190 | `buildSeriesMeta(seriesRead.data, order)` — undefined を渡す |
| `src/index.ts` | L206-213 | `createQiitaArticle(..., { ..., series })` — 内部で meta.json を書き出す（`RunStore.create` 直接呼び出しは index にはない） |
| `src/index.ts` | L218 | `recordMember(...)` — ここで初めて自動採番が走る |
| `src/cli/series.ts` | L28 | `upsertMember` 内の自動採番ロジック |
| `src/cli/series.ts` | L82-83 | `series:status --fix` が `order == null` をスキップ |

---

## 対策

`recordMember` が最新の `series.json` から解決した order を返すようにし、
`index.ts` でその戻り値を使って `meta.json` を backpatch する。

`createQiitaArticle` は LLM 呼び出しを含むため長時間かかる。
`resolveOrder` を create **前**に呼ぶと、その間に並行 create や手動編集で order が増えた場合に
既存 order を上書きする危険がある。
`recordMember` は作成後に `series.json` を読み直してから `upsertMember` するため、
**create 後の最新状態で採番する方が安全**。

### 変更方針

1. `src/cli/series.ts` に `resolveOrder` ヘルパーを追加（`upsertMember` からロジックを抽出）
2. `recordMember` が採番後の order を返す（`Promise<number>`）
3. `src/index.ts` の `article:create` で `recordMember` の戻り値を使って `meta.json` を backpatch
4. `series:status --fix` で `series.order == null` の run を検出し、
   `series.json.members` の `runId` 逆引きで meta.json を補修（副次修正）

---

## 実装計画

### Step 1: `resolveOrder` ヘルパーを追加（`src/cli/series.ts`）

`upsertMember` の先頭にある採番計算を独立した関数に切り出す。

```typescript
// upsertMember の直前に追加（export は不要・recordMember からのみ呼ぶ）
function resolveOrder(members: SeriesMember[], order: number | undefined): number {
  return order ?? (members.reduce((max, m) => Math.max(max, m.order), 0) + 1);
}
```

`upsertMember` 内の採番行は `resolveOrder` を呼ぶ形に置き換える（重複排除）：

```typescript
export function upsertMember(
  members: SeriesMember[],
  entry: { order?: number; slug: string; runId: string }
): SeriesMember[] {
  const next = members.map((m) => ({ ...m }));
  const order = resolveOrder(next, entry.order);  // ← resolveOrder に委ねる
  // ... 以降は変更なし
}
```

### Step 2: `recordMember` が解決 order を返すよう変更し、`index.ts` で backpatch

`recordMember` を `Promise<void>` から `Promise<number>` に変更する（`src/cli/series.ts`）：

```typescript
// 変更前
export async function recordMember(
  slug: string,
  runId: string,
  order: number | undefined,
  seriesRoot?: string
): Promise<void> {
  // ...
  data.members = upsertMember(data.members, { order, slug: memberSlug, runId });
  await store.write(slug, data);
}

// 変更後
export async function recordMember(
  slug: string,
  runId: string,
  order: number | undefined,
  seriesRoot?: string
): Promise<number> {             // ← 解決済み order を返す
  // ...
  // upsert 前に order を確定させてから渡す（壊れた series.json に runId 重複があっても正しい値を返せる）
  const resolvedOrder = resolveOrder(data.members, order);
  data.members = upsertMember(data.members, { order: resolvedOrder, slug: memberSlug, runId });
  await store.write(slug, data);
  return resolvedOrder;
}
```

`src/index.ts` で戻り値を受け取り、`meta.json` を backpatch する：

```typescript
// 変更前
await recordMember(options.series, result.runId, order);
console.log(`series: ${options.series} (order ${order ?? "appended"})`);

// 変更後
const resolvedOrder = await recordMember(options.series, result.runId, order);
// meta.json の series.order を確定値で上書き（create 時点では undefined の可能性があるため）
const runStore = new RunStore();
const runMeta = await runStore.readMeta(result.runId);
if (runMeta.series) {
  runMeta.series.order = resolvedOrder;
  await runStore.writeMeta(runMeta);
}
console.log(`series: ${options.series} (order ${resolvedOrder})`);
```

`--order` を明示した場合は `resolvedOrder === order` になるため、backpatch は冪等。

### Step 3: `series:status --fix` の retrospective 補修（副次修正）

`series.json.members` に order が記録されているのに `meta.json` に欠落している run を補修する。

**修正箇所は `src/index.ts` の `--fix` ブロック**（`seriesStatus` 自体は read-only を維持）。
`seriesStatus` の返り値に `nullOrderRunIds` を追加し、`--fix` ブロックで RunStore を使って補修する。

#### `src/cli/series.ts`: `seriesStatus` の返り値に `nullOrderRunIds` を追加

```typescript
// 変更前の return 型
}: Promise<{
  data: SeriesData;
  members: SeriesMember[];
  conflicts: SeriesConflict[];
  warnings: string[];
}>

// 変更後
}: Promise<{
  data: SeriesData;
  members: SeriesMember[];
  conflicts: SeriesConflict[];
  warnings: string[];
  nullOrderRunIds: string[];   // series.order が欠落している run の一覧（retrospective 補修用）
}>
```

`reconcileMembers` の後、`nullOrderRunIds` を収集して return に追加：

```typescript
// reconcileMembers 呼び出しの直後に追加
// listSeriesRuns が既に seriesId 一致の run しか返さない（RunStore.ts:185）ので、
// seriesId フィルタは不要。order == null だけで足りる。
const nullOrderRunIds = runs
  .filter((r) => r.series?.order == null)
  .map((r) => r.runId);

return { data, members, conflicts, warnings, nullOrderRunIds };
```

#### `src/index.ts`: `--fix` ブロックに補修を追加

既存の `--fix` ブロックは `conflicts.length > 0` のときに members 書き込みをスキップする設計。
`nullOrderRunIds` の補修も**同じ条件（conflicts なし）でのみ実行**し、
かつ `result.data.members` に `runId` が**ちょうど1件**一致する場合だけ patch する：

```typescript
// 既存の members 修復ブロック内（conflicts なしの分岐）に追加
if (result.nullOrderRunIds.length > 0) {
  const runStore = new RunStore();  // RunStore は index.ts L87 で import 済み
  for (const runId of result.nullOrderRunIds) {
    const matched = result.data.members.filter((m) => m.runId === runId);
    if (matched.length !== 1) {
      // 一意でない場合はスキップ（衝突2 で検出済みのはずだが安全のため）
      process.stderr.write(`  ⚠ skip patch: runId ${runId} matched ${matched.length} members\n`);
      continue;
    }
    const meta = await runStore.readMeta(runId);
    if (meta.series) {
      meta.series.order = matched[0].order;
      await runStore.writeMeta(meta);
      const msg = `series:status --fix: patched meta.json series.order=${matched[0].order} for ${runId}`;
      options.json ? process.stderr.write(`${msg}\n`) : console.log(msg);
    }
  }
}
```

`RunStore` は `src/index.ts` L87 で既に import 済みのため追加不要。

### Step 4: `recordMember` の `series.json` 記帳を直列化（並行作成の競合対策・案B）

並行作成の競合（series-spec §6.2 / 課題 C9 の R1・R2）を、`recordMember` の read-modify-write を
シリーズ単位で排他して根絶する。**本バグ修正と同じ `recordMember` を触る**ので同時に入れるのが効率的。

- **臨界区間**: `recordMember` 内の「`store.read(slug)` → `resolveOrder`/`upsertMember` → `store.write(slug)`」。
  create 完了後の記帳のみで**ミリ秒**（LLM 生成中はロック非保持＝クラッシュで stale lock が残らない）。
- **排他手段**: クロスプラットフォーム原子操作の **`mkdir` ロック**を第一候補。
  ロックディレクトリの作成成否を test-and-set に使う（`mkdir` は存在時に失敗）。
  取得は短いポーリング＋タイムアウト、解放は `finally` で確実に削除。
- **ロックの置き場所（重要）**: **`series/.locks/<slug>.lock/`** に置く（`series/<slug>/` 配下ではない）。
  理由は2つ:
  - 親 `series/.locks/` は安定して存在させられる（`withSeriesLock` が起動時に一度だけ作る共有ディレクトリ）。
    `series/<slug>/` 配下に置くと、**シリーズ未作成時にロック取得が `ENOENT`** になり、
    本来の `store.read(slug) → null → "Series not found"` の通常エラー経路に入れない。
  - `withSeriesLock` が `series/<slug>/`（＝シリーズ本体ディレクトリ）を副作用で作ってしまうのを避ける。
    `.locks/` 配下ならロック取得がシリーズ本体の存在を変えない（未作成シリーズはそのまま `store.read` が null を返す）。
- **lock-root 名の予約（必須）**: `SAFE_ID = /^[A-Za-z0-9._-]+$/`（[src/storage/meta.ts:6](../src/storage/meta.ts)）は
  **先頭ドットを許可**し、`validateSafeId` も `.`/`..` 以外は弾かないため、**`.locks` という slug は valid**
  （予約キーにも未登録）。このままだと `series:init --slug .locks` でシリーズ本体 `series/.locks/` が
  lock-root `series/.locks/` と**同一パスで衝突**する（lock 専用ディレクトリに本物の `series.json` が同居）。
  → **lock-root 名（`.locks`）を `RESERVED_KEYS` に追加**して予約する。
  `series:init` は `validateSeriesId`（[seriesMeta.ts:48-50](../src/storage/seriesMeta.ts)）経由だが、これは
  `validateSlug` に委譲し `RESERVED_KEYS` を見るので、`series:init --slug .locks` も series.json 読込時の検証も両方で弾ける。
  ただし `RESERVED_KEYS` は **全 `validateSlug` 経路（member slug／export/index.json キー／記事 slug 全般）で予約**になる点に注意
  （`.locks` を slug にする実用ケースは無いので実害なし）。
  `series/` 配下である限りどんな lock-root 名も valid slug になり得るため、**名前選びでは回避できず予約が必須**。
- **ロックは `SeriesStore` のメソッドにする**: `store.withLock(slug, fn)` として `SeriesStore` 内に置き、
  ルート解決（`this.root`＝既定 `resolve("series")`／`seriesRoot` 指定時はそれ）を一元化する
  （自由関数で `seriesRoot` を取り回さない）。
- **stale lock の扱い（TOCTOU 回避）**: **自動奪取は既定で行わない**。タイムアウトしたら
  「別プロセスが記帳中か、異常終了でロックが残っている」とみなし**エラーで止め、手動復旧**に寄せる
  （臨界区間がミリ秒なので正常時に stale はまず起きない）。
  「古い lock を見て削除」する単純な自動奪取は **TOCTOU で危険**：古い lock を確認してから削除する直前に
  別プロセスが解放・再取得すると、後続の削除が**正当な新しい lock を壊す**。
  どうしても自動奪取を入れる場合は、ロックディレクトリ内に **`ownerToken` と `acquiredAt` を書き、
  削除の直前に同じ token を再検証**してから消す（CAS 風）。
  なお**ロック内にトークン等のファイルを置くと単純な `rmdir` では消せない**（空でないため）。
  解放・奪取は `rm(lockDir, { recursive: true, force: true })` 相当を使う（rmdir 前提にしない）。
- **手動復旧手順（明記）**: ms 窓の最中に SIGKILL／電源断が起きると `series/.locks/<slug>.lock/` が残り、
  **以後そのシリーズの全 create がブロック**される（正常時は起きないが、起きたら手で消す）。
  復旧は **`rm -rf series/.locks/<slug>.lock`**（トークンファイル設計でも recursive 削除で消える）。
  エラーメッセージにこの復旧コマンドを併記して運用者が迷わないようにする。
- **効果**: R1（二重採番）・R2（lost update）を根絶。後続 `recordMember` は前の write 済み `series.json`
  を読んで採番するため order が重複しない。
- **対象外**: R3（明示 `--order` の取り合い）はロックでは解けない（ユーザー誤り）→ `series:status` 衝突1で検出。

実装イメージ（`src/cli/series.ts`）：

ロックは `SeriesStore` のメソッド `store.withLock(slug, fn)` に一元化する
（ルート解決を `SeriesStore` 内に閉じ、自由関数で `seriesRoot` を取り回さない）。

```typescript
export async function recordMember(
  slug: string,
  runId: string,
  order: number | undefined,
  seriesRoot?: string
): Promise<number> {
  const store = new SeriesStore(seriesRoot);
  // ロックは series 本体ではなく series/.locks/<slug>.lock/ に取る（未作成シリーズでも ENOENT にしない）。
  return store.withLock(slug, async () => {   // ← read-modify-write 全体を排他
    const data = await store.read(slug);
    if (!data) {
      throw new Error(`Series not found: ${slug}`); // 未作成は通常エラー（ロック取得は成功している）
    }
    const memberSlug = validateSlug(memberSlugFromRunId(runId));
    const resolvedOrder = resolveOrder(data.members, order);
    data.members = upsertMember(data.members, { order: resolvedOrder, slug: memberSlug, runId });
    await store.write(slug, data);
    return resolvedOrder;
  });
}
```

`SeriesStore.withLock(slug, fn)`（`SeriesStore` 側に置くメソッド）の骨子:
1. `<root>/.locks/` を一度だけ `mkdir({ recursive: true })`（共有・冪等。`<root>` は `this.root`＝既定 `series`）。
2. `<root>/.locks/<slug>.lock/` を `mkdir({ recursive: false })` で作る。成功＝取得、失敗（EEXIST）＝
   短い間隔でリトライ。タイムアウトしたら**奪取せずエラー**（手動復旧コマンドを併記）。
3. `fn()` を実行し、`finally` でロックディレクトリを削除（トークンファイルを置く設計なら recursive 削除）。

`slug` は `validateSlug` 済みの安全文字種を使う（lock ディレクトリ名にもそのまま使える。`.locks` は予約済み）。

> 注: ロック対象は **`series.json` の記帳のみ**。`meta.json` の backpatch（Step 2）はロック外で問題ない
> （run ごとに別ファイルで競合しない）。

---

## テスト計画

既存の `tests/cli/series.test.ts` に追加するのが自然。

### 単体テスト（`recordMember` の返り値）

`recordMember` が解決した order を正しく返すことを確認する（`resolveOrder` は内部関数のため直接テストしない）。

| ケース | 入力 | 期待する戻り値 |
|---|---|---|
| 空の series + `order` 省略 | members=[], order=undefined | `1` |
| members=[1,2] + `order` 省略 | members=[{order:1},{order:2}], order=undefined | `3` |
| `order` 明示 | members=[{order:1}], order=5 | `5` |
| 既存スロット上書き | members=[{order:3, runId:"old"}], order=3 | `3` |

### 単体テスト（`seriesStatus` の `nullOrderRunIds`）

`series.order == null` の run を正しく検出することを確認する。

1. `series.order` が欠落した `meta.json` を持つ run を fixture として用意
2. `seriesStatus` を呼ぶ
3. `nullOrderRunIds` にその runId が含まれることを確認

### 統合テスト（`article:create --series` + backpatch）

`article:create` の呼び出しは重いため、`recordMember` + `RunStore.writeMeta` の連携を対象にする。

1. `recordMember` を呼ぶ（モック RunStore に series.json 相当を仕込む）
2. 戻り値の order で `runStore.writeMeta` を呼んだあと `readMeta` で確認
3. `meta.json` の `series.order` が解決済み order と一致することを確認

### 回帰テスト（`series:status --fix` の backpatch）

1. `series.order == null` の壊れた `meta.json` を持つ run を手動で用意
2. `series:status --fix` を実行
3. `meta.json` に `series.order` が補記されることを確認
4. `conflicts` があるケースでは補修が実行されないことを確認

### 並行テスト（`recordMember` の記帳直列化・案B）

**注意: 素の `Promise.all(recordMember(...))` だけでは検出力が弱い。** 実装が速いと read→write が
たまたま直列に流れ、**ロック無しでも偶然 pass** し得る（race を再現できていない）。
そこで次のいずれかで read と write の間に確実に重なりを作る：

- **遅延フック注入**: `store.read` 後・`store.write` 前に待たせる seam を仕込んだ fake/slow `SeriesStore` を使い、
  2 本の臨界区間を確実にオーバーラップさせる（ロック無し版で必ず R1/R2 が出ることをまず確認＝テストの妥当性検証）。
- **ストレステスト**: 同時 N 本（例 20〜50）× 多反復で `recordMember` を回し、統計的に race を炙り出す。

その上で：

1. 同一シリーズに対し `recordMember` を並行に複数呼ぶ（各 runId は別）
2. 全 settle 後に `series.json` を読み、**order の重複が無い**こと（R1 根絶）を確認
3. 全 runId の member が `series.json` に残っている（**lost update なし**＝R2 根絶）ことを確認
4. 各戻り値の order が互いに重複しない連番であることを確認
5. （妥当性）**ロックを外した版では遅延フック注入で R1/R2 が再現する**ことを確認し、テスト自体が race を
   捉えられている証跡にする

---

## 影響範囲

| 対象 | 変更の種類 | 後方互換 |
|---|---|---|
| `src/cli/series.ts` | `resolveOrder` 追加・`upsertMember` 内の採番を委譲 | ○（振る舞い変化なし） |
| `src/cli/series.ts` | `recordMember` の戻り値を `Promise<number>`（解決済み order）に変更 | ○（戻り値を無視する呼び出し元は影響なし） |
| `src/index.ts` | `recordMember` 戻り値で meta.json を backpatch・`--order` 明示時は冪等 | ○ |
| `src/cli/series.ts` | `seriesStatus` の返り値に `nullOrderRunIds` を追加 | ○（読み取り専用・副作用なし） |
| `src/index.ts` | `--fix` ブロックに meta.json 補修を追加（conflicts なし・1件一致時のみ） | ○（`--fix` なしは変化なし） |
| `src/cli/series.ts` / `src/storage/SeriesStore.ts` | `recordMember` の記帳を `SeriesStore.withLock`（`series/.locks/<slug>.lock/` の `mkdir` 原子ロック）で直列化。stale は自動奪取せずタイムアウト→エラー | ○（単発呼び出しはロック即取得で振る舞い不変） |
| `src/storage/meta.ts` | lock-root 名 `.locks` を `RESERVED_KEYS` に追加（**全 `validateSlug` 経路で予約**＝シリーズ slug／member slug／export/index.json キー／記事 slug すべてで禁止。lock-root 衝突回避） | ○（`.locks` を slug にする実用ケースは無い。既存に `.locks` があれば検証で検出） |
| 既存の run（`meta.json`） | `series:status --fix` で初めて補修される（自動実行はしない） | ○ |

---

## 追加課題（e2e 実行結果から）

`series/programming-languages`（総論＋JS＋Python の3本）の実走を codex がレビューし、
本バグ以外に2件の課題が見つかった。いずれも**総論の後挿し処理まわり**に集中している。

### 追加課題A: series 内 order が 0-based になっている（1-based 不変条件の違反）

#### 現象

`series/programming-languages/series.json` で総論 member が `order: 0`：

```jsonc
{ "order": 0, "slug": "programming-languages-intro", ... }  // 総論
{ "order": 1, "slug": "javascript-intro", ... }
{ "order": 2, "slug": "python-intro", ... }
```

#### 原因

CLI の `--order` は正の整数のみ受け付ける（[src/index.ts:163-164](../src/index.ts)
の `!Number.isInteger(order) || order < 1` で `0` を拒否）。
`RunSeriesMeta.order` も「1 始まり」前提（[src/storage/RunStore.ts:85](../src/storage/RunStore.ts)）。
つまり `order: 0` は CLI 経由では入らず、**手編集で混入**した 1-based 不変条件の違反。

一方 `series.json` 読み込み時の検証（[src/storage/seriesMeta.ts:131](../src/storage/seriesMeta.ts)）は
`typeof member.order !== "number"` しか見ておらず、**範囲（>= 1）を検査していない**ため素通りした。

#### 対策（採用方針: 総論=1, JS=2, Python=3 に繰り下げ）

読む順＝保存順を一致させ 1-based に正規化する。総論を `order: 1`、JS を `2`、Python を `3` に繰り下げる。

**注意: 単一ファイルの修正では済まない**。`series.json` だけ繰り下げても、`reconcileMembers` の
衝突1（order 重複検出）は **run meta 側（`r.series?.order`）だけ**を見るため、JS=1/Python=2 のままなら
重複は出ない（誤発火はしない）。真に危険なのは逆方向で、**`series:status --fix` が stale な run meta
（JS=1/Python=2）を正として `series.json.members` を上書きし、せっかく繰り下げた series 側（2/3）を
元に戻してしまう**こと。`--fix` の members 補修は「run meta → series.json」の向きなので、
series.json だけ直しても次の `--fix` で巻き戻る。

そのため **series.json + 3本の meta.json をまとめて更新する移行スクリプト**が必要：

| ファイル | 現 order | 新 order |
|---|---|---|
| `series.json` 総論 member | 0 | 1 |
| `series.json` JS member | 1 | 2 |
| `series.json` Python member | 2 | 3 |
| 総論 `meta.series.order` | （欠落） | 1 |
| JS `meta.series.order` | 1 | 2 |
| Python `meta.series.order` | 2 | 3 |

`order` は hash 保護値ではない（束内の順序＝表示・採番用）ため、meta.json の更新は安全。
本バグの `--fix` backpatch は「meta 欠落の補修」専用なので、この**横断リナンバリングには使わない**
（別の一回限りの移行として扱う）。

#### 再発防止（任意）

`series.json` 検証（`seriesMeta.ts`）に `member.order >= 1` の範囲チェックを足し、
0 以下を読み込み時に弾く。これで手編集での 0-based 混入を早期検出できる。

### 追加課題B: 総論の export だけ正規の front-matter 形式になっていない

#### 現象

`export/programming-languages-intro.md` は他2本と export 形式が揃っていない：

| 項目 | JS / Python | 総論 |
|---|---|---|
| ファイル名（`--out`） | `*-qiita.md` | `programming-languages-intro.md`（`-qiita` なし） |
| Qiita front matter | 先頭 `---`（title/tags 等）あり | **なし**（H1 から開始） |
| progress の export event | あり | **あり**（done・出力先と承認 note も記録済み） |

> 補足1: 総論にも progress の export event は存在する（`progress.json`/`progress.md` の `step:"export"` が
> done、出力先 `export/programming-languages-intro.md`、ユーザー承認 note 付き）。
> つまり `article:export` 自体は通っており、**問題は成果物が front matter 無し・素の `.md` 名なこと**。
> 補足2: `export/index.json`（公開台帳）に登録されているのは `node-env-file` と `moon` の2件だけで、
> **JS/Python/総論はいずれも未登録**。これは台帳が export とは別軸（→ 後述）であって、
> 「JS/Python は台帳にあるが総論だけ無い」わけではない。

#### 原因

総論も `article:export` 自体は通っている（progress に export event が done で残っている）。
問題は**実行時のオプションが他2本と違った**こと。
`article:export`（[src/index.ts:451](../src/index.ts)）は front matter を**自動付与しない**。
`--front-matter` を付けたときだけ profile に従って title/tags を前置し、本文 H1 を front matter へ移す。
JS/Python は `--front-matter` 付き（かつ `--out .../*-qiita.md`）で export されたが、
**総論は `--front-matter` なし・`--out` も素の `programming-languages-intro.md`** で実行されたため、
成果物に front matter が無く命名も揃っていない。
ファイル名の `-qiita` 有無は `--out` で渡すパスの違いにすぎない（CLI が自動で付けるサフィックスではない）。

なお `article:export` は `recordProgress(... step: "export")` を呼ぶだけで
（[src/index.ts:486](../src/index.ts)）、`RunStore.markDone` は呼ばない。
よって export の記録は **progress 側のイベント**（progress.md/progress.json）であって
`meta.json.steps` には載らない。総論にもこの export event はあり、出力先と承認 note まで記録されている
（＝event の有無ではなく、成果物の front matter／命名が note の Qiita 想定と食い違っているのが論点）。

**公開台帳（`export/index.json`）は `article:export` の責務ではない**。
台帳更新は `article:record-publication`（[src/index.ts:572](../src/index.ts)）が担う別工程で、
公開後に同一 URL の記録として書く。export と publication は分離されている。

#### 対策

2段階に分けて揃える：

1. **正規 export**: 総論を `article:export --front-matter --out <...-qiita.md>` で再 export する
   （編集長 GO ＋ ユーザー承認の通常フロー）。これで front matter 付与・統一した命名・
   progress の export event 記録が揃う。既存の素の `programming-languages-intro.md` は置き換え。
2. **公開台帳**（公開する場合のみ）: 公開後に `article:record-publication` で `export/index.json` に登録する。
   ただし JS/Python も未登録なので、台帳をどうするかは3本まとめての運用判断（総論固有の課題ではない）。

#### 注記

これはコード変更を伴わない**データ/運用の課題**（既存コマンドを正しいフラグ・順序で通すだけ）。
本バグや追加課題A のコード修正とは独立に実施できる。

### 追加課題C: シリーズの中身（作成済み／作成中）がディレクトリを見てもわからない

#### 現象

`series/programming-languages/` の中身は `series.json` と `voice.md` の2ファイルだけ。
どの記事が作成済み（done）か、どれが計画中（planned）か、何番目に何があるかを知るには
`series.json` を開いて `members` を読むか、`series:status --slug` を実行する必要がある。
**ディレクトリを開いただけでは一覧が把握できない**。

#### 原因

シリーズの一覧情報は `series.json`（機械可読の正本）にしか無く、人が一目で読める形の成果物が無い。
`series:status` は同じ情報を**コンソールに出すだけ**で、ファイルとして残らない。
また `members` は `order/slug/runId/status` のみ保持し、**記事タイトルを持たない**
（タイトルは各 run の `meta.json.articleTitle` 側）。一覧に題名を出すには run meta を読む必要がある。

#### 対策

`series/<slug>/README.md`（人が読む一覧）を機械生成する。`series.json`＝正本は不変、README は派生物。

- 新コマンド `series:index --slug <slug>`（または `series:status --write` 拡張）で
  `members` ＋ 各 run の `meta.json`（`articleTitle`／export 先など）を突き合わせて表を生成。
- 列は `order` / `status`（done｜planned）/ タイトル / slug / runId（／export 先があれば）。
- planned 枠（`runId: null`）は「未作成」と明示。
- 「`#` は保存順であり、記事タイトル上の回番号（「第N回」）とは一致しない場合がある」旨を脚注で明記
  （追加課題D の採番軸と同じ整理。総論は保存順 1 だがタイトルは「第0回」）。

**実装方式の選択（自動承認設定への影響）**: 編集長 Claude の自動承認は**2経路**ある。方式で改修箇所が変わる:

1. [templates/.claude/settings.json](../templates/.claude/settings.json) の allow リスト（**コマンド単位で列挙**＝
   `series:*` ワイルドカードではなく `series:init`/`series:freeze-voice`/`series:status` を個別許可）。
2. [templates/.claude/hooks/auto-approve-llm-task-router.mjs](../templates/.claude/hooks/auto-approve-llm-task-router.mjs) の
   `ALLOWED_SERIES_COMMANDS`（L22）。オペレーターが別ディレクトリから
   `bash -c 'cd "<記事フォルダー>" && llm-task-router series:...'` の**包み形**で実行する経路用
   （settings の前方一致が効かないケースを承認する）。`article:*` は接頭辞許可だが、
   **series は先取り承認を防ぐため明示コマンド名のみ**という設計（フック L9-10）。

| 方式 | settings.json | auto-approve フック | 改修箇所 |
|---|---|---|---|
| **`series:status --write` 拡張** | ✅ `series:status:*` でカバー（`:*` がフラグも含む） | ✅ `words[1]` は `series:status` のままで `ALLOWED_SERIES_COMMANDS` にヒット（`--write` は主コマンドを変えない） | **0（両経路とも無改修）** |
| **新コマンド `series:index`** | ❌ `Bash(llm-task-router series:index:*)` 追加が必要 | ❌ `ALLOWED_SERIES_COMMANDS` に `series:index` 追加が必要 | **2（settings ＋ フック）** |

→ 自動承認の運用をシンプルに保つなら **`series:status --write` 拡張が有利**（**機能面だけでなく承認運用も完全ゼロ改修**）。
新コマンドにする場合は **settings.json とフックの2箇所**に足すこと。**片方だけだと包み形（`bash -c 'cd … && llm-task-router series:index'`）でプロンプトが出る**
（実運用は別ディレクトリからの包み形が前提なので、フック漏れは「settings は通したのに承認が出る」になる）。
本計画はどちらも許容するが、既定の推奨は `series:status --write`。

> **README は `series:index` 実行時点のスナップショット（派生ビュー）として割り切る。**
> 「常に最新」を CLI が保証するわけではない。特に **export 先の列は `article:export` 後に初めて確定する**
> （export 先は `recordProgress(step:"export")` で progress に入る・[src/index.ts:486](../src/index.ts)）。
> `recordMember`（作成直後）の時点では export 先はまだ無いので、export 先まで反映したい場合は
> **`article:export` 後にも `series:index` を回す**必要がある。
> 再生成フックを `recordMember` / `--fix` に仕込むのは任意（members の増減は追従できるが export 先は追従しない）。
> 照合の主キーは引き続き `series.json` の `order/runId`。

#### 出力イメージ

```markdown
# シリーズ: programming-languages（profile: qiita / voice v1）

| # | 状態 | タイトル | slug | run |
|---|------|---------|------|-----|
| 1 | ✅ done | プログラミング言語ってどれくらい種類があるの？…【第0回・総論】 | programming-languages-intro | 2026-06-23-programming-languages-intro |
| 2 | ✅ done | JavaScriptってどんな言語？… | javascript-intro | 2026-06-23-javascript-intro |
| 3 | ✅ done | Pythonってどんな言語？… | python-intro | 2026-06-23-python-intro |
```

### 追加課題D: export ファイル名がシリーズ／話数を表していない

#### 現象

シリーズ3本の export 先は `javascript-intro-qiita.md` / `python-intro-qiita.md` /
`programming-languages-intro.md` で、**どのシリーズの何番目か**がファイル名から読み取れない。
`--out` を手で指定する運用のため、命名は人任せで揺れる（総論だけ `-qiita` 無し＝追加課題B）。

#### 原因

`article:export`（[src/index.ts:451](../src/index.ts)）の `--out` は **`requiredOption`（必須）**の手動指定で、
run が series メンバーでも**ファイル名へ series/order を反映する仕組みが無い**。
front matter（[src/cli/export.ts:164](../src/cli/export.ts) `withFrontMatter`）にも
series 情報は載っていない（title/tags のみ）。

#### 対策

run の `meta.series`（seriesId・order）＋ `series.json` の slug から既定ファイル名を導けるようにする。

**`--out` の必須を外す**（CLI 変更）。現行 `--out` は `requiredOption`（[src/index.ts:454](../src/index.ts)）なので、
自動命名モードと両立させるには **`requiredOption` → `option` に変更し、
「`--out` か `--out-dir` のどちらか必須」を action 内で検証**する（両方無ければエラー）。

- `article:export` に `--out-dir <dir>`（自動命名モード）を追加。指定時は
  `<dir>/<seriesId>-<NN>-<slug>[-<platform>].md` を自動命名して書き出す。
  例: `programming-languages-01-programming-languages-intro-qiita.md`。
  `--out` を明示したらそちらを優先（後方互換）。**`--out` と `--out-dir` 同時指定は `--out` を優先**
  （自動命名を無視して `--out` のパスへ書き出す）。
- **`NN` は `String(order).padStart(2, "0")`**（100 本以上は `100` のまま桁が伸びる）。
- **`<slug>` の出所は `series.json.members` の該当 `runId` から引く**（`memberSlugFromRunId(runId)` で
  runId から導く案もあるが、planned slug や手編集 slug と一致させるため members を正とする）。
  → 自動命名時は export が `SeriesStore` も読む（`meta.series.seriesId` でシリーズを引き、
  `members` から `runId` 一致の slug を取る）。member に該当が無ければエラー。
  → **前提: `seriesId` はディレクトリ slug と一致する**（現行 `series:init` が `seriesId = slug` で作るため
  `SeriesStore.read(slug)` にそのまま渡せる）。将来 `seriesId` とディレクトリ名がズレ得る設計にするなら、
  `seriesId → slug` の解決層を別途設ける必要がある（現状は不要）。
- 命名の order は **series 内の保存順（1-based・追加課題A 正規化後）**。
  記事タイトルの「第N回」と一致するとは限らない点に注意
  （総論は保存順 1 だがタイトルは「第0回」。表示名と採番軸が別物であることを README/注記で明示）。
- 併せて front matter にも series 情報（例 `series: <seriesId>` / `series_order: <N>`）を
  付けるかは媒体次第（Qiita/Zenn は標準キーが無いため任意・既定オフ）。

> オプション名は `--out-dir`（出力先ディレクトリ＝自動命名モード）とする。
> `--series-name` は「シリーズ名を指定する」と読めて意味がずれるため採らない。
>
> ファイル名の番号は「束の中の通し番号（保存順）」であって「第N回」表記ではない、という区別を明確にしておく。
> ファイル名は内部の安定した並び順、タイトルは読者向け表示、と分ける（本計画では保存順を採番軸とする）。

#### 注記

追加課題C・D は本バグ（order 欠落）や追加課題A（1-based 正規化）の**後**に着手するのが自然。
特に D のファイル名採番は order が正規化済みであることを前提にする。

### 推奨実施順

1. 本バグ修正（Step 1〜3: `recordMember` 戻り値 backpatch ＋ `--fix` 補修）＋ **Step 4: 記帳直列化（案B）** を
   実装・マージ（どちらも `recordMember` を触るので同時に入れる）
2. 追加課題A: series.json + 3 meta.json を 1-based に横断リナンバリング（移行スクリプト）
3. 追加課題A 再発防止: `seriesMeta.ts` に order 範囲チェック追加（任意）
4. 追加課題B: 総論を `article:export --front-matter` で再 export（公開するなら別途 `article:record-publication`）
5. 追加課題C: `series/<slug>/README.md` 生成（**推奨は `series:status --write` 拡張**＝自動承認2経路とも無改修。新コマンド `series:index` にするなら settings.json ＋ フック `ALLOWED_SERIES_COMMANDS` の2箇所追加が要る）
6. 追加課題D: `article:export --out-dir` で series/order を反映した自動命名（`--out` 必須を緩和）

> 順序の意図: 先にコードを直してから、データを正しい状態へ移行する。
> 2 を 1 より先にやると、`--fix` の挙動確認が不整合データ上になり検証がぶれる。
> C・D は order が 1-based に正規化された後でないと採番・一覧がぶれるため、A の後に置く。
> Step 4（記帳直列化）は本バグ修正と同じ `recordMember` 改修なので 1 にまとめる（仕様は series-spec §6.2 / C9）。
