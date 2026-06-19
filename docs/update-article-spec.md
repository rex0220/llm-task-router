# 既存記事の更新リライト 仕様案

> ステータス: 採用（v3 / Codex レビュー2巡反映・§6.2 確定） / 対象: llm-task-router + Claude Code 記事パイプライン
> 最終更新: 2026-06-19

## 1. 目的

公開済みの技術記事を、**同一性（URL・骨格・読者評価）を保ったまま、陳腐化した差分だけ**を安全に更新するための運用を定義する。新規作成（`/write-article`）とは別系統の「更新」運用として確立する。

### 背景（既存資産）

更新の基礎部品はすでに存在し、一度実証済み。

- `article:import` で公開済み Markdown を新しい run に取り込み直せる（`runs/<id>/meta.json` の `imported: true`）。import run は生成系工程を経ていないため `resume`/`review` を拒否し、`evaluate`/`refine`/`revise` のみ許可される（[createQiitaArticle.ts:68](../../codex/llm-task-router/src/workflows/createQiitaArticle.ts) の判定）。
- 実例: `runs/2026-06-19-llm-task-router-with-claude-code-v028` は run A（`2026-06-18-llm-task-router-with-claude-code`）の export 済み記事を import し、v0.2.8 のインポート機能ぶんだけ追記して締めている。
- 1意図＝1ファイルの revise 運用（run A の `revise-01-*` 〜 `revise-13-*`）が差分の追跡可能性を担保する。

本仕様は、この import 往復ループを**反復可能な定型運用に昇格**させるもの。新規発明ではなく、既存プリミティブの定型化＋版管理の補完。

## 2. スコープ

### やること
- 公開済み記事 1 本を起点に、変更点リストに基づく差分更新を行い、編集長 GO ＋ユーザー承認後に再公開（同一記事の更新）する。
- 公開先記事と run の系譜（どの記事の何版か）を辿れるようにする。

### やらないこと
- 全面リライト（それは新規 `/write-article` の領分）。
- 自走での公開・更新（CLAUDE.md の原則どおり、公開相当の操作はユーザー承認後）。
- `final.md` の直接編集（修正は必ず `article:revise --instruction-file` 経由）。

## 3. 現行実装との整合（確認済み事実）

設計の前提となる現行挙動。Codex レビューで指摘され、実コードで確認した。

| # | 事実 | 根拠 | 設計への含意 |
|---|---|---|---|
| F1 | `article:revise` は毎回 `final.bak.md` を上書きする（既定 `backupTo: "final.bak.md"`）。 | [createQiitaArticle.ts:93-94](../../codex/llm-task-router/src/workflows/createQiitaArticle.ts) | `final.bak.md` は「直前の1回」しか保全しない。**import 直後の旧版＝公開正本は別ファイルで固定保存**が必須（§5.3）。 |
| F2 | `article:export` は `final.md` を指定パスへコピーするだけ。Qiita 記事 ID・URL・meta 更新は一切行わない。 | [export.ts:9-32](../../codex/llm-task-router/src/cli/export.ts) | 「ローカル export」と「公開更新（meta 記録）」は別責務。混ぜない（§4 フェーズ6・§6.2）。 |
| F3 | `RunMeta` に `published` も lineage 系フィールドも存在しない。 | [RunStore.ts:59-71](../../codex/llm-task-router/src/storage/RunStore.ts) | 版管理は新規フィールドの追加が必要。`published`（公開正本）と `lineage`（系譜正本）を分離する（§5.1・§5.2）。 |

> 本仕様は「**版の正本・公開先の正本・差分の正本**」の3つを明示的に固定することを最重要原則とする。

## 4. 中核フロー

