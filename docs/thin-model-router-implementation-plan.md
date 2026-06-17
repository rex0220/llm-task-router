# 薄い ModelRouter 実装計画書

作成日: 2026-06-16  
参照設計書: [thin-model-router-design.md](./thin-model-router-design.md)

## 1. 目的

Qiita記事作成などの個人・小規模用途に限定した、TypeScript製の薄いModelRouter CLIを実装する。

この計画では、設計書のMVPスコープを優先し、以下を満たす最小構成を段階的に作る。

- タスク別にモデルを選択する
- OpenAI / Anthropic をProviderとして呼び分ける
- rate limit / timeout / overloaded / 一時的な5xx系エラーのみフォールバックする
- 中間成果物を `runs/<runId>/` に保存し、途中再開できる
- ZodでJSON成果物を検証する
- ログにAPIキーや全文プロンプトを残さない
- Web UI、外部公開API、任意コード実行、任意URL取得は実装しない

## 2. 実装方針

### 2.1 基本方針

- CLI専用ツールとして実装する
- `ModelRouter` はProvider固有APIを知らない構造にする
- 設定は `config/models.yaml` から読み込む
- APIキーは `.env` から読み込み、`.env.example` のみコミット対象にする
- 成果物とメタ情報はファイル保存に限定する
- DB、HTTPサーバー、Web管理画面は導入しない

### 2.2 過剰実装を避ける項目

- 動的な設定変更APIは作らない
- プラグイン機構は作らない
- 任意シェル実行やコード実行機能は作らない
- 外部URL取得機能は作らない
- プロンプト全文をログDBに蓄積する仕組みは作らない
- 複雑なコスト最適化やモデル自動評価はMVPに入れない

## 3. 成果物

MVP完了時点で、次のファイルと機能を用意する。

```text
package.json
tsconfig.json
.gitignore
.env.example
config/
  models.yaml
src/
  index.ts
  router/
    ModelRouter.ts
    config.ts
    errors.ts
    types.ts
  providers/
    ModelProvider.ts
    OpenAIProvider.ts
    AnthropicProvider.ts
  schemas/
    ArticleBriefSchema.ts
    ArticleOutlineSchema.ts
    ReviewResultSchema.ts
    index.ts
  workflows/
    createQiitaArticle.ts
    resumeQiitaArticle.ts
  storage/
    RunStore.ts
  logger/
    RunLogger.ts
  utils/
    cost.ts
    hash.ts
    json.ts
    timeout.ts
tests/
  router/
    ModelRouter.test.ts
  storage/
    RunStore.test.ts
  workflows/
    createQiitaArticle.test.ts
runs/
  .gitkeep
README.md
```

## 4. 依存関係

### 4.1 実行・ビルド依存

- `typescript`
- `tsx`
- `commander`
- `yaml`
- `zod`
- `dotenv`
- `openai`
- `@anthropic-ai/sdk`

### 4.2 開発・テスト依存

- `vitest`
- `@types/node`

