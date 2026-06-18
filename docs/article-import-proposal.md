# `article:import` 機能 — 目的・仕様案

既存の（このパイプライン外で書かれた）Markdown 記事を llm-task-router の run として取り込み、`evaluate` / `refine` / `revise` のブラッシュアップ系コマンドへそのまま乗せられるようにする CLI 機能の提案。

- ステータス: 実装済み（v0.2.8）
- 対象バージョン: v0.2.8
- 関連: [docs/qiita-article-howto.md](qiita-article-howto.md), [src/cli/export.ts](../src/cli/export.ts), [src/workflows/createQiitaArticle.ts](../src/workflows/createQiitaArticle.ts)

---

## 1. 目的

既存記事（手書き・他所で作成・公開済みなど）を、本文を手書き編集せずに llm-task-router のブラッシュアップ・パイプラインへ取り込む。

- 既存記事を `runs/<runId>/final.md` ＋ 正しい `meta.json` として **CLI が生成**し、`evaluate` / `refine` / `revise` を即適用できる状態にする。
- run 内部構造（`RunMeta` の `steps` 形状・`style`/`profile` の意味・runId 規約）を **外側AIに手書きさせない**。create と同じコード経路で meta を組み、整合を保証する。

### 背景（なぜ CLI 機能か）

- 現状、run と `meta.json` を生成するのは `article:create`（＝トピックからの本文生成）だけで、**既存記事を取り込む経路が無い**。
- 手動 seed（`mkdir` + `final.md` コピー + `meta.json` 手書き）は可能だが、本リポジトリの原則「runs/ は CLI が所有」「本文・run 内部を外側AIが直接いじらない」に反し、meta のスキーマ追従・`style`/`criteria` の転記ミスで壊れやすい。
- `export`（run → 外）と完全に対称な `import`（外 → run）として実装すれば、メンタルモデルがそろい、再利用資産（後述）でコストも小さい。

### 設計上の重要前提（指示の効き方）

ブラッシュアップの「指示」がどこで効くかは、評価/修正プロンプトの入力で決まる。

