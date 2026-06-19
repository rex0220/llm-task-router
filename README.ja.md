# llm-task-router

*[English README](README.md)*

複数ステップの記事作成ワークフロー（Qiita / Zenn / ブログ / note …）を駆動する、薄い ModelRouter の TypeScript 製 CLI です。

## 必要環境

- **Node.js >= 20**（CLI と依存パッケージが `node:` インポートや新しめの API を使うため、Node 14/16 などの古い版では読み込みに失敗します）。

## インストール

グローバルインストールすると、単一バンドルの CLI（`dist/llm-task-router.js`）が `llm-task-router` コマンドとして使えます。

```bash
# npm から（パッケージは scoped。インストール後のコマンド名は `llm-task-router` のまま）
npm install -g @rex0220/llm-task-router

# またはパックした tarball から
npm run build && npm pack
npm install -g ./rex0220-llm-task-router-<version>.tgz
```

CLI は `config/models.yaml`・`config/profiles/`・`config/criteria/`・`.env` を読み、`runs/` を書き出します。これらはすべて**カレントディレクトリ相対**です。作業ディレクトリに設定テンプレを展開するには `init` を使います。

```bash
cd my-articles
llm-task-router init          # config/・.env.example・編集長セット（.claude/・CLAUDE.md）をここへコピー（既存は上書きしない。--force で上書き）
cp .env.example .env          # APIキーを設定する
# config/models.yaml の model を実在するモデルIDに直す
```

以降はそのディレクトリ配下でどこでも実行できます。

```bash
llm-task-router --help
llm-task-router -v
llm-task-router article:create --topic "..."
```

APIキーは作業ディレクトリの `.env` に置きます。`config/models.yaml` は `providers.*.api_key_env` で個別のキー名を指定でき、未指定なら `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` といった標準名にフォールバックします。

## コマンド

引数なし（または `--help`）でコマンド一覧を表示します。`-v` / `--version` で版数を表示。各コマンドは `--help` に対応します（例: `llm-task-router article:export --help`）。

```bash
# インラインのテーマ
llm-task-router article:create --topic "AIが解釈しやすい中間言語を設計する"

# 長文の指示はテキストファイルで（--topic / --topic-file はどちらか一方。両方指定はエラー）
llm-task-router article:create --topic-file topics/ai-ir.txt

# プロファイルで対象プラットフォームを変える（既定: qiita。profile は config/profiles/ にある）
llm-task-router article:create --topic-file topics/ai-ir.txt --profile zenn

llm-task-router article:resume --run 2026-06-16-example
llm-task-router article:review --run 2026-06-16-example

# final.md に自由な修正指示を反映（--instruction / --instruction-file はどちらか）
llm-task-router article:revise --run 2026-06-16-example --instruction "導入を短く。たとえ話を1つ追加"

# 別系統の審査役モデルで final.md を評価し、修正指示の草案を生成
llm-task-router article:evaluate --run 2026-06-16-example --min-severity major --criteria "正確性とコード例の動作を重視"

# 合格（または max-rounds 到達）まで evaluate→revise を自動で回す。evaluate+revise の自動版。
llm-task-router article:refine --run 2026-06-16-example --max-rounds 3 --min-severity major --until clean

# 完成記事を任意のパスへ書き出す（例: Zenn リポジトリ）。--force で上書き。
llm-task-router article:export --run 2026-06-16-example --out ../zenn-content/articles/my-article.md

# --- 既存・公開済み記事の取り込み／更新（create とは別系統）---
# 既存 Markdown 記事を run として取り込み、evaluate/refine/revise でブラッシュアップする
llm-task-router article:import --from ../old/my-article.md --profile qiita

# 更新差分（update-base.md → final.md）を生成し、差分集中の再検証に使う
llm-task-router article:update-diff --run 2026-06-16-my-article

# 公開を記録する: meta.published と export/index.json を更新（export とは別ステップ）
llm-task-router article:record-publication --run 2026-06-16-my-article \
  --slug my-article --url https://qiita.com/.../items/xxxx --article-id xxxx --article-version 2
```

`--topic-file` のとき `runId` はファイル名から生成されます（例: `ai-ir.txt` → `2026-06-16-ai-ir`）。`--run <runId>` で明示固定もできます。成果物は `runs/<runId>/` に保存されます。

## 開発

```bash
npm install
cp .env.example .env
npm run build    # 型チェック + CLI を dist/ にバンドル
npm test
```

開発中はビルドせずに `npm run article:*` スクリプト（`--` 区切りでフラグを渡す）や `npx tsx` でも実行できます。

```bash
npm run article:create -- --topic-file topics/ai-ir.txt --profile zenn
npx tsx src/index.ts article:create --help
```

作業コピーに対してグローバルの `llm-task-router` コマンドを使うにはリンクします。

