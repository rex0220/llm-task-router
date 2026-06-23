# シリーズ第1段（科学シリーズ）実装計画 — C1

> ステータス: ドラフト（v1） / 対象: [series-spec.md](series-spec.md) の §10 第1段＋課題 C1 を実装に落とす計画
> 最終更新: 2026-06-23

## 1. 目的とスコープ

[series-spec.md](series-spec.md) の **第1段（科学シリーズ：同一文体・独立記事）**を実走可能にする最小縦切りを実装する。C1（spec §9）に集約された未確定事項を確定し、`series.json` スキーマ・`SeriesStore`・`series:init` / `series:freeze-voice` / `article:create --series` / `series:status` を作る。

### やること（第1段）
- `RunMeta.series`（spec §5.1）の型 ＋ 検証。
- `series/<slug>/` と `series.json`（spec §5.2、`history[]` 含む）の確定 ＋ `SeriesStore`。
- `series:init` / `series:freeze-voice` / `article:create --series` / `series:status [--fix]`。

### やらないこと（第2段以降）
- `series:plan` / 未作成枠の計画運用（テーマ分割＝第2段）。
- `chapter-state` 連続性（小説＝第3段）。
- voice 自動抽出 `series:extract-voice`（第4段）。

## 2. C1 で確定する設計判断（spec から持ち越した宿題）