- **評価（evaluate / refine の採点）は `platform` + `criteria` + 本文のみを入力**し、`meta.topic` を使わない（[createQiitaArticle.ts:205-212](../src/workflows/createQiitaArticle.ts#L205-L212)）。
  → インポート記事には作成時の topic 仕様が無いため、**「どう良くするか」は criteria（＝ブラッシュアップ・ブリーフ）に載せる**のが主舵。
- **`style` は revise にだけ注入**され、evaluate には入らない（[createQiitaArticle.ts:90](../src/workflows/createQiitaArticle.ts#L90)）。
  → Qiita 作法の矯正は revise 工程で効く。
- 結論: import は「**本文 ＋ ブラッシュアップ・ブリーフ（criteria）**」をセットで取り込めると価値が高い。

---

## 2. スコープ

### やること（Goals）

- 既存 Markdown ファイルを `final.md` として run に取り込む。
- profile から `platform` / `style` / `criteria` を正しく解決して `meta.json` を生成する（create と同経路）。
- 取り込み後すぐ `evaluate` / `refine` / `revise` が成立する状態にする。
- 任意で「ブラッシュアップ・ブリーフ（criteria）」を同梱し、以後の評価が既定で拾えるようにする。

### やらないこと（Non-goals）

- 本文の自動編集・整形（import は取り込みのみ。改善は既存コマンドが担う）。
- URL / クリップボードからの取り込み（ローカルファイルのみ）。
- front-matter の自動除去（検出して**警告**にとどめる。Qiita は本文に front-matter を含めない方針のため）。
- 複数ファイルの一括取り込み。

---

## 3. CLI 仕様案

```bash
llm-task-router article:import --from <path> [options]
```

### オプション

| オプション | 必須 | 既定 | 説明 |
|---|---|---|---|
| `--from <path>` | ✓ | — | 取り込む既存 Markdown のパス。`final.md` の内容になる |
| `--run <runId>` |  | ファイル名から導出 | run id を明示指定 |
| `--topic <text>` |  | 本文先頭 H1 → 無ければ runId | meta に記録する記事テーマ（評価には不使用だが履歴・人の参照用） |
| `--topic-file <path>` |  | — | topic をファイルで指定（`--topic` と排他） |
| `--profile <name>` |  | `qiita` | platform / style / criteria を解決する profile |
| `--platform <name>` |  | profile の値 | platform ラベルの上書き |
| `--criteria-file <path>` |  | — | ブラッシュアップ・ブリーフ。`runs/<runId>/brushup-criteria.md` として保存し、以後の評価が自動で拾う（§5 A 案） |
| `--force` |  | false | 同一 runId の既存 run を **import run として置き換える**（§3.1） |

### 振る舞い

1. `--from` を `assertSafeInputPath` で検査（秘密ファイル拒否・ワークスペース外は警告）。空ファイルはエラー。
2. runId を決定（`--run` 優先、無ければ `createRunId(basename(from) の拡張子を落としたもの)`。create の `--topic-file` と同じく拡張子を除去してから seed にする → `old-article.md` は `...-old-article`）。
3. **既存 run 保護**: `runs/<runId>/` ディレクトリまたは `meta.json` が既に存在し `--force` 無しならエラー（§3.1）。`final.md` の有無だけで判定しない（作成途中 run の `meta.json` 破壊を防ぐ）。
4. `loadProfile(profile)` で `platform` / `style` / `criteriaFile` を解決。
5. `store.create(runId, topic, qiitaSteps..., platform, style, profile)` で `meta.json` を正規生成。**全 step を `done` にし**、`meta.imported = true` を立てる（§4。resume/review の誤動作を構造的に防ぐ核心）。
6. `--from` の内容を `store.save(runId, "final.md", body)` で保存。
7. front-matter（先頭 `---` ブロック）を検出したら **警告**（除去はしない）。
8. `--criteria-file` 指定時は内容を検査のうえ `runs/<runId>/brushup-criteria.md` として保存（§5）。
9. stdout に `runId` と `final: runs/<runId>/final.md`、次アクション（evaluate）を案内。

### 3.1 `--force` の意味（run 全体の置き換え）

`--force` は「`final.md` だけ差し替え」ではなく、**同一 runId を新しい import run として置き換える**。よって import 由来でない過去成果物が残ると整合が崩れるため、置き換え時は旧 review/refine 成果物を掃除する:

- 削除対象: `final.bak.md` / `final-review.{json,md}` / `revise-instruction.md` / `refine-summary.md` / `refine-r*-*.md`（refine の cleanup と同じ列挙）。
- `meta.refine` はリセット（新しい meta を `store.create` で生成するため自然に消える）。
- 既存 run が **import run でない**（`meta.imported` が無い）場合は、`--force` でも一度警告を出す（生成系 run の誤上書き気づき用）。

### 出力例

```text
imported: runs/2026-06-18-existing-article/final.md (from old-article.md)
runId: 2026-06-18-existing-article
next: llm-task-router article:evaluate --run 2026-06-18-existing-article --min-severity minor
```

---

## 4. 生成される meta.json（例）

```json
{
  "runId": "2026-06-18-existing-article",
  "topic": "kintone プラグイン競合の切り分け",
  "platform": "Qiita",
  "style": "（qiita プロファイル由来の作法文言）",
  "profile": "qiita",
  "imported": true,
  "createdAt": "2026-06-18T00:00:00.000Z",
  "updatedAt": "2026-06-18T00:00:00.000Z",
  "steps": {
    "brief": { "status": "done" },
    "outline": { "status": "done" },
    "draft": { "status": "done" },
    "review": { "status": "done" },
    "final": { "status": "done", "file": "final.md" }
  }
}
```

- **全 step を `done`** にする（生成系を `pending` で残さない）。
  → これにより `resume` は「全 done」で実質 no-op になり、import 元と無関係な中間成果物（brief〜review）を生成しない。
  `evaluate` / `revise` は step 状態を見ないため従来どおり成立し、`refine` の cleanup/persist も `meta.refine` 不在で正常動作。
- **`imported: true`** を `RunMeta` に追加（新規 optional フィールド）。`resume` / `review` はこのフラグを見て**拒否**する（§7）。
  step を全 done にしても `review` は review+final を pending へ戻して review ステップを走らせる（[createQiitaArticle.ts:641-645](../src/workflows/createQiitaArticle.ts#L641-L645)）ため、フラグによる明示拒否が必要。
- `style` は profile から解決して入れる（手書き転記を避ける）。revise 時の Qiita 作法注入が効く。
- `profile` を入れることで `evaluate` / `refine` が criteria を自動解決する（[index.ts:368-383](../src/index.ts#L368-L383)）。

---

## 5. ブラッシュアップ・ブリーフ（criteria）の同梱

インポート記事には作成時の topic 仕様が無く、評価は criteria しか見ない。そこで `--criteria-file` を「消えた topic 仕様の代替＝ブラッシュアップ・ブリーフ」として受け取る。

- 保存先: `runs/<runId>/brushup-criteria.md`。
- **拾い方は A 案（run 専用 criteria を自動優先）で確定**。`resolveEvaluationCriteria`（[index.ts:359-383](../src/index.ts#L359-L383)）に「run 内 `brushup-criteria.md` があれば profile criteria より優先で採用」する分岐を足す。これにより import 後の `article:evaluate --run <runId>`（criteria 無指定）でブリーフが自動で効き、**主価値が silently lost しない**。
- **criteria 優先順位（確定）**: `--criteria / --criteria-file（明示）` > `runs/<runId>/brushup-criteria.md` > `profile の criteria_file` > なし。
- ブリーフ推奨項目: 想定読者 / 記事のゴール / 重視する改善 / **維持すべき制約（壊さない章構成・コードの意味）**。
  「維持すべき制約」は refine のドリフト（criteria 最適化で元記事の良さを壊す）抑制に効く。

```text
# ブラッシュアップ観点（criteria）
# 想定読者
kintone 中級者。プラグイン開発の前提あり。
# 記事のゴール
- 競合の原因を切り分けられる / 回避策を1つ実装できる
# 重視する改善
- 導入が冗長。結論を前倒し
- コード例の前提（バージョン・import）を明示
# 維持すべき制約（壊さない）
- 既存の見出し構成と章順は変えない
- コードブロックの意味は変えない（表記の作法のみ整える）
```

---

## 6. 取り込み後の推奨フロー

既存・公開済み記事の「ブラッシュアップ」は、新規生成と違い**著者の意図を壊さない**配慮が要る（refine は criteria に向けて最適化するだけで意図を知らない）。

```bash
# 1) 取り込み（ブリーフ同梱）
llm-task-router article:import --from ../old/kintone.md \
  --profile qiita --criteria-file ./brushup-criteria.md

# 2) まず読み取りのみで評価（書き換えなし） → final-review.md を読む
#    criteria 無指定でも runs/<runId>/brushup-criteria.md を自動採用（§5 A 案）
llm-task-router article:evaluate --run <runId> --min-severity minor

#    別ブリーフで採点したいときだけ明示指定（明示が最優先）
#    llm-task-router article:evaluate --run <runId> --criteria-file ./other-criteria.md

# 3) 納得した指摘だけ当てる（final.bak.md が残る）
llm-task-router article:revise --run <runId> \
  --instruction-file runs/<runId>/revise-instruction.md

# 4) 自動ループは控えめに（ドリフト監視）
llm-task-router article:refine --run <runId> \
  --criteria-file runs/<runId>/brushup-criteria.md \
  --max-rounds 2 --min-severity major --until clean
#   → regressed / stalled の停止理由と refine-r*-before.md を確認

# 5) コード入り記事は factcheck + build 検証を revise 経由で戻す（既存フロー）
```

---

## 7. 実装方針

| 変更 | 内容 |
|---|---|
| 新規 [src/cli/import.ts](../src/cli/import.ts) | `importArticle(store, opts)`。export.ts と対称。`assertSafeInputPath` / `loadProfile` / `store.create` / `store.save` を再利用。全 step done ＋ `imported:true` の meta を生成。`--force` 時は旧成果物を掃除（§3.1） |
| [src/index.ts](../src/index.ts) | `article:import` サブコマンド追加（オプション解決は `resolveText` 流用） |
| [src/storage/RunStore.ts](../src/storage/RunStore.ts) | `RunMeta` に `imported?: boolean` を追加 |
| [src/workflows/createQiitaArticle.ts](../src/workflows/createQiitaArticle.ts) | `createRunId` を import から流用。**`resumeQiitaArticle` / `rerunQiitaReview` の先頭で `meta.imported` を見て拒否**（「import run は evaluate/refine/revise を使え」と案内するエラー） |
| criteria 拾い（A 案） | `resolveEvaluationCriteria`（index.ts）に「run 内 `brushup-criteria.md` を profile criteria より優先採用」する分岐を追加 |
| テスト | runId 導出（拡張子除去）/ meta 生成（profile 由来の style・profile・全 step done・imported フラグ）/ **既存 run 保護（dir/meta 存在で force 必須）** / **import run への resume・review 拒否** / criteria 自動採用と優先順位 / 上書き時の旧成果物掃除 / 秘密ファイル拒否 / front-matter 警告 / 空ファイルエラー |
| ドキュメント | [docs/qiita-article-howto.md](qiita-article-howto.md) に「既存記事の取り込み」節を追記 |
| 任意 | `/import-article` スキル（CLI を呼び、続けて編集長に evaluate まで回させる薄いラッパ。**meta は書かない**） |

### 再利用できる既存資産

- `createRunId(seed)` … ファイル名 → runId 規約（create と同一）
- `store.create(...)` … meta.json の正規生成（steps を qiitaSteps から）
- `loadProfile(profile)` … platform / style / criteriaFile の正しい解決
- `assertSafeInputPath` … 秘密ファイル拒否・ワークスペース外警告
- `export.ts` … 上書きガード・「最小ファイルのみ扱う」設計の対称テンプレート

想定規模: 新規 ~40 行 ＋ サブコマンド ＋ テスト ＋ howto 追記。半日未満。

---

## 8. エラー・エッジケース

- `--from` が空 / 不存在 → エラー。
- 秘密ファイル（`.env*`）→ 拒否。
- 既存 run（`runs/<runId>/` または `meta.json`）あり ＋ `--force` 無し → エラー（作成途中 run の meta 破壊防止）。
- `--force` で生成系 run（`imported` 無し）を置き換える → 警告のうえ実行（旧成果物は掃除）。
- import run に対する `article:resume` / `article:review` → `meta.imported` を見て拒否（evaluate/refine/revise へ誘導）。
- `--topic` と `--topic-file` 同時指定 → エラー（`resolveText` の既存挙動）。
- 不正な runId（規約外文字）→ `RunStore.validateRunId` でエラー。
- front-matter 検出 → 警告のみ（自動除去しない）。
- 巨大ファイル → 取り込みは許容。下流の `max_tokens` 打ち切り警告は既存の仕組みに委ねる。

---

## 9. 未決事項

- `topic` 自動導出を H1 にするか runId にとどめるか（評価に影響しないため優先度低）。
- `/import-article` スキルを同時に出すか、CLI 先行か。

### 確定済み（codex レビュー反映）

- criteria 拾いは **A 案（run 専用 `brushup-criteria.md` を自動優先）** で確定。優先順位は `明示 > brushup-criteria.md > profile criteria_file > なし`（§5）。
- 既存 run 保護は `final.md` ではなく **run ディレクトリ / `meta.json` 存在**で判定（§3.1, §8）。
- import run は **全 step done ＋ `imported:true`** とし、`resume` / `review` を**拒否**（§4, §7）。
- runId 導出は create と同じく**拡張子を落としてから** seed 化（§3）。
- `--force` は **run 全体の置き換え**と定義し、旧 review/refine 成果物を掃除（§3.1）。

---

## 10. codex レビュー反映ログ

| 指摘 | 対応 |
|---|---|
| [P1] `brushup-criteria.md` が自動で拾われず主価値が silently lost | §5 で A 案確定。`resolveEvaluationCriteria` に run 専用 criteria 優先分岐を追加。フロー例も自動採用前提に修正 |
| [P1] 既存 run 保護が `final.md` だけだと途中 run の `meta.json` を破壊 | §3.1/§3 振る舞い/§8 で run ディレクトリ・`meta.json` 存在ベースのガードに変更 |
| [P2] `pending` 残しで `resume`/`review` が事故る | §4 で全 step done ＋ `imported:true`、§7 で `resume`/`review` 拒否を実装項目に追加 |
| [P3] runId 導出が create とズレる | §3 で拡張子除去に統一 |
| [OQ] `--force` の意味 | §3.1 で「run 全体の置き換え＋旧成果物掃除」と明記 |
| [OQ] criteria 優先順位 | §5 で `明示 > brushup-criteria.md > profile > なし` に確定 |

### 第2次レビュー反映（実装後）

| 指摘 | 対応 |
|---|---|
| [P1] force 置き換えで旧 `brushup-criteria.md` が残り silent 再利用 | `staleArtifacts()` に `brushup-criteria.md` を追加。criteria 無しの force 再 import で消えることをテストで固定 |
| [P2] force 置き換えで旧生成系成果物（brief/outline/draft/review）が残る | `staleArtifacts()` に 4 ファイルを追加。テストで draft/review の消去を確認 |
| [P2] import 用テスト不在 | `tests/cli/import.test.ts`（8件）＋ workflows に resume/review 拒否テスト（1件）を追加。合計 88 passed |