```bash
npm run build
npm link            # `llm-task-router` がこのリポジトリを指すようになる
# ...
npm rm -g llm-task-router   # 終わったら解除
```

### 記事プロファイル

`--profile <name>`（既定 `qiita`）で `config/profiles/<name>.yaml` を選びます。プロファイルは次を定義します。

- `platform` — 各ステップのプロンプトに織り込むラベル（`<platform>記事` / `<platform>向けMarkdown`）
- `style` — プラットフォームの作法（admonition 記法・front-matter の扱い等）。本文生成（draft / final / revise）に注入される
- `language` — 情報用

同梱プロファイル: `qiita` / `zenn` / `blog` / `note`。複製して自前のものを追加できます（例: `config/profiles/devto.yaml`）。`--platform <name>` はプロファイルのラベルだけを上書きします。解決後の `platform` と `style` は `meta.json` に保存され、`resume` / `review` / `revise` / `evaluate` が自動で引き継ぎます。

`article:revise` は、あなたの指示と現在の `final.md` から記事を書き直し、直前版を `final.bak.md` に退避します（`article:review` は `draft.md` から自動レビュー→書き直しをやり直すもので、自由指示は使いません）。

`article:export --run <runId> --out <path>` は run の `final.md` を指定先へコピーします（対象は `final.md` のみ）。秘密ファイル名（`.env*`）は拒否、ワークスペース外は警告、既存ファイルは `--force` 無しでは上書きしません。これは「任意の書き込み先を受け取らない」原則に対する**明示的でガード付きの例外**で、内部成果物は `runs/<runId>/` に閉じたままです。

`article:evaluate` は別系統の審査役モデル（`models.yaml` の `final_review` タスク。既定で本文の書き手と別プロバイダ）で現在の `final.md` を評価し、`runs/<runId>/` に3ファイルを書き出します。`final-review.json`（生スコアカード）、`final-review.md`（人が読むサマリ＝判定・severity別件数・全指摘）、`revise-instruction.md`（`--min-severity` で絞った修正指示）。指示ファイルはローカル整形で生成され（追加APIコールなし）、確認・編集してから `article:revise --instruction-file` に渡せます。自動では書き直しません。`--criteria` / `--criteria-file` で評価の重点を指定できます。

評価観点は `config/criteria/` に置き、各プロファイルの `criteria_file` で対象に紐づきます。`article:evaluate` は run の profile（`meta.json` に保存）から観点を自動解決するため、通常は `--criteria-file` 不要です。

```bash
llm-task-router article:evaluate --run <runId> --min-severity minor
```

解決順: `--criteria`（インライン）> `--criteria-file`（明示上書き）> run の profile の `criteria_file` > なし。同梱: `config/criteria/default.md`（汎用の技術ルーブリック。`qiita`/`zenn`/`blog` が使用）と `config/criteria/note.md`（読みやすさ重視。`note` が使用）。一回だけ別観点で見たいときは `--criteria-file <path>` で上書きします。LLM-as-judge は実行ごとに揺れるため、対象ごとに観点を固定すると評価が一貫し比較しやすくなります。

`article:refine` は evaluate→revise を**自動**で回すループです（`article:evaluate` + `article:revise` を繰り返し実行する自動版）。各ラウンドで `final_review` モデルが `final.md` を採点し、停止条件を満たさなければ生成された修正指示を `rewrite` モデルで適用します。観点の解決順は `article:evaluate` と同じです。

- `--max-rounds <n>`（既定 `3`）: evaluate の最大回数。`revise` は最大 `n-1` 回なので、総モデルコールは最大 `2n-1`。暴走防止の必須安全弁です。
- `--min-severity <level>`（既定 `major`）: `--until clean` のとき、この深刻度以上の指摘が残る限りループを継続します。
- `--until <clean|approved>`（既定 `clean`）: `min-severity` 以上の指摘が 0 になったら（`clean`）、または judge が `approved` を出したら（`approved`）停止します。

停止理由は次のいずれかです: `clean` / `approved` / `max-rounds` / `stalled`（品質スコアが改善しなくなった）/ `regressed`（スコアが有意に悪化。スパイラル防止のダメージ制御で停止）/ `no-instruction`（judge が非承認だが具体的な指摘を返さない）。成功条件（`clean`/`approved`）は `stalled`/`regressed` より優先されます。各ラウンドの評価・適用した指示・修正前スナップショットはフラットな成果物として `runs/<runId>/` に残ります（`refine-r<N>-review.json` / `refine-r<N>-review.md` / `refine-r<N>-instruction.md` / `refine-r<N>-before.md`、加えて推移をまとめた `refine-summary.md`。最終ラウンドの評価は `final-review.{json,md}` にも複製）。ループは巻き戻しをしません（`final.md` は常に最新の適用版）。`regressed` 停止時は掘り進めず停止し、悪化を検出したラウンドの 1 つ前の修正前スナップショット（`refine-r<N>-before.md`。`<N>` は検出ラウンドより 1 小さい番号）の方が良い可能性を警告するので、人が手で良い版を選べます。進捗とラウンド履歴は `meta.json` の `refine` フィールドに記録されます。