```
公開済み記事
  → article:import          … 旧版を新 run の final.md として起点化
  → update-base.md を固定保存 … import 直後の本文＝差分監査の正本（§5.3）
  → 棚卸し / 差分指示          … update-instruction.md を作る（一次情報を根拠に）
  → article:revise           … 差分だけ適用
  → update-diff.md を生成      … update-base.md と final.md の差分＝検証の正本（§5.4）
  → 2検証（差分集中）          … factchecker / build-verifier に「差分＋周辺文脈」だけ渡す
  → 編集長 GO/NO-GO
  → （承認後）ローカル export   … final.md を書き出す（F2: コピーのみ）
  → 公開更新を記録            … 公開先 URL/ID と版を meta に記録（§6.2）
```

新規作成との決定的な違い: **`article:create` を回さない**。create は brief から書き起こすが、更新は import で「既存の到達点」を起点にする。

## 5. データモデルの拡張（要追加）

### 5.1 `published`（公開先の正本）
公開記事としての所在と版のみを持つ。run 系譜は混ぜない。

```jsonc
{
  "published": {
    "url": "https://qiita.com/.../items/xxxx",
    "articleId": "xxxx",
    "version": 2,                       // 公開記事としての版番号
    "updatedAt": "2026-06-19T00:00:00.000Z"
  }
}
```

### 5.2 `lineage`（run 系譜の正本）
「どの run がどの run の更新か」を持つ。公開情報とは別軸。

```jsonc
{
  "lineage": {
    "supersedesRunId": "2026-06-18-llm-task-router-with-claude-code", // 直前の起点 run
    "rootRunId": "2026-06-18-llm-task-router-with-claude-code",       // 系譜の根（初版 run）
    "sourceExportPath": "export/llm-task-router-with-claude-code.md"  // import 元
  }
}
```

> Codex 指摘 [P2]: `supersedes` を `published` に入れると「公開情報」と「run 系譜」の責務が混ざる。`published` は URL/ID/版だけ、系譜は `lineage` に分離する。

### 5.3 `update-base.md`（版の正本）
import 直後の本文を**固定ファイルとして保存**する。`final.bak.md` は revise のたびに上書きされる（F1）ため、**差分監査・回帰確認は常に `update-base.md` から取る**。一度書いたら更新フロー中は不変。

### 5.4 `update-diff.md` / `changed-sections.json`（差分の正本）
revise 後に `update-base.md` と現 `final.md` の差分を生成する。2検証はこの差分（＋周辺文脈）だけを入力にする。

> Codex 指摘 [P2]: 現行の factchecker/build-verifier は `final.md` 全文を読む手順（[article-factchecker.md](../../codex/llm-task-router/.claude/agents/article-factchecker.md)）。差分集中を「原則」で終わらせず、差分成果物を渡す設計にして初めてコスト削減が実際に守られる。

### 5.5 公開記事 → 最新 run の逆引き索引（必須級）
`/update-article <記事slug>` を成立させるには「slug → 最新 run → 公開 URL/記事 ID」を引けねばならない。`meta.json` だけでは run→記事は辿れても、slug→最新 run の解決が面倒。

**v3 確定**: `export/index.json`（記事 slug → 最新 runId / URL / articleId の台帳）に一本化する。§6.2 の `article:record-publication` がこの台帳を更新する正規の手段。`/update-article` はここから slug を解決する。

> 記事ごとの sidecar meta（`export/<slug>.meta.json`）は将来拡張候補。v3 では採らない（更新点を `export/index.json` 1か所に集約し、ブレを避ける）。

**実装メモ（v0.2.9）**: `export/index.json` は将来のスキーマ移行に備えてフォーマット版を持つ封筒形にした。slug キーはプロトタイプ汚染対策で null プロトタイプとして扱い、安全文字種（`runId` 相当）に限定する。

```jsonc
{
  "version": 1,
  "articles": {
    "<slug>": { "runId": "...", "url": "...", "articleId": "...", "version": 2, "updatedAt": "..." }
  }
}
```

## 6. 運用フェーズ

### フェーズ 1: 棚卸し（更新トリガーの検知）
| トリガー | 内容 | 検知方法 |
|---|---|---|
| バージョン追従 | 依存ツール/ライブラリの更新で記述が古い（v028 がこの例） | リリースノート差分、`--help` 実出力の比較 |
| 事実の陳腐化 | 価格・モデルID・仕様が変わった | factchecker を旧記事に「現在も正しいか」だけ再発注 |
| 読者フィードバック | コメント・指摘の反映 | 手動 |