### 4.3 npm script

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "article:create": "tsx src/index.ts article:create",
    "article:resume": "tsx src/index.ts article:resume",
    "article:review": "tsx src/index.ts article:review"
  }
}
```

## 5. フェーズ別実装計画

### Phase 0: プロジェクト初期化

目的: TypeScript CLIとして動く最小土台を作る。

作業:

- `package.json` を作成する
- `tsconfig.json` を作成する
- `.gitignore` を作成し、`.env` と `runs/*` を除外する
- `.env.example` を作成する
- `src/index.ts` にCLIエントリポイントを作成する
- `runs/.gitkeep` を追加する

受け入れ条件:

- `npm run build` が成功する
- `npm test` が空または最小テストで成功する
- `.env` がGit管理対象にならない

### Phase 1: 型定義と設定読み込み

目的: ルーティングに必要な共通型と `models.yaml` 読み込みを実装する。

作業:

- `ModelTask`、`ModelRequest`、`ModelResponse` を定義する
- `ProviderRequest`、`ProviderResponse`、`ModelProvider` を定義する
- `RouterErrorKind`、`RouterError`、`normalizeProviderError` の型を定義する
- `RouterConfig`、`TaskConfig`、`ModelCandidate` を定義する
- `config/models.yaml` のMVP用初期設定を作成する
- `models.yaml` にproviderごとの `api_key_env` と、任意の `prices` を持てる余地を作る
- YAML読み込みとZod検証を `src/router/config.ts` に実装する
- 未定義タスク、primary未指定、不正providerを検出する
- `priority` はMVPでは実装しないため、初期型には入れない

受け入れ条件:

- 正常な `models.yaml` を読み込める
- 不正な設定でわかりやすいエラーを返す
- 実際のモデル名は設定値として扱い、コードに固定しない
- APIキーの参照先env名を設定から解決できる
- コスト概算は単価がある場合だけベストエフォートで計算できる

### Phase 2: Provider実装

目的: OpenAI / Anthropic のAPI差分をProvider層に閉じ込める。

作業:

- `OpenAIProvider` を実装する
- `AnthropicProvider` を実装する
- `.env` からAPIキーを読み込む
- Providerごとの `api_key_env` を優先し、未指定時だけ標準env名を使う
- Providerごとのレスポンスを共通 `ProviderResponse` に変換する
- token使用量が取得できる場合は `usage` に詰める
- APIキー未設定時は認証系エラーとして扱う
- SDK固有例外を `RouterErrorKind` に正規化する
- ProviderごとにSDKのリトライ回数とタイムアウト方針を明示する
- `AbortSignal` またはSDKのtimeout指定で中断できるようにする
- AnthropicProviderではモデル仕様に応じて未対応の `temperature` などを送らない
- AnthropicProviderでは `maxTokens` 未指定時に安全なデフォルトを補う

受け入れ条件:

- Router側がSDK固有型をimportしない
- Provider単位の単体テストはSDK呼び出しをmockする
- APIキーやリクエスト本文を例外ログに直接出さない
- rate limit、timeout、overloaded、5xx、認証、課金枠不足を型またはstatus/codeで区別できる
- 未対応パラメータ送信による400を避ける、または設定エラーとして明示的に返せる

### Phase 3: ModelRouter中核処理

目的: タスク別候補選択、リトライ、タイムアウト、フォールバックを実装する。

作業:

- `ModelRouter.run()` を実装する
- primaryとfallbackを順に試行する
- リクエストの `temperature` / `maxTokens` があれば設定値より優先する
- timeout処理をProvider呼び出しに適用し、`AbortSignal` をProviderへ渡す
- 一時的な失敗のみfallbackする
- 認証エラー、設定ミス、入力過大、schemaName不正、料金上限超過はfallbackしない
- 成功・失敗を `RunLogger` に渡す
- fallback判定は文字列マッチではなく `RouterErrorKind` で行う
- SDK内リトライはProvider責務、candidate切り替えはRouter責務として分離する
- `schemaName` 指定時はRouter内で検証・修復を呼び出す

受け入れ条件:

- primary成功時にfallbackが呼ばれない
- rate limit / timeout / overloaded / 一時的な5xx でfallbackする
- 認証エラーでfallbackしない
- 課金枠不足や支払い上限でfallbackしない
- AI出力のschema検証失敗は、同一candidateでの修復1回後に次candidateへ進む
- schemaName不正などの設定ミスではfallbackしない
- 全候補失敗時に最後のエラー情報を含む例外を返す

### Phase 4: スキーマ検証とJSON処理

目的: 中間成果物のJSONをZodで検証し、失敗時の扱いを明確にする。

作業:

- `ArticleBriefSchema` を実装する
- `ArticleOutlineSchema` を実装する
- `ReviewResultSchema` を実装する
- schemaNameからZod schemaを解決するregistryを作る
- JSON parse処理を `src/utils/json.ts` に集約する
- JSON検証失敗時の修復依頼用フローを `ModelRouter.run()` から呼べる形で実装する
- 修復依頼は同一candidateにつき最大1回に制限する
- Providerが構造化出力に対応する場合に備えて `responseFormat` を渡せる型にする
- AI出力の修復失敗時は `schema_validation` としてfallback候補へ進める
- `schemaName` 未定義・不正などの設定ミスは `config` として即終了する

受け入れ条件:

- schemaName未指定のタスクは通常テキストとして処理できる
- schemaName指定時はparseとZod検証を通過した成果物だけ次工程へ進む
- AI出力のスキーマ不正を無制限に別モデルへ投げ続けない
- schemaName不正はfallbackせず設定エラーとして終了する
- parse失敗・Zod失敗・修復失敗をログへ全文出力せずに追跡できる

### Phase 5: RunStoreとRunLogger

目的: 途中成果物、メタ情報、最小ログを安全に保存する。

作業:

- `RunStore` で `runs/<runId>/` を作成する
- `brief.json`、`outline.json`、`draft.md`、`review.json`、`final.md` を保存する
- `meta.json` に工程状態を保存する
- `RunLogger` でJSON Lines形式のメタログを保存する
- input本文は保存せず、`sha256` hashのみ保存する
- elapsed、provider、model、status、usage、cost概算を保存する
- errorは正規化済みの `kind`、status code、短い要約だけ保存する

受け入れ条件:

- 途中停止後も `meta.json` から完了済み工程を判定できる
- ログにAPIキー、`.env` 内容、全文プロンプトが含まれない
- `runs/<runId>/` 以外へ成果物を書き込まない

### Phase 6: Qiita記事作成ワークフロー

目的: 設計書のQiita記事作成フローをCLIから実行できるようにする。

作業:

- `createQiitaArticle(topic, options)` を実装する
- 記事作成ステップを宣言的な配列で定義する
- 共通ランナーで `article_brief`、`outline`、`draft_markdown`、`technical_review`、`rewrite` を実行する
- 共通ランナーが `meta.json` を見て完了済み工程をスキップする
- `brief.json`、`outline.json`、`draft.md`、`review.json`、`final.md` を保存する
- `article:create` コマンドを実装する（`--topic` インライン、または `--topic-file` でテキストファイル指定）
- `--topic` / `--topic-file` のどちらか必須とし、両方指定時はエラーにする
- `--topic-file` 指定時の `runId` はファイル名ベースで生成する
- `--profile <name>` で `config/profiles/<name>.yaml`（platform/style/language）を読み込み、本文生成プロンプトに作法を注入する（既定 `qiita`、`--platform` はラベル上書き）
- 解決した platform/style を `meta.json` に保存し、resume/review/revise/evaluate が継承する
- `article:resume` コマンドを実装する
- `article:review` コマンドを実装する
- `article:revise` コマンドを実装する（`final.md` に `--instruction` / `--instruction-file` の修正指示を反映）
- `article:revise` は上書き前の `final.md` を `final.bak.md` に退避する
- `article:export` コマンドを実装する（`final.md` を `--out <path>` へ書き出し。秘密名拒否・`--force` 上書き・ワークスペース外警告）
- `article:evaluate` コマンドを実装する（`final.md` を別系統モデルで評価し `final-review.json` を保存）
- 評価結果から `revise-instruction.md`（フィルタ済み修正指示）と `final-review.md`（全指摘の人向けサマリ）をローカル整形で生成する（追加APIコール無し、自動rewriteしない）
- `--min-severity` で指示に含める指摘を絞り、`--criteria` / `--criteria-file` で評価観点を指定できる
- 評価用の `final_review` タスクを `models.yaml` に追加し、既定で本文と別providerに向ける
- 工程の進捗（開始/完了/スキップ・使用provider/model・所要時間・概算コスト）を stderr に出力する
- 進捗は `WorkflowReporter` コールバックで渡し、ワークフロー関数は省略可能（テストではno-op）にする
- コストは `usage` × `prices` のローカル概算とし、表示のための追加APIコールを行わない。run合計も表示する
- 本文工程の保存前ガードを設ける（truncation検知の警告、全体コードフェンス除去、ラップ文＝前置き/後置きの検知警告）。スキーマ工程は対象外
- ラップ文は自然文のため自動削除せず警告のみとする（正当な導入/結論の誤削除を避ける）

受け入れ条件:

- `npm run article:create -- --topic "..."` で新規runを作れる
- `npm run article:create -- --topic-file <path>` で長文指示ファイルから新規runを作れる
- `--topic` も `--topic-file` も無い場合はわかりやすいエラーになる
- `npm run article:resume -- --run <runId>` で未完了工程から再開できる
- `npm run article:review -- --run <runId>` でレビュー工程以降を再実行できる
- `npm run article:revise -- --run <runId> --instruction "..."` で final.md に修正指示を反映できる
- 各工程の成果物が期待ファイル名で保存される
- create / resume / review が同じステップ定義を共有している
- 実行中に工程の進捗が stderr に表示され、stdout には `runId` / `final` のみ出力される

### Phase 7: テスト

目的: 課金や情報送信に関わる分岐を重点的に保護する。

作業:

- `ModelRouter` のfallback判定テストを追加する
- `ModelRouter` のprovider未登録テストを追加する
- timeout時のfallbackテストを追加する
- 認証エラーでfallbackしないテストを追加する
- 課金枠不足でfallbackしないテストを追加する
- AI出力のschema_validationで次candidateへ進むテストを追加する
- schemaName不正でfallbackしないテストを追加する
- SDKエラー正規化のテストをProviderごとに追加する
- AnthropicProviderが未対応パラメータを送らないテストを追加する
- `RunStore` の保存・再開テストを追加する
- `RunLogger` が全文inputを保存しないテストを追加する
- `RunLogger` が生errorやヘッダを保存しないテストを追加する
- workflowの工程スキップ・再開テストを追加する

受け入れ条件:

- `npm test` が成功する
- 外部APIを呼ばずにテストできる
- 失敗時にログへ機密情報が混入しないことをテストで確認する

### Phase 8: READMEと利用手順

目的: 最小限の使い方、設定、注意点を利用者が迷わず確認できるようにする。

作業:

- READMEに概要を追加する
- セットアップ手順を追加する
- `.env` の設定例を追加する
- `models.yaml` の編集方法を追加する
- `api_key_env` とモデル別単価設定の扱いを追加する
- Anthropicなどモデルによって `temperature` が使えない場合があることを明記する
- `article:create`、`article:resume`、`article:review` の使用例を追加する
- セキュリティ上やらないことを明記する

受け入れ条件:

- READMEだけでローカル実行まで進められる
- APIキーや秘密情報をログに残さない方針が明記されている
- MVPで未対応の機能が明記されている

## 6. 実装順序

推奨順序:

1. Phase 0: プロジェクト初期化
2. Phase 1: 型定義と設定読み込み
3. Phase 5: RunStoreとRunLogger
4. Phase 3: ModelRouter中核処理
5. Phase 4: スキーマ検証とJSON処理
6. Phase 2: Provider実装
7. Phase 6: Qiita記事作成ワークフロー
8. Phase 7: テスト拡充
9. Phase 8: README整備

理由:

- 先にProviderを作ると外部API都合に引っ張られるため、mock可能なRouterとStoreを先に固める
- Router、Store、Loggerは課金や情報保護に直結するため、早い段階でテストを書く
- Providerは最後寄りに実装し、外部SDK依存を境界に閉じ込める

## 7. テスト計画

### 7.1 単体テスト

- config読み込み
- fallback判定
- timeout処理
- schema registry
- JSON parse / validation
- RunStoreの保存と読み込み
- RunLoggerの秘匿情報非保存

### 7.2 結合テスト

- mock providerを使った `createQiitaArticle`
- `meta.json` を使った `resumeQiitaArticle`
- review工程のみ再実行

### 7.3 手動確認

- `.env` 未設定時のエラーメッセージ
- `models.yaml` 不正時のエラーメッセージ
- runId指定時の保存先
- ログに全文プロンプトが含まれないこと
- 実APIを使った最小1回の疎通確認

## 8. エラー分類

### 8.1 fallbackする

- rate limit
- timeout
- overloaded
- temporary unavailable
- service unavailable
- provider側の5xx
- API connection error
- AI出力のJSON parse / Zod検証失敗後、同一candidateでの修復も失敗した場合

### 8.2 fallbackしない

- APIキー未設定
- APIキー不正
- 認証エラー
- 入力が長すぎる
- schemaName不正
- 禁止された内容
- 課金枠不足
- 料金上限超過
- `models.yaml` の設定ミス

`quota` という文字列では判定しない。  
一時的なrate limitと、支払い・課金枠・プロジェクト上限などのbilling quota系エラーは別の `RouterErrorKind` として扱う。

スキーマ系は `config` と `schema_validation` に分ける。  
`schemaName` 不正やschema registry不整合は設定ミスなのでfallbackしない。AI出力のparse / Zod検証失敗は、同一candidateで最大1回修復を試し、それでも失敗した場合に `schema_validation` として次candidateへ進める。

## 9. セキュリティチェックリスト

- `.env` をGit管理しない
- `.env.example` に実キーを書かない
- ログにAPIキーを書かない
- ログに全文プロンプトを書かない
- エラーメッセージにSDKの生レスポンスを丸ごと保存しない
- fallback判定をエラーメッセージ文字列の部分一致に依存しない
- 成果物保存先を `runs/<runId>/` に限定する
- runIdにパストラバーサル文字列を許可しない
- CLI引数から任意ファイル書き込み先を受け取らない（例外: `article:export` の `--out` は明示エクスポートとして許可。`.env` 等の秘密名は拒否、`--force` 無しでは上書きしない、ワークスペース外は警告。対象は `final.md` のみ）
- `--topic-file` / `--instruction-file` で `.env` 等の秘密ファイルを読み込ませない（ワークスペース外は警告）
- 任意コード実行機能を追加しない
- 任意URL取得機能を追加しない

## 10. 完了条件

MVPは次を満たした時点で完了とする。

- `npm run build` が成功する
- `npm test` が成功する
- `npm run article:create -- --topic "..."` がmockまたは実APIで動く
- `runs/<runId>/` に `brief.json`、`outline.json`、`draft.md`、`review.json`、`final.md`、`meta.json` が保存される
- `npm run article:resume -- --run <runId>` で途中再開できる
- OpenAI / Anthropic のprimary / fallbackを設定で切り替えられる
- fallbackすべきでないエラーで別providerへ送信されない
- fallback判定が正規化済みエラー種別で実装されている
- schemaName指定時の検証・修復責務がRouterに実装されている
- ログにAPIキーや全文プロンプトが残らない
- READMEにセットアップとCLI利用例がある

## 11. MVP後の拡張候補

優先度順:

1. GeminiProvider追加
2. LocalProvider / Ollama対応
3. 記事テンプレート切り替え
4. コスト上限の厳格化
5. Qiita API下書き投稿
6. GitHubへの成果物保存
7. LangGraph連携
8. Dify連携
9. Web UI

MVP後も、外部公開API、任意コード実行、任意URL取得は必要性とリスクを再評価してから追加する。
