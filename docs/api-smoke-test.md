# 実API疎通手順

作成日: 2026-06-16

この手順は、`llm-task-router` を最小トピックで実APIに接続し、Qiita記事ワークフローが最後まで動くか確認するためのものです。

## 1. 前提

- `npm install` が完了している
- `npm run build` が成功する
- `npm test` が成功する
- OpenAI または Anthropic のAPIキーを少なくとも1つ持っている

確認:

```powershell
npm run build
npm test
```

## 2. APIキーを設定する

`.env.example` を元に `.env` を作成し、使うProviderのキーだけ設定する。

```powershell
Copy-Item .env.example .env
notepad .env
```

OpenAIだけで疎通する場合:

```env
OPENAI_API_KEY_ARTICLE=sk-...
ANTHROPIC_API_KEY_ARTICLE=
```

`config/models.yaml` の `providers.*.api_key_env` を未設定にする場合は、標準名 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` でも読み込まれる（`api_key_env` が空のときのフォールバック）。

Anthropicだけで疎通する場合:

```env
OPENAI_API_KEY_ARTICLE=
ANTHROPIC_API_KEY_ARTICLE=sk-ant-...
```

両方ある場合:

```env
OPENAI_API_KEY_ARTICLE=sk-...
ANTHROPIC_API_KEY_ARTICLE=sk-ant-...
```

`.env` はGit管理しない。

## 3. モデル名を確認する

`config/models.yaml` の初期値にはプレースホルダが含まれるため、実行前に現在利用できるモデルIDへ差し替える。

公式ドキュメント:

- [OpenAI Models](https://platform.openai.com/docs/models)
- [Anthropic Models overview](https://docs.anthropic.com/en/docs/about-claude/models/overview)

OpenAIだけで最小疎通する場合は、まず全タスクをOpenAIの同一モデルに寄せると切り分けしやすい。  
キー未設定のProviderは実行時に自動でスキップされるため、anthropic の fallback 行は無理に消さなくてもよい（キーが無ければ候補から外れ、primary が使われる）。

例（`tasks` ブロックのみの抜粋。`providers` / `prices` / `defaults` は既存のまま残す。ワークフローが使わない `markdown_format` / `title_suggestions` は省略可）:

```yaml
tasks:
  article_brief:
    primary:
      provider: openai
      model: <openai-model-id>
    temperature: 0.2
    max_tokens: 1200

  outline:
    primary:
      provider: openai
      model: <openai-model-id>
    temperature: 0.2
    max_tokens: 1200

  draft_markdown:
    primary:
      provider: openai
      model: <openai-model-id>
    temperature: 0.3
    max_tokens: 2000

  technical_review:
    primary:
      provider: openai
      model: <openai-model-id>
    temperature: 0.2
    max_tokens: 1200

  rewrite:
    primary:
      provider: openai
      model: <openai-model-id>
    temperature: 0.3
    max_tokens: 2000