### フェーズ 2: 起点 run の作成（import ＋ ベース固定）
```sh
llm-task-router article:import --from export/<記事>.md --run <new-id> --profile qiita
```
- 新 runId を発番するため旧 run（旧版の作業ログ）は保全される。
- import 直後に本文を `update-base.md` として固定保存（§5.3）。`lineage.sourceExportPath` / `supersedesRunId` / `rootRunId` を meta に記録。

### フェーズ 3: 差分指示の生成
**全文書き換えではなく、変更点リストを `update-instruction.md` に列挙**し、各変更点に一次情報（新バージョンの `--help` 実出力、公式リリースノート等）を根拠として添える。手本は run B の `revise-instruction.md` → `import-feature.md` → `import-feature-fixups.md`。

### フェーズ 4: 差分適用（revise）＋ 差分抽出
```sh
llm-task-router article:revise --run <new-id> --instruction-file runs/<new-id>/update-instruction.md
```
- revise 後、`update-base.md` と `final.md` の差分から `update-diff.md` / `changed-sections.json` を生成（§5.4）。

### フェーズ 5: 2検証（差分に集中）
- **article-factchecker**: 変更箇所が現行仕様と一致するか。
- **article-build-verifier**: 更新したコードが新バージョンで通るか（コードを含む記事のみ）。
- いずれも入力は `update-diff.md`（＋周辺文脈）に限定する。全文再検証はしない。

### フェーズ 6: 編集長判断と再公開（responsibility を分離）
1. 編集長（article-editor-in-chief）が GO/NO-GO を推奨。
2. **ユーザー承認後**にローカル export（`article:export`、F2 によりコピーのみ）。
3. 実際の公開更新（同一 URL の記事更新）と台帳記録は **export とは別ステップ**で行う（§6.2）。承認時に対象 URL を提示し、新規投稿と取り違えないようにする。

### 6.2 公開更新の記録手段 ＝ 案A `article:record-publication`（確定）
F2 のとおり `article:export` は meta を更新しない。新コマンド `article:record-publication` で公開台帳を更新する。

**確定理由**: このリポジトリは「run / meta は CLI が所有する」設計。スキル側で `meta.json` を直書きすると、将来のスキーマ変更や検証漏れで壊れやすい。CLI に寄せれば URL/articleId/version の検証、`updatedAt` の統一、index 更新までテストできる。

責務は「公開台帳更新」＝ `runs/<id>/meta.json` の `published`（§5.1）と `export/index.json` の slug 逆引き（§5.5）を**同時更新**する。

```sh
llm-task-router article:record-publication \
  --run <id> \
  --slug <slug> \
  --url <url> \
  --article-id <articleId> \
  --article-version <n>   # 実装では --version は CLI 全体の version フラグと衝突するため --article-version
```

責務分離は次のとおり崩さない:

| タイミング | 更新対象 | 手段 |
|---|---|---|
| import / 更新開始時 | `lineage`（§5.2）、`update-base.md`（§5.3） | `article:import` ＋ `/update-article` |
| 公開承認後 | `published`（§5.1）、`export/index.json`（§5.5） | `article:record-publication` |

## 7. 新スキル `/update-article`

`/write-article`（create 起点）に対し、import 起点の更新スキルを新設する。

```
/update-article <記事slug>
```

進行:
1. `export/index.json`（or sidecar、§5.5）で slug → 最新 run / 公開 URL を解決 → 新 runId を発番。
2. `article:import` で取り込み → `update-base.md` を固定保存、`lineage` を記録。
3. 棚卸し（factcheck 再発注 or 指定差分）→ `update-instruction.md` を作成。
4. `article:revise --instruction-file` で差分適用 → `update-diff.md` 生成。
5. 差分集中の 2 検証 → 編集長 GO/NO-GO。
6. ユーザー承認後にローカル export → `article:record-publication`（§6.2）で `published` と `export/index.json` を更新。