### 既存記事の取り込みと更新

`article:import --from <path>` は `export` の対（外 → run）で、既存・公開済みの Markdown を新しい run の `final.md` として取り込み、`evaluate` / `refine` / `revise` でブラッシュアップできるようにします。取り込んだ run は `meta.json` で `imported: true` になり、生成系工程を持たないため `resume` / `review` は拒否されます（`evaluate` / `refine` / `revise` を使う）。`--criteria-file` でブラッシュアップ観点を渡せます。詳細は [docs/article-import-proposal.md](docs/article-import-proposal.md)。

**公開済み記事の更新リライト**（同一 URL・骨格を保ち、陳腐化した差分だけ直す）では、import を起点に `/update-article` スキルが専用フローを駆動します。**正本を3つ固定**するのが肝です: 版＝`update-base.md`（import 直後に固定する本文）/ 公開先＝`meta.published` / 系譜＝`meta.lineage`。

- `article:import --from export/<slug>.md --supersedes <前の run> --root <根 run>` で `update-base.md` を固定保存し、`lineage` を `meta.json` に記録します。
- `article:update-diff --run <id>` は `update-base.md` と現 `final.md` を比較し、`update-diff.md`（unified 風の差分）と `changed-sections.json`（見出しごとの追加/削除行数）を書き出します。ファクトチェック／ビルド検証が**変更セクションだけ**を見られるようになります。
- `article:record-publication --run <id> --slug <slug> --url <url> --article-id <id> --article-version <n>` は `meta.published` と `export/index.json` 台帳（slug → 最新 run / URL）を**同時に**更新します。`export`（`final.md` をコピーするだけ）とは意図的に別ステップで、export はローカル書き出し、`record-publication` は公開の記録です。同一 slug の version 退行を防ぎます（完全一致の再実行は no-op、意図的な訂正は `--force`）。フラグは `--article-version`（CLI 全体の version フラグ `--version` との衝突を避けるため）。`export` と同様に公開相当の操作なので編集長 allowlist に**入れず**、毎回プロンプトが出ます。

## 実行推移の表示

すべてのコマンドは工程ごとの進捗を **stderr** に出し、`runId` / `final` のパスは **stdout** に出します（スクリプトが stdout を解析する際に進捗が混ざりません）。

```text
[1/5] brief (article_brief) ...
[1/5] brief - done via openai/gpt-5.4 (2310ms, ~$0.0123)
[2/5] outline (outline) ...
[2/5] outline - done via anthropic/claude-opus-4-8 (4120ms, ~$0.0456)
total: ~$0.1240 (estimate)
```

各行は実際に使われた provider/model・所要時間・概算コストを示し、最後に run 合計を出します。設定上の primary と異なる provider が出た場合はフォールバックが起きた印です。`article:resume` / `article:review` では完了済み工程を `skip (done)` と表示します。

コストはレスポンスの `usage`（トークン数）と `config/models.yaml` の `prices`（USD/1Mトークン）による**ローカル概算**で、表示のための追加APIコールはありません。単価未設定（または `0`）のモデルはコスト表示の対象外です。単価は変動するので最新に保ってください。

### 出力ガード

本文系の工程（draft / rewrite / revise）では、保存する Markdown に軽量なガードがかかります。

- **truncation 警告** — 出力が `max_tokens` / `max_output_tokens` で打ち切られた場合、`⚠` を表示します。`max_tokens` を増やして再実行する目安になります。
- **コードフェンス除去** — モデルが本文全体を ``` で囲んで返した場合、保存前に外側のフェンスを剥がします。文中の正当な（複数の）コードブロックには手を加えません。スキーマ工程は検証済み JSON を保存するため対象外です。
- **ラップ文検知（警告のみ）** — 本文が前置き（例:「以下は…改稿版です」）で始まる、または末尾が追加提案（例:「…で出し直せます」）になっている場合に `⚠` を表示します。検知は**文言パターン**ベース（「見出しで始まること」を要求しません）なので、最初の見出しの前にリード文が来る Zenn/note の正しい書き方では誤検知しません。自動で本文を編集はせず、修正は人に委ねます。

## セキュリティ方針

本ツールは CLI 専用です。HTTP API を公開せず、任意コード実行・任意URL取得を行わず、全文プロンプトをログに保存しません。エラーログは正規化され、APIキー・SDKの生レスポンス・ヘッダ・入力本文は含めません。

## モデルに関する注意

一部の provider/model の組み合わせは `temperature` 等の生成パラメータを受け付けません。Provider 実装は既知の未対応パラメータを送らないようにしています。`config/models.yaml` のモデル名は、実利用前に各 provider の最新APIで確認してください。