| # | 論点 | 確定（この計画での採用） | 根拠 |
|---|---|---|---|
| D1 | `series.json` スキーマ | 封筒 `version` ＋ null プロトタイプ Record。`voice.history[]`・`members[]` を持つ（§4） | [ExportIndex.ts](../src/storage/ExportIndex.ts) 準拠 |
| D2 | `SeriesStore` の保存・hash | `RunStore.save` と同じ末尾改行正規化を行う共通 helper を切り、**保存後 UTF-8 の sha256(hex)** を hash とする | spec §5.3 / [RunStore.ts:144-147](../src/storage/RunStore.ts#L144-L147) |
| D3 | 再 freeze の `--voice-file` 省略禁止 | `frozen === true` の series への freeze は `--voice-file` 必須・`series/<slug>/voice.md` 自身は不可・同内容は no-op 拒否 | spec §5.3 |
| D4 | `history[]` と実ファイル hash の優先 | **実ファイル再計算 hash を検証正本**、`history[]` は索引（version→file の対応） | spec §6.1 |
| D5 | `meta.series` 確定タイミング | `store.create` 直後・`runQiitaArticle` 前。実装は ①（`createQiitaArticle` option 拡張）。または D6 | spec §10 実装メモ / [createQiitaArticle.ts:43-51](../src/workflows/createQiitaArticle.ts#L43-L51) |
| D6 | `meta.series` を初期 meta に同梱するか | `RunStore.create` に **optional `series?: RunSeriesMeta` 専用引数**を足し、**初期 `meta.json` に同時保存**する（汎用 `extraMeta` は不変条件を上書きし得るので採らない） | [RunStore.ts:110-131](../src/storage/RunStore.ts#L110-L131) |
| D7 | `series:status --fix` の衝突判定 | 多義的状態（§5 の4ケース）は修復せず警告列挙のみ | spec §6.1 |
| D8 | members upsert 規則（v1 は `series:plan` 無し） | `--order` 指定ありなら該当 order を upsert、なければ末尾 append。`slug` は最終 `runId` から日付 prefix を除いた safe slug（`--run` 明示時は `validateSlug` 必須・§4.1） | spec §6.1 |
| D9 | runs 横断スキャン API | `RunStore` に `listSeriesRuns(seriesId)`（`runs/*/meta.json` を列挙し `meta.series.seriesId` 一致を返す）を追加。`--fix` の source of truth | 現 RunStore に列挙 API 無し |
| D10 | `meta.style` 合成フォーマット | `profile.style` ＋ 空行 ＋ `# Series Voice` ＋ 空行 ＋ voice 本文、で固定 | spec §5.3 |

> D5/D6: 第1段は **D6（`RunStore.create` に optional `series?: RunSeriesMeta` 専用引数を渡し初期 meta に同梱）を採用**する。create と `meta.series` 確定が単一の書き込みで揃い、brief の中間 `writeMeta`（[728-733](../src/workflows/createQiitaArticle.ts#L728-L733)）が `readMeta` で引き継ぐため競合が原理的に起きない。汎用 `extraMeta` は `runId`/`steps`/`createdAt` 等の不変条件を誤って上書きし得るので採らない（必要になったら別判断）。`createQiitaArticle` の option に `series` を足して `store.create` へ素通しする。

## 3. モジュール構成

| ファイル | 追加/変更 | 役割 |
|---|---|---|
| [src/storage/RunStore.ts](../src/storage/RunStore.ts) | 変更 | `RunMeta.series` 型追加。`create()` に optional `series?: RunSeriesMeta`（初期 meta 同梱・D6）。`save` の改行正規化を helper 関数に抽出（`SeriesStore` と共有）。**`listSeriesRuns(seriesId)`（`runs/*/meta.json` 列挙→`meta.series.seriesId` 一致）を追加（D9・`--fix` の source of truth）。返り値は `{ runs: RunMeta[]; warnings: string[] }` 構造（console 出力は CLI 側・§8）** |
| `src/storage/SeriesStore.ts` | 新規 | `series/<slug>/` の read/write、`series.json` の read（ENOENT 空・破損は throw・null プロトタイプ）、voice ファイル保存＋hash、history 更新、members 突き合わせ |
| `src/storage/seriesMeta.ts` | 新規 | `series.json` の型・検証（`validateSeriesId`・voice/members スキーマガード）。`meta.ts` の `validateSafeId`/`validateSlug` を流用 |
| `src/workflows/createQiitaArticle.ts` | 変更 | `createArticle` 系の option に `series?` を足し `store.create` へ素通し（D5/D6） |
| [src/index.ts](../src/index.ts) | 変更 | `series:init` / `series:freeze-voice` / `series:status` の commander コマンド追加。`article:create` に `--series` / `--allow-profile-mismatch` option 追加 |
| `src/cli/series*.ts` | 新規 | 各 series サブコマンドの action 実体（index.ts から薄く呼ぶ既存パターン） |

## 4. `series.json` スキーマ（D1 確定）

```jsonc
{
  "version": 1,                         // 封筒（INDEX_FORMAT_VERSION 同様の定数）
  "seriesId": "kagaku-2026",            // validateSlug 相当（予約キー拒否込み・§4 ガード）
  "profile": "qiita",
  "voice": {
    "frozen": true,
    "version": 2,                        // 現行版。run 側 meta.series.voiceVersion と対応
    "frozenAt": "2026-06-23T...",
    "hash": "<sha256hex>",               // 現行 voice.md（保存後 UTF-8）の hash
    "history": [                         // 索引（検証正本は実ファイル再計算・D4）
      { "version": 1, "hash": "...", "file": "voice-v1.md" },
      { "version": 2, "hash": "...", "file": "voice.md" }
    ],
    "provenance": [                      // 出所の集約（手書き/exemplar/外部）
      { "kind": "handwritten" }
    ]
  },
  "members": [                           // null プロトタイプではなく配列（順序が意味を持つ）
    { "order": 1, "slug": "...", "runId": "2026-06-23-...", "status": "done" },
    { "order": 2, "slug": "...", "runId": null, "status": "planned" }
  ]
}
```

検証ガード（`seriesMeta.ts`）:
- **`seriesId` は `validateSlug` 相当**（予約キー `__proto__`/`constructor`/`prototype` も拒否。`series/<slug>/` の識別子かつ status 集計でキーになり得るため。`validateSafeId` 単体は予約キーを弾かない＝[meta.ts:18-24](../src/storage/meta.ts#L18-L24)）。`members[].slug` も `validateSlug`、`runId` は `validateSafeId`（null 許容）。
- `voice.version` と `history[].version` の整合（現行版が history 末尾に存在）。
- 破損 JSON・非オブジェクトは throw（空扱いで他データを失わせない＝ExportIndex と同方針）。

### 4.1 members の upsert 規則（D8・v1 は `series:plan` 無し）

`article:create --series` 成功後（`meta.series` 確定後）に `series.json.members` を更新する:
- `--order N` 指定ありなら **該当 order の枠を upsert**（既存 planned 枠を runId/status で埋める。無ければその order で新規）。
- `--order` 無しなら **末尾 append**（既存 order の最大値+1 を採番）。
- `slug` は **raw な basename/topic ではなく、正規化済みの safe slug を使う**。具体的には **最終 `runId` から先頭の日付 prefix（`YYYY-MM-DD-`）を除いた部分**を slug とする。`createRunId` 採番なら [createRunId](../src/workflows/createQiitaArticle.ts#L768-L777) が `toLowerCase`→非英数字を `-` 化→trim→40字で生成するため `[a-z0-9-]` のみで `validateSlug` を必ず通る（日本語・空白・記号を含む topic/file 名でも落ちない）。
- **`--run` 明示時は `createRunId` を通らないため `[a-z0-9-]` とは限らない**（`2026-06-23-__proto__` のように runId としては通るが member slug としては拒否すべき値があり得る）。そこで **prefix 除去後の slug を必ず `validateSlug` し、失敗したら `article:create --series` を拒否**する（不正 slug を members に入れない）。
- `status` は作成完了で `done`、runId を記録。

> **slug は表示・補助識別子で、照合の主キーは `order` / `runId`**。日本語など非英数字のみの topic は [createRunId](../src/workflows/createQiitaArticle.ts#L768-L777) の slug が空→フォールバック `article` になり、日付違いの別記事で **member slug が衝突し得る**。これは upsert/照合では問題にしない（主キーは order と runId）。ただし `series:status` は **同一シリーズ内で slug が重複する members を warning として列挙**する（人が見分けにくいため。修復はしない＝§5 の方針と同様）。

### 4.2 `meta.style` の合成フォーマット（D10）

実装差・テストブレを避けるため固定する:

```text
<profile.style>

# Series Voice

<voice.md 本文>
```

`profile.style` が空なら先頭の本文と空行は省き `# Series Voice` から始める。voice 本文は `series/<slug>/voice.md`（凍結済み・現行版）の内容。

## 5. `series:status --fix` の衝突判定（D7 確定）

`--fix` は run 側（`meta.series`）を正として `series.json.members` を埋め直す（spec §6.1）。次の多義的状態は**修復せず警告列挙のみ**:

1. 同一 `seriesId` で `order` 重複の run が複数。
2. 同じ `runId` が複数 member 枠に載る。
3. planned 枠の `slug` と run の runId 由来 slug（§4.1：runId から日付 prefix を除いた safe slug）が食い違う。
4. `meta.series.voiceHash` が、その run の `voiceVersion` に対応する voice ファイルの**実再計算 hash**（D4）と不一致／対応 version の voice ファイル欠落。

既定（`--fix` なし）は dry-run 表示。集計（進捗・概算コスト・残枠）は各 run の `progress.json` を横断して読むだけ。

## 6. 実装順序（縦切り・各ステップでテスト）

1. **型と検証**: `RunMeta.series` 追加（[RunStore.ts](../src/storage/RunStore.ts)）＋ `seriesMeta.ts`（series.json 型・ガード。`seriesId` は予約キー拒否込み＝§4）。unit テスト（ガードの正常／プロトタイプ汚染／破損）。
2. **SeriesStore ＋ 列挙 API**: `save` の改行正規化 helper を `RunStore` から抽出し共有 → `SeriesStore` で voice 保存＋hash＋`series.json` read/write＋history 更新。`RunStore.listSeriesRuns(seriesId)` を追加（D9）。unit テスト（hash の決定性・末尾改行差で不変・再 freeze の退避順序 D3・列挙の seriesId フィルタ）。
3. **`series:init` / `series:freeze-voice`**: CLI ＋ action。freeze の first-write-wins・再 freeze 必須条件（D3）・history 更新（D4）。
4. **`article:create --series`**: `RunStore.create` に optional `series?: RunSeriesMeta`（D6）→ `createQiitaArticle` option 素通し。CLI で voice.md を読み `meta.style` を §4.2 のフォーマットで合成、拒否条件（未凍結／voice 空／profile mismatch）。create 成功後に §4.1 の規則で `series.json.members` を upsert（D8）。
5. **`series:status [--fix]`**: `listSeriesRuns` で run を集め集計表示 ＋ `--fix` 修復（D7 の衝突は警告のみ）。
6. **実走テスト**: 科学シリーズ2本を同一 voice で作成 → 2本目の `meta.style` に voice が焼かれ、`voiceHash` が history と一致、`series.json.members` が2枠 done になることを確認。

## 7. テスト方針

- **unit**: `seriesMeta` ガード、`SeriesStore` の hash 決定性・退避順序、status の衝突検出（4ケース）。
- **統合（mock router）**: `article:create --series` が `meta.series`（voiceVersion/Hash）と `meta.style`（合成 style）を初期 meta に同梱し、brief の writeMeta 後も残ること（D5/D6 の競合回避を回帰テスト化）。**fixture response を使い、final 本文のバイト一致は検証しない**（実モデルは非決定的＝§9.5）。検証対象は渡した引数・meta・分岐。
- **拒否系**: 未凍結 series で create 拒否、再 freeze の `--voice-file` 省略／voice.md 自身指定の拒否、profile mismatch 拒否。

## 8. リスクと留意点

- **D6（`RunStore.create` の option 拡張）は他の呼び出し（import 等）に影響しないこと**を確認する（optional・既定 undefined で従来挙動）。汎用 `extraMeta` は不変条件（runId/steps/createdAt）の誤上書き面が広いので採らず、`series?` 専用引数に絞る。
- **`listSeriesRuns`（D9）は `runs/*` を全列挙して `meta.json` を読む**。run 数が増えると線形コスト。第1段は素朴実装でよい。`meta.json` 読込失敗（壊れ run）は握り潰さず全体も止めず、**`{ runs, warnings }` 構造で返す**（`RunStore` は console 出力しない＝テスト容易・責務分離。表示は CLI 側）。
- 改行正規化 helper の抽出で `RunStore.save` の既存挙動を変えない（リファクタの回帰に注意）。
- `series/` は `runs/` の外。パスエスケープ検証を `SeriesStore` 側で `RunStore` 同様に持つ（slug を `validateSlug`）。
- voice 焼き込みは create のみ。**既存の `--editor-model`/`--code-check` と同じ first-write-wins**で、後から series を付け替える経路は第1段では作らない（救済は将来）。

## 9. 受け入れ基準（第1段 Done の定義）

- `series:init` → `series:freeze-voice`（手書き voice.md）→ `article:create --series` ×2 → `series:status` が一連で通る。
- 2記事の `meta.style` に同一 voice が焼かれ、`meta.series.voiceHash` が `series.json.voice.history[]` の対応版と一致。
- 各記事は従来の9段ゲート（factcheck/verify-artifacts 等）を**従来どおり**通せる（シリーズ化で工程順が変わらない）。
- 拒否系（未凍結・profile mismatch・再 freeze 必須条件）が期待どおり失敗する。

## 9.5 既存の1記事作成への影響（非回帰の確認）

第1段は **既存の単記事フロー（`article:create`（`--series` なし）/ `resume` / `refine` / `evaluate` / `revise` / `import` / `export` 等）を変えない**ことを前提に設計する。変更面ごとの影響:

| 変更 | 既存への影響 | 担保 |
|---|---|---|
| `RunMeta.series?` 追加（optional） | なし。`readMeta` は無検証 `JSON.parse`（[RunStore.ts:133-136](../src/storage/RunStore.ts#L133-L136)）で、既存 run は当該フィールドが `undefined` になるだけ | optional フィールド。既存 meta.json をマイグレーション不要 |
| `RunStore.create` に optional `series?` | なし。**引数は末尾に追加**し既定 `undefined`。既存呼び出し（[createQiitaArticle.ts:43](../src/workflows/createQiitaArticle.ts#L43) / [import.ts:124](../src/cli/import.ts#L124)）は `profile` までで止まるため挙動不変 | 位置引数を**並べ替えない**（末尾追加のみ）。並べ替えると positional 呼び出しが壊れる |
| `save` の改行正規化 helper 抽出 | **唯一の実質的な回帰面**。`save` は約30か所で使われる共有経路。挙動（`endsWith("\n") ? content : content+"\n"`）を**バイト等価で**保つ純リファクタにする | §7 の回帰テスト（下記）。リファクタで出力を1バイトも変えない |
| `createQiitaArticle` の option `series?` | なし。`--series` 未指定なら従来どおり `style: profile.style` を渡す経路に分岐しない | option 既定 `undefined`。voice 合成・members 更新は `--series` 指定時のみ |
| `article:create` に `--series`/`--allow-profile-mismatch` | なし。commander option は未指定で `undefined`。既存の no-series 経路（[index.ts:159-166](../src/index.ts#L159-L166)）を**バイト等価で**残す | `--series` 指定時だけ voice 合成・拒否条件・members 更新へ分岐 |
| 新規ファイル（`SeriesStore` / `seriesMeta` / `cli/series*`）・`listSeriesRuns` | なし。すべて加算的。既存経路から呼ばれない | — |

**結論**: `--series` を付けない限り既存の1記事作成は**機能的に不変**。唯一の回帰面は「`save` の改行正規化 helper 抽出」（全工程が依存する共有経路）で、ここはバイト等価リファクタに徹し、回帰テストで守る。

**回帰テスト（§7 に追加）**:
- `save` の helper 抽出前後で、末尾改行あり/なし・空文字・複数行の各入力に対し**保存後バイト列が一致**する unit テスト（冪等性・1バイトも変えない）。
- **mock router / fixture response** で `article:create`（`--series` なし）の分岐が、従来と**同じ `style`（`profile.style`）と meta** を `createQiitaArticle`/`store.create` に渡すことを検証（実モデルの final 出力はバイト比較しない＝非決定的なため）。
- `RunStore.create` を `series` 無しで呼んだとき、生成 meta.json に `series` キーが**現れない**こと（`undefined` を書き込まない）。
- 実走テスト（任意・実モデル）は **final のバイト一致ではなく、`meta.json` に `series` が未出現・9段工程が完走すること**を見る程度にとどめる。

---

## 付録: Codex レビュー反映ログ（2026-06-23）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| `article:create --series` 後の members 更新規則（append/upsert/slug 由来）が未確定で実装者が止まる | P1 | §4.1 / D8 で「`--order` ありは該当 order を upsert・無しは末尾 append・slug は最終 runId から日付 prefix を除いた safe slug」を確定 |
| `--fix` の source of truth に必要な runs 横断列挙 API が現 RunStore に無い | P1 | §3 / §6 / D9 で `RunStore.listSeriesRuns(seriesId)` を追加 |
| `RunStore.create` の `extraMeta` は広すぎ（不変条件の誤上書き面） | P2 | D6 / §3 / §8 を `series?: RunSeriesMeta` 専用引数に絞る。汎用 extraMeta は不採用 |
| `seriesId` が `validateSafeId` だと予約キー（`__proto__` 等）を弾けない | P2 | §4 で `seriesId` を `validateSlug` 相当（予約キー拒否込み）に |
| `meta.style` 合成フォーマット未定でテストがブレる | P3 | §4.2 / D10 で「`profile.style` ＋ 空行 ＋ `# Series Voice` ＋ 空行 ＋ voice 本文」に固定 |

## 付録: Codex レビュー反映ログ（2026-06-23・第 2 巡）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| members `slug` を raw basename/topic にすると日本語・空白・記号で `validateSlug` に落ちる | P1 | §4.1 を「最終 `runId` から日付 prefix を除いた safe slug（[createRunId](../src/workflows/createQiitaArticle.ts#L768-L777) の正規化結果）」に確定。raw は使わない |
| `listSeriesRuns` の warning 返却方法が未定（RunStore が console 出力すると責務濁る） | P2 | §3 / §8 で返り値を `{ runs, warnings }` 構造に。表示は CLI 側 |
| JSON 例コメント `seriesId // validateSafeId` が本文の `validateSlug 相当` と食い違い | P3 | §4 の JSON コメントを `validateSlug 相当（予約キー拒否込み）` に訂正 |

## 付録: Codex レビュー反映ログ（2026-06-23・第 3 巡）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| `--run` 明示時は `createRunId` を通らず slug が `[a-z0-9-]` とは限らない（`__proto__` 等が混入し得る） | P1 | §4.1 で「prefix 除去後に必ず `validateSlug`、失敗したら create 拒否」を明記 |
| §5 衝突判定3が「topic 由来 slug」と古い（slug 正本は runId 由来に変更済み） | P2 | §5 を「runId 由来 slug」に統一 |
| D8 要約行・第1巡ログの「topic-file basename / runId seed 由来」が §4.1 と矛盾 | P3 | D8 と第1巡ログを「最終 runId から日付 prefix を除いた safe slug」に更新 |

## 付録: Codex レビュー反映ログ（2026-06-23・第 4 巡）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| 実モデルで `final.md` バイト一致は非決定的でテスト条件として強すぎ | P2 | §7 / §9.5 を「mock router/fixture で no-series 分岐の style・meta・引数を検証。実走は series 未出現・工程完走を見る程度」に現実化 |
| 日本語 topic は slug が `article` になり日付違いで member slug が重複し得る | P3 | §4.1 に「slug は表示・補助識別子、照合主キーは order/runId。重複 slug は `series:status` の warning」を明記 |

## 付録: 第2段以降への申し送り

- **第2段（テーマ分割）**: `series:plan` ＋ `members[].status: "planned"` の運用。非重複は人手（spec C5）。スキーマは第1段で `members[]` に planned 枠を許しているので前方互換。
- **第3段（小説）**: `role: "chapter"` ＋ `chapter-state.json` 引き継ぎ。状態書き戻しの担当（spec C6）を別途設計。
- **第4段**: voice 自動抽出（C2）・voice 逸脱検出（C4）・機械 dedup（C5）。