`article-editor-in-chief` はほぼ無改造で流用可能（create を import に差し替え）。原則（final.md 直接編集禁止・自走公開禁止・revise 経由）もそのまま適用される。

## 8. 生成・参照される成果物

| ファイル | 役割 | 区分 |
|---|---|---|
| `runs/<new-id>/final.md` | import された旧版 → 更新後の本文 | 既存 |
| `runs/<new-id>/update-base.md` | **import 直後の旧版（版の正本・差分監査の起点）** | 新規・必須 |
| `runs/<new-id>/final.bak.md` | 直前 revise のスナップショット（※毎回上書き、正本ではない） | 既存 |
| `runs/<new-id>/update-instruction.md` | 変更点リスト（一次情報を根拠に） | 新規 |
| `runs/<new-id>/update-diff.md` / `changed-sections.json` | 差分の正本（2検証の入力） | 新規 |
| `runs/<new-id>/meta.json` | `imported: true` ＋ `published`（§5.1）＋ `lineage`（§5.2） | 既存＋拡張 |
| `export/index.json` or `export/<slug>.meta.json` | slug → 最新 run / 公開 URL の逆引き | 新規・必須 |

## 9. リスクと留意点

- 本質的な追加は §5 のデータモデル（`published`/`lineage`/`update-base.md`/差分成果物）と §6.2 の公開記録手段。import 往復ループ自体は実証済み（run B）。
- **正本を3つ固定するのが肝**: 版＝`update-base.md`、公開先＝`published`、系譜＝`lineage`。ここが曖昧だと多段 revise で差分監査が壊れる（F1）。
- 再公開は「新規投稿」と取り違えやすい。同一 URL の更新であることをスキル内で明示し、承認時に URL を提示する。

## 10. 段階的導入

1. **第1段（基盤）**: 次の順で実装すると最も安定する（Codex 推奨）。
   1. `RunMeta` に `published?` と `lineage?` を分離追加（型 ＋ 検証）。
   2. import 直後の `update-base.md` 固定保存。
   3. `article:record-publication` の薄い CLI（`published` ＋ `export/index.json` 更新）とテスト。
2. **第2段（運用）**: `/update-article` スキル新設（import → revise → `update-diff.md` → 差分2検証 → 承認後 export → `record-publication`）。`export/index.json` を必須化。
3. **第3段（自動化）**: 棚卸しの自動化（`export/*.md` の更新候補スコアリング、リリースノート監視）。

---

## 付録: Codex レビュー反映ログ（2026-06-19）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| `final.bak.md` は import 直後版を保証しない（revise で上書き） | P1 | §3 F1 / §5.3 `update-base.md` を版の正本として固定保存 |
| 再 export = 同一URL更新が export の責務とズレ | P1 | §3 F2 / §6.2 ローカル export と公開記録を分離（案A `article:record-publication`） |
| `published.version`/`supersedes` の責務混在 | P2 | §5.1/§5.2 `published`（公開）と `lineage`（系譜）に分離 |
| `export/index.json` 任意では弱い | P2 | §5.5 `/update-article` 導入時点で必須級に格上げ |
| 差分集中2検証を支える成果物がない | P2 | §5.4 `update-diff.md`/`changed-sections.json` を追加し検証入力に |

## 付録: Codex レビュー第2巡 反映ログ（2026-06-19）

| 指摘 | 対応 |
|---|---|
| §6.2 は案A `article:record-publication` で確定してよい（run/meta は CLI 所有の設計） | §6.2 を案A確定に更新。ステータスを「採用（v3）」に |
| `record-publication` は `published` ＋ `export/index.json` を同時更新する「公開台帳更新」に寄せる（`--slug` を引数に） | §6.2 にコマンドシグネチャと責務分離表を追加 |
| 第1段の実装順は 型追加 → `update-base.md` 固定保存 → `record-publication` CLI＋テスト | §10 第1段を3ステップに具体化 |
