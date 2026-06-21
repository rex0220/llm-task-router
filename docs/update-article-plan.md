# 既存記事の更新リライト 実装計画

> 対象仕様: [update-article-spec.md](update-article-spec.md)（採用 v3）
> 作成日: 2026-06-19
> 方針: 仕様 §10 の段階的導入に沿って、既存プリミティブ（import 往復ループ）を定型運用へ昇格する。新規発明は最小に留め、**正本3つの固定**（版＝`update-base.md` / 公開先＝`published` / 系譜＝`lineage`）を CLI 側に寄せる。

---

## 0. 現行コードのアンカー（変更起点）

実装前に確認済みの事実と、触る場所。

| 領域 | 現状 | ファイル |
|---|---|---|
| RunMeta 型 | `published` / `lineage` なし。`readMeta` は `JSON.parse` のみで**検証なし**。`writeMeta` は毎回 `updatedAt` を現在時刻で上書き。 | [src/storage/RunStore.ts:59-71](../src/storage/RunStore.ts#L59-L71), [src/storage/RunStore.ts:103-112](../src/storage/RunStore.ts#L103-L112) |
| import | `final.md` を保存し `imported:true` を立てる。`update-base.md` は作らない。`--force` 掃除リスト `staleArtifacts` あり。lineage 入力なし。 | [src/cli/import.ts:59-117](../src/cli/import.ts#L59-L117), [src/cli/import.ts:28-45](../src/cli/import.ts#L28-L45) |
| export | `final.md` を指定パスへコピーするのみ。meta 更新なし（F2）。 | [src/cli/export.ts:9-32](../src/cli/export.ts#L9-L32) |
| revise | 既定で `final.bak.md` を毎回上書き（F1）。 | [src/workflows/createQiitaArticle.ts:82-97](../src/workflows/createQiitaArticle.ts#L82-L97) |
| CLI 配線 | commander で各 `article:*` を登録。`createRuntime` / `resolveText` / 進捗 reporter を共有。 | [src/index.ts](../src/index.ts) |
| 配布 | スキル/エージェントは `templates/.claude/` を `init` が展開。allowlist は `templates/.claude/settings.json`。 | [src/cli/init.ts:51-57](../src/cli/init.ts#L51-L57), [templates/.claude/settings.json](../templates/.claude/settings.json) |
| テスト | `tests/cli` `tests/storage` `tests/workflows` に vitest。`npm test` は build 込み。 | tests/ |

---

## 1. ワークストリーム一覧

| WS | 内容 | 仕様 | 段階 |
|---|---|---|---|
| WS1 | `RunMeta` に `published?` / `lineage?` を型追加＋検証 | §5.1 §5.2 §3 F3 | 第1段 |
| WS2 | import 時の `update-base.md` 固定保存＋`lineage` 記録 | §5.3 §6 フェーズ2 | 第1段 |
| WS3 | `export/index.json` 台帳の read/write ヘルパ | §5.5 | 第1段 |
| WS4 | 新コマンド `article:record-publication`（`published`＋台帳の同時更新） | §6.2 | 第1段 |
| WS5 | 差分成果物 `update-diff.md` / `changed-sections.json` の生成 | §5.4 §6 フェーズ4 | 第2段 |
| WS6 | スキル `/update-article` 新設＋エージェント/allowlist/手順書の更新 | §7 §6 | 第2段 |
| WS7 | 棚卸し自動化（候補スコアリング・リリースノート監視） | §10 第3段 | 第3段（将来） |

実装順は **WS1 → WS2 → WS3 → WS4**（第1段）を先に固め、CLI とテストで土台を確定してから **WS5 → WS6**（第2段）。WS7 は別途。

---

## 2. 第1段（基盤）

### WS1: `RunMeta` の型追加と検証

**ファイル**: [src/storage/RunStore.ts](../src/storage/RunStore.ts)

1. 型を追加（§5.1 §5.2 のとおり責務分離）:

```ts
export type PublishedMeta = {
  url: string;
  articleId: string;
  version: number;      // 公開記事としての版番号（>=1）
  updatedAt: string;    // 公開更新時刻（meta.updatedAt とは別。ファイル mtime ではなく公開時刻）
};

export type LineageMeta = {
  supersedesRunId?: string;  // 直前の起点 run
  rootRunId?: string;        // 系譜の根（初版 run）
  sourceExportPath?: string; // import 元
};

export type RunMeta = {
  // ...既存...
  published?: PublishedMeta;
  lineage?: LineageMeta;
};
```

2. **検証の導入**: 現状 `readMeta` は無検証。`published`/`lineage` を CLI 所有にする以上、書き込み経路（`record-publication`）で値を検証する関数を `RunStore` か新規 `src/storage/meta.ts` に置く。
   - `url`: 非空・`http(s)://` で始まる。
   - `articleId`: 非空・`runId` と同じ文字種ガード（`/^[A-Za-z0-9._-]+$/` 流用可）。
   - `version`: 整数・`>=1`。
   - `updatedAt`: ISO 文字列。
   - 注意: `writeMeta` は `updatedAt`（メタのファイル更新時刻）を毎回上書きする（[RunStore.ts:109](../src/storage/RunStore.ts#L109)）。`published.updatedAt` はこれと**別物**として保持されるため衝突しない。

**テスト**（`tests/storage/RunStore.test.ts`）: `published`/`lineage` を含む meta の round-trip、検証関数の正常/異常系。

### WS2: import 時の `update-base.md` 固定保存＋lineage 記録

**ファイル**: [src/cli/import.ts](../src/cli/import.ts), [src/index.ts](../src/index.ts)（`article:import` の option 追加）

1. `importArticle` で `final.md` 保存の直後に **`update-base.md` を同内容で固定保存**（[import.ts:110](../src/cli/import.ts#L110) の隣）。一度書いたら更新フロー中は不変（§5.3）。
2. `ImportArticleOptions` に lineage 入力を追加し、与えられたら `meta.lineage` を記録:
   - `sourceExportPath`: 既定で `--from` の値（import 元）。
   - `supersedesRunId` / `rootRunId`: 新フラグ `--supersedes <runId>` / `--root <runId>`（任意）。`/update-article` が台帳から解決して渡す。
3. `staleArtifacts`（[import.ts:28-45](../src/cli/import.ts#L28-L45)）に **`update-base.md` を追加**。`--force` 再 import で版の正本も作り直す。
4. `update-base.md` を「全 import で書く」か「更新フロー時のみ」か → **全 import で書く**ことを推奨（コピー1回で安価、通常ブラッシュアップでも回帰起点になる）。§8 の区分は「新規・必須」。

**テスト**（`tests/cli/import.test.ts`）: import 後に `update-base.md` が `final.md` と一致する／`--supersedes`/`--root` 指定で `meta.lineage` が入る／`--force` で `update-base.md` が再生成される。

### WS3: `export/index.json` 台帳ヘルパ

**新規ファイル**: `src/storage/ExportIndex.ts`

slug → 最新 run / 公開 URL の逆引き台帳（§5.5）。v3 では `export/index.json` 一本化（sidecar は採らない）。

```jsonc
// export/index.json
{
  "version": 1,
  "articles": {
    "<slug>": {
      "runId": "2026-06-19-...",
      "url": "https://qiita.com/.../items/xxxx",
      "articleId": "xxxx",
      "version": 2,
      "updatedAt": "2026-06-19T..."
    }
  }
}
```

- API: `readIndex()`（無ければ空を返す）, `upsert(slug, entry)`, `resolve(slug)`。
- パスは `export/index.json` 固定（cwd 基準）。`assertSafeOutputPath` 相当のガードを通す。書式は `JSON.stringify(_, null, 2) + "\n"`（既存 meta と統一）。
- **slug 検証（必須）**: slug は JSON object のキーになるため、空文字・パス風文字列・プロトタイプ汚染（`__proto__` / `constructor` / `prototype`）を拒否する。`runId` と同じ安全文字種 `/^[A-Za-z0-9._-]+$/`（[RunStore.validateRunId](../src/storage/RunStore.ts#L155) 相当）に寄せ、`.`/`..` も弾く。`articles` オブジェクトは `Object.create(null)` で扱い、継承キーの混入を防ぐ。
- **version 退行ガード（必須・冪等性と両立）**: 同一 slug の `upsert` は次の3分岐で判定する（「退行禁止」と「冪等な再実行」を両立させる）:
  1. **完全一致**（既存エントリの `runId`/`url`/`articleId`/`version` がすべて新値と同一）→ **no-op として許可**。`updatedAt` も含め index を書き換えない（成功後の同一コマンド再実行が reject されないため）。
  2. `newVersion > oldVersion` → 通常更新。
  3. それ以外（`newVersion <= oldVersion` かつ完全一致でない）→ `--force` 無しでは reject、`--force` 付きで許可（意図的な訂正のみ）。

**テスト**（`tests/storage/ExportIndex.test.ts`）: 新規作成・upsert・resolve・不在 slug。

### WS4: `article:record-publication`

**新規ファイル**: `src/cli/record-publication.ts`、配線は [src/index.ts](../src/index.ts)

責務（§6.2）: `runs/<id>/meta.json` の `published`（WS1）と `export/index.json`（WS3）を**同時更新**する「公開台帳更新」。export とは別ステップ（F2 を崩さない）。

```sh
llm-task-router article:record-publication \
  --run <id> --slug <slug> --url <url> --article-id <articleId> --article-version <n> [--force]
```

> 注: 公開版番号のフラグは `--article-version`。CLI 全体の `-v, --version`（version 表示）と衝突するため、`--version` は使えない（spec §6.2 の `--version` を実装ではリネーム）。

処理（**検証フェーズと書き込みフェーズを分離する**）:
1. **検証フェーズ（副作用なし）**: 引数を全部検証する。`url`/`articleId`/`version`（WS1）＋ `slug`（WS3）＋ **version 退行ガード**（WS3 の3分岐: 完全一致 no-op / version 上昇 / それ以外は `--force` 必須）。ここで全部弾いてから書き込みへ進む。
2. **書き込みフェーズ**: `meta.published` 更新 → `ExportIndex.upsert` の順で書く。
   - 通常更新時は `published.updatedAt` と index の `updatedAt` に**同一の新規時刻**を使う。
   - **完全一致 no-op** のときは何も書かない（`updatedAt` を進めない）。
   - **修復（meta だけ更新済みで index が欠落/古い）** のときは、新規時刻ではなく**既存 `meta.published.updatedAt` を再利用**して index を埋める（再実行で時刻がブレないようにし、冪等性を保つ）。

**部分失敗時の整合性（P1）**: 1 の検証を全通過させてから書くため大半の失敗は書き込み前に出るが、`writeMeta` 後・`upsert` 前のプロセス中断はあり得る。方針は **冪等な再実行＋検出**:
- `record-publication` は**冪等**にする（同じ引数の再実行は同じ最終状態。完全一致 no-op と「既存 `published.updatedAt` 再利用」により、再実行で `meta` と index が同じ値へ収束し、時刻もブレない）。中断後はユーザーが同じコマンドを再実行すれば修復される。
- 不整合（`meta.published` と index の `runId/version` が食い違う）を検出する軽量チェックを設け、`record-publication` 実行時に**先に検出して警告**する（必要なら将来 `article:repair-index` を別出し。本計画では検出と再実行修復まで）。
- rollback は採らない（2ファイル跨ぎの原子コミットは過剰。冪等再実行で十分）。
3. stdout に更新結果（slug / runId / url / version / no-op か更新か）を出す。

**テスト**（`tests/cli/record-publication.test.ts`）:
- 正常系で `meta.published` と index 双方が更新される。
- `version` 非整数・`url` 不正・`slug` 不正（空 / パス風 / `__proto__`）で reject。
- 既存 slug の上書き（version 上昇）。
- **完全一致 no-op**: 成功後に同一引数で再実行しても reject されず、index（`updatedAt` 含む）が書き換わらない。
- **version 退行**: `newVersion < oldVersion`、および `newVersion === oldVersion` だが内容が違う（url 等が変わった）ケースは `--force` 無しで reject、`--force` 付きで許可。
- **失敗注入＋修復**: index 書き込みを失敗させたあと同一引数で再実行すると、既存 `meta.published.updatedAt` を再利用して index が埋まり、`meta.published` と index が一致状態へ収束する（時刻もブレない）。

---

## 3. 第2段（運用）

### WS5: 差分成果物 `update-diff.md` / `changed-sections.json`

**配置の判断**: 差分集中2検証（§5.4）を「原則」で終わらせないため、差分成果物は**毎回機械生成**する。`run/meta は CLI 所有`の方針に合わせ、薄い CLI で生成する。

**新規ファイル**: `src/cli/updateDiff.ts`、コマンド `article:update-diff --run <id>`

- 入力: `runs/<id>/update-base.md` と `runs/<id>/final.md`。
- `update-diff.md`: 人/エージェントが読む unified diff（変更ブロック＋周辺文脈）。
- `changed-sections.json`: 変更が触れた見出し（H2/H3）の一覧など、検証エージェントが対象を絞れる構造化情報。
- 依存追加は避け、行ベース diff を内製（または既存の軽量実装）。フェーズ4 で revise 後に実行する。

**テスト**（`tests/cli/updateDiff.test.ts`）: base と final が同一なら空差分／一部変更で該当セクションのみ抽出。

> 代替案: 差分生成をスキル側（Bash の `git diff --no-index` 等）で済ませる手もあるが、Windows/POSIX 差や成果物のブレを避けるため CLI 内製を推奨。

### WS6: スキル `/update-article` と周辺

**新規/更新ファイル**:
- `templates/.claude/commands/update-article.md`（新規スキル本体）
- `templates/.claude/settings.json`（allowlist に `article:update-diff` / `article:import` を追加。**`article:record-publication` は追加しない** — 下記 allowlist 方針を参照）
- `templates/CLAUDE.md`（更新運用の原則を追記）
- `docs/qiita-article-howto.md`（更新フロー節を追加）
- 既存リポジトリ側 `.claude/commands/`・`CLAUDE.md`・`docs/` にも同内容を反映（templates と二重管理になっている既存構成に合わせる）

スキル進行（§7、create を import に差し替え。`article-editor-in-chief` はほぼ無改造で流用）:
1. `export/index.json` で slug → 最新 run / 公開 URL を解決 → 新 runId を発番。
2. `article:import --from export/<slug>.md --run <new-id> --supersedes <prev> --root <root>` → `update-base.md` 固定保存＋`lineage` 記録。
3. 棚卸し（factcheck 再発注 or 指定差分）→ `update-instruction.md` を作成。
4. `article:revise --instruction-file` → `article:update-diff` で `update-diff.md` 生成。
5. 差分集中2検証（factchecker / build-verifier に `update-diff.md` ＋周辺だけ渡す）→ 編集長 GO/NO-GO。
6. **ユーザー承認後**にローカル export → `article:record-publication` で `published`＋台帳を更新。承認時に**対象 URL を提示**し新規投稿と取り違えない。

**allowlist 方針（当初の決定。v0.2.31 で更新）**: `record-publication` は公開台帳の更新（公開相当）。当初は `export` と同様にコマンド実行プロンプトを残す＝allowlist に入れない方針だったが、**v0.2.31 で `export`/`record-publication`/`factcheck-stamp` を allowlist 化**し、コマンド実行プロンプトは出さない（承認連打の回避）。**取り違え防止は「実行前に対象 URL を内容で確認し編集長／ユーザーが承認する」運用で担保**する（プロンプトの有無に依存させない。§5 リスク）。`article:update-diff`（副作用が run 内に閉じる差分生成）と `article:import` も allowlist 化してよい。

**検証エージェント差分集中**: 現行 [article-factchecker.md](../.claude/agents/article-factchecker.md) は `final.md` 全文前提。`update-diff.md`（＋周辺）を入力にする手順へ更新（全文再検証はしない）。build-verifier も同様。

---

## 4. 第3段（自動化・将来）

WS7: 棚卸しの自動化（§10 第3段）。`export/*.md` の更新候補スコアリング、リリースノート監視。第1〜2段の成果物（`lineage` / 台帳 / 差分）が揃ってから着手。本計画では設計のみ留保。

---

## 5. 受け入れ条件（Done の定義）

> 進捗（feat/update-article-pipeline, v0.2.9）: **第1段 WS1〜WS4・第2段 WS5/WS6 完了・テスト緑（118 passed）**。第3段 WS7 は未着手。

- [x] `RunMeta` に `published?` / `lineage?` が型・検証付きで入り、round-trip テストが通る（WS1）。
- [x] `article:import` 後に `update-base.md` が `final.md` と一致し、`--supersedes`/`--root` で `lineage` が記録される（WS2）。
- [x] `export/index.json` の read/upsert/resolve がテストで担保される（WS3）。
- [x] `article:record-publication` が `meta.published` と `export/index.json` を同時に、検証付きで更新する（WS4。フラグは `--article-version`）。
- [x] `article:update-diff` が `update-base.md` と `final.md` から差分成果物を生成する（WS5）。
- [x] `/update-article` スキルが import→revise→diff→差分2検証→承認後 export→record-publication を駆動でき、`export/index.json` を必須として扱う（WS6）。検証エージェント（factchecker/build-verifier）も差分集中へ更新。allowlist は `import`/`update-diff` を追加、`record-publication` は除外。
- [x] `npm test`（build＋vitest）と `npm run typecheck` が緑（118 tests passed）。
- [x] CLAUDE.md / 手順書に「更新運用」が反映され、原則（final.md 直接編集禁止・自走公開禁止・revise 経由）が維持される（WS6）。

---

## 6. テスト計画

| 追加/更新 | 観点 |
|---|---|
| `tests/storage/RunStore.test.ts` | published/lineage の round-trip、検証の正常/異常 |
| `tests/storage/ExportIndex.test.ts`（新） | 新規/upsert/resolve/不在 |
| `tests/cli/import.test.ts` | update-base.md 生成・lineage 記録・--force 再生成 |
| `tests/cli/record-publication.test.ts`（新） | meta+index 同時更新・検証 reject（url/version/slug）・version 退行ガード（`--force`）・失敗注入後の冪等再実行 |
| `tests/cli/updateDiff.test.ts`（新） | 無変更で空・変更セクション抽出 |
| `tests/cli/bin.e2e.test.ts` | record-publication / update-diff のヘルプ・終了コード。`--article-version` が出る（`--version` 衝突回避）ことを dist 経由で固定 |

---

## 7. リスクと留意点

- **正本3つの固定が肝**（§9）: 版＝`update-base.md`、公開先＝`published`、系譜＝`lineage`。曖昧だと多段 revise で差分監査が壊れる（F1）。`update-base.md` を import 時の1回だけ書き、revise では触らない不変条件をコードとテストで守る。
- **再公開＝同一 URL 更新の取り違え**: 実行前に対象 URL を内容で確認し承認する（WS6。v0.2.31 で `record-publication` は allowlist 化されコマンド実行プロンプトは出ないため、URL 確認は運用で担保）。
- **責務分離を崩さない**: export はコピーのみ（F2）。meta/台帳更新は record-publication だけが行う。スキルから `meta.json` を直書きしない（CLI 所有）。
- **二重管理**: スキル/エージェント/CLAUDE.md は `templates/` と リポジトリ直下の `.claude/` の両方にある。更新は両方へ反映する（`init` で配布されるのは `templates/` 側）。
- **無検証 readMeta**: 既存 run（published/lineage 無し）と後方互換。フィールドは optional のまま、検証は書き込み経路に限定する。

---

## 8. 決定事項（本計画で確定。実装はこれに従う）

実装前レビューを経て、以下は確定済み。後続作業者はこの方針で着手する。

1. `update-base.md` は**全 import で書く**（安価・回帰起点。WS2）。
2. 差分生成は **CLI（`article:update-diff`）内製**（成果物の安定・OS 非依存。WS5）。
3. `record-publication` は公開相当（毎回 URL 確認）。**v0.2.31 で allowlist 化**され、URL 確認は運用（内容承認）で担保する（WS6 allowlist 方針）。
4. lineage は **import フラグ（`--supersedes`/`--root`）** で渡す（WS2）。
5. 二重更新の整合性は **冪等な再実行＋不整合検出**で担保（rollback は採らない。WS4）。
6. 同一 slug の version は **退行禁止**だが、**完全一致は no-op として許可**して冪等性と両立させる（version 上昇は通常更新、それ以外の退行は `--force`。WS3/WS4）。

> 再検討が要るとすれば 5（冪等で足りるか、`repair-index` を第1段に前倒すか）のみ。現時点は冪等＋検出で十分と判断。