```

推論系モデルなど、`temperature` を受け付けないモデルではProvider側が送信を抑制する。ただし、モデル名は必ず実行時点の公式ドキュメントやダッシュボードで確認する。

## 4. 最小トピックで実行する

短いテーマで `article:create` を実行する。

```powershell
llm-task-router article:create --topic "TypeScriptでJSONを安全に読む"
```

長文の指示（対象読者・論点・制約など）を渡す場合はテキストファイルを使う。

```powershell
llm-task-router article:create --topic-file topics/json-safe.txt
```

`--topic` と `--topic-file` はどちらか一方を指定する（両方指定するとエラー）。`--topic-file` のときの `runId` はファイル名から生成される（例: `json-safe.txt` → `2026-06-16-json-safe`）。なお `.env` などの秘密ファイルは指示ファイルとして読み込めない。

実行中は各工程の進捗が stderr に表示される（`runId` / `final` パスは stdout）。使用provider/model・所要時間・概算コストが出るため、フォールバックの有無やおおよその費用をここで確認できる。

```text
[1/5] brief (article_brief) ...
[1/5] brief - done via openai/gpt-5.4 (2310ms, ~$0.0123)
...
total: ~$0.1240 (estimate)
```

コストは `models.yaml` の `prices` に基づくローカル概算で、表示のための追加APIコールは無い。単価は価格改定で変わるため、`prices` は定期的に確認する。

成功すると次のような出力になる。

```text
runId: 2026-06-16-typescript-json
final: runs/2026-06-16-typescript-json/final.md
```

## 5. 成果物を確認する

表示された `runId` に合わせて、生成物を確認する。

```powershell
Get-ChildItem runs\<runId>
Get-Content runs\<runId>\meta.json
Get-Content runs\<runId>\final.md
```

期待されるファイル:

- `brief.json`
- `outline.json`
- `draft.md`
- `review.json`
- `final.md`
- `meta.json`

`meta.json` の各stepが `done` になっていれば、ワークフロー完走。

## 6. ログを確認する

Routerログを確認する。

```powershell
Get-Content runs\router.log
```

確認ポイント:

- `status` が `success` になっている
- `input_hash` はあるが、全文プロンプトは保存されていない
- APIキーが保存されていない
- fallbackが起きた場合、失敗行の `error_kind` を確認できる

## 7. 途中で失敗した場合

途中成果物がある場合は、同じ `runId` で再開する。

```powershell
llm-task-router article:resume --run <runId>
```

レビュー工程以降だけ再実行する場合:

```powershell
llm-task-router article:review --run <runId>
```

`final.md` に自由な修正指示を反映する場合:

```powershell
llm-task-router article:revise --run <runId> --instruction "前半を簡潔に。専門用語は初出で1行説明"
# 長文の指示はファイルでも渡せる
llm-task-router article:revise --run <runId> --instruction-file work/revise.md
```

`article:revise` は現在の `final.md` を `final.bak.md` に退避してから上書きする。

`final.md` を評価し、修正指示の草案を生成する場合（標準は評価観点テンプレを渡す）:

```powershell
llm-task-router article:evaluate --run <runId> --min-severity minor
# 評価観点は run の profile（meta.json）から自動解決される（config/criteria/*.md）
# -> runs/<runId>/final-review.json, runs/<runId>/final-review.md, runs/<runId>/revise-instruction.md
llm-task-router article:revise --run <runId> --instruction-file runs/<runId>/revise-instruction.md
```

評価は審査役（本文と別系統のモデル）で行う。観点は profile の `criteria_file`（`config/criteria/*.md`）で対象ごとに固定され、比較可能になる。一回限り別観点で見たいときは `--criteria-file <path>` で上書きする。

## 8. よくある失敗

### APIキー未設定

症状:

キーが無いProviderは未登録としてスキップされ、候補を使い切ると次のメッセージで終了する。

```text
All model candidates failed: Provider is not registered: openai
```

確認:

- `.env` に `OPENAI_API_KEY_ARTICLE` または `ANTHROPIC_API_KEY_ARTICLE` が入っているか
- `config/models.yaml` の `providers.*.api_key_env` と `.env` の名前が一致しているか

### モデル名が不正

症状:

CLI標準出力には次の形で出る。

```text
All model candidates failed: <SDKのエラーメッセージ>
```

`runs/router.log` の `error_kind` は、多くの場合 404 のため `unknown`、400 を返すProviderでは `bad_request` になる。いずれもfallbackせず即停止する。

対応:

- 公式モデル一覧でモデルIDを確認する
- `config/models.yaml` の全タスクの `model` を修正する

### 課金枠不足

症状:

`runs/router.log` に以下のような行が出る。

```json
{"error_kind":"billing_quota"}
```

対応:

- 課金設定、利用上限、プロジェクト上限を確認する
- このエラーは安全のためfallbackしない

### rate limit または timeout

症状:

`runs/router.log` に以下のような `error_kind` が出る。

```text
rate_limit
timeout
overloaded
service_unavailable
```

対応:

- fallback候補が設定されていれば次candidateへ進む
- 片方のProviderキーしかない場合は、同Provider内の別モデルをfallbackに設定すると切り分けしやすい
- `defaults.timeout_ms` またはタスク別 `timeout_ms` を一時的に伸ばす

## 9. 疎通完了の判断

以下を満たせば最小疎通は完了。

- `llm-task-router article:create --topic "TypeScriptでJSONを安全に読む"` が終了する
- `runs/<runId>/final.md` が生成される
- `runs/<runId>/meta.json` の全stepが `done`
- `runs/router.log` にAPIキーや全文プロンプトが含まれていない

疎通後、必要に応じて `config/models.yaml` のタスク別primary/fallback、`max_tokens`、単価設定 `prices` を調整する。
