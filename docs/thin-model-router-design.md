# 薄い ModelRouter 設計書

作成日: 2026-06-16  
目的: Qiita記事作成などの個人・小規模用途で、複数の生成AIを安全に使い分けるための最小限のModelRouterを設計する。

---

## 1. 背景

ChatGPT、Claude、Geminiなどの生成AIには、Web版の時間制限、週制限、混雑、モデルごとの得意不得意がある。  
また、LiteLLMのような高機能プロキシは便利だが、APIキーやプロンプトを集約するため、セキュリティ上の攻撃面が広がる。

そこで、Qiita記事作成や技術記事作成に必要な範囲に限定した、薄いModelRouterを自作する。

---

## 2. 設計方針

### 2.1 やること

- タスク別のモデル選択
- 複数AIへのフォールバック
- リトライ
- タイムアウト
- 途中成果物の保存
- 出力スキーマ検証
- 最小限の使用ログ
- コスト概算
- APIキーの分離管理

### 2.2 やらないこと

- Web管理画面
- 外部公開API
- ユーザー管理
- 動的な設定変更API
- 任意コード実行
- 任意URLアクセス
- プラグイン実行
- DBへの全文プロンプト保存
- 複雑な認証基盤

薄く作ることで、セキュリティリスクと保守コストを抑える。

---

## 3. 想定ユースケース

主な用途はQiita記事作成。

```text
記事テーマ
  ↓
Article Brief作成
  ↓
構成案作成
  ↓
コード例作成
  ↓
Qiita向けMarkdown生成
  ↓
技術レビュー
  ↓
リライト
  ↓
final.md出力
```

---

## 4. 全体アーキテクチャ

```text
Article Workflow
  ↓
ModelRouter
  ↓
Provider
  ├─ OpenAIProvider
  ├─ AnthropicProvider
  ├─ GeminiProvider
  └─ LocalProvider
  ↓
SchemaValidator
  ↓
RunStore
  ↓
Markdown / JSON成果物
```

---

## 5. 推奨技術スタック

### 5.1 言語

TypeScriptを推奨する。

理由:

- JSON / YAML / Zodとの相性が良い
- CLIツール化しやすい
- Codex / Claude Code のどちらでも扱いやすい
- 将来的にWeb UIへ拡張しやすい
- Qiita記事生成やMarkdown処理と相性が良い

### 5.2 主なライブラリ候補

| 用途 | 候補 |
|---|---|
| スキーマ検証 | Zod |
| YAML読み込み | yaml |
| CLI | commander / cac |
| ファイル操作 | Node.js fs/promises |
| ログ | pino または独自JSONログ |
| OpenAI API | openai |
| Anthropic API | @anthropic-ai/sdk |
| Gemini API | @google/genai |
| ローカルLLM | Ollama APIなど |

---

## 6. ディレクトリ構成

```text
model-router/
  package.json
  tsconfig.json
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
      GeminiProvider.ts
      LocalProvider.ts
    schemas/
      ArticleBriefSchema.ts
      ArticleOutlineSchema.ts
      ReviewResultSchema.ts
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
  runs/
    .gitkeep
```

---

## 7. タスク定義

```ts
export type ModelTask =
  | "article_brief"
  | "outline"
  | "draft_markdown"
  | "technical_review"
  | "rewrite"
  | "markdown_format"
  | "title_suggestions";
```

タスクを分けることで、モデルごとの得意不得意に応じてルーティングできる。

---

## 8. 共通リクエスト型

```ts
export type ModelRequest = {
  task: ModelTask;
  input: string;
  system?: string;
  schemaName?: string;
  maxTokens?: number;
  temperature?: number;
};
```

MVPでは `priority` は実装しない。  
品質・コスト・速度の切り替えが必要になった時点で、`models.yaml` 側に候補グループを追加してから型へ戻す。

---

## 9. 共通レスポンス型

```ts
export type ModelResponse = {
  provider: string;
  model: string;
  text: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
  elapsedMs: number;
};
```

---

## 10. Providerインターフェース

```ts
export type ProviderRequest = {
  model: string;
  system?: string;
  input: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  responseFormat?: {
    type: "text" | "json_schema";
    schemaName?: string;
    jsonSchema?: unknown;
  };
};

export type ProviderResponse = {
  text: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
};

export interface ModelProvider {
  generate(request: ProviderRequest): Promise<ProviderResponse>;
}
```

ModelRouterは各AIのAPI仕様を直接知らない。  
OpenAI、Claude、Geminiなどの差分はProvider側に閉じ込める。

ProviderはSDK固有の例外も正規化する。  
RouterはOpenAI / Anthropicなどの例外型や生レスポンスを直接扱わず、`RouterErrorKind` のような安全な分類だけを見てフォールバック可否を判断する。

```ts
export type RouterErrorKind =
  | "rate_limit"
  | "timeout"
  | "overloaded"
  | "service_unavailable"
  | "connection"
  | "auth"
  | "billing_quota"
  | "context_length"
  | "schema_validation"
  | "bad_request"
  | "config"
  | "unknown";

export class RouterError extends Error {
  constructor(
    message: string,
    public readonly kind: RouterErrorKind,
    public readonly statusCode?: number
  ) {
    super(message);
  }
}
```

一部Providerやモデルでは `temperature`、`top_p`、`top_k` などの推論パラメータを受け付けない場合がある。  
Provider側はモデル仕様に応じて未対応パラメータを送らない、または設定エラーとして明示的に扱う。

Anthropic APIのように `max_tokens` が必須のProviderでは、`maxTokens` 未指定時にProvider側の安全なデフォルト値を使う。

`responseFormat` は将来的にOpenAI / Anthropicなどの構造化出力を使うための拡張点である。MVPではプロンプト + JSON parse + Zod検証でもよいが、Providerインターフェース上は構造化出力へ寄せられる余地を残す。

---

## 11. models.yaml 設定例

```yaml
providers:
  openai:
    api_key_env: OPENAI_API_KEY_ARTICLE
  anthropic:
    api_key_env: ANTHROPIC_API_KEY_ARTICLE

prices:
  openai:
    gpt-5.5:
      input_usd_per_1m_tokens: 0
      output_usd_per_1m_tokens: 0
  anthropic:
    claude-opus:
      input_usd_per_1m_tokens: 0
      output_usd_per_1m_tokens: 0

defaults:
  timeout_ms: 120000

tasks:
  article_brief:
    primary:
      provider: openai
      model: gpt-5.5
    fallback:
      - provider: anthropic
        model: claude-opus
      - provider: gemini
        model: gemini-pro
    temperature: 0.4
    max_tokens: 4000

  outline:
    primary:
      provider: anthropic
      model: claude-opus
    fallback:
      - provider: openai
        model: gpt-5.5
      - provider: gemini
        model: gemini-pro
    temperature: 0.4
    max_tokens: 4000

  draft_markdown:
    primary:
      provider: openai
      model: gpt-5.5
    fallback:
      - provider: anthropic
        model: claude-sonnet
      - provider: local
        model: qwen-local
    temperature: 0.6
    max_tokens: 12000
    timeout_ms: 180000

  technical_review:
    primary:
      provider: anthropic
      model: claude-opus
    fallback:
      - provider: openai
        model: gpt-5.5
      - provider: gemini
        model: gemini-pro
    temperature: 0.2
    max_tokens: 6000

  markdown_format:
    primary:
      provider: local
      model: qwen-local
    fallback:
      - provider: openai
        model: mini
    temperature: 0.2
    max_tokens: 8000
```

実際のモデル名は利用時点のAPIで確認して設定する。
`prices` はコスト概算用の任意設定であり、未設定または `0` の場合は `costUsd` を出さないか、ベストエフォートの概算として扱う。
単価は頻繁に変わるため、コードに固定せず設定ファイル側で管理する。

`providers.*.api_key_env` が指定されている場合はそのenv名を優先する。  
未指定時は `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY` のようなProvider標準名を使う。

---

## 12. ModelRouterの中核処理

```ts
export class ModelRouter {
  constructor(
    private providers: Record<string, ModelProvider>,
    private config: RouterConfig,
    private logger: RunLogger
  ) {}

  async run(request: ModelRequest): Promise<ModelResponse> {
    const taskConfig = this.config.tasks[request.task];

    const candidates = [
      taskConfig.primary,
      ...(taskConfig.fallback ?? []),
    ];

    let lastError: unknown;

    for (const candidate of candidates) {
      const provider = this.providers[candidate.provider];

      if (!provider) {
        continue;
      }

      try {
        const startedAt = Date.now();

        const response = await provider.generate({
          model: candidate.model,
          input: request.input,
          system: request.system,
          temperature: request.temperature ?? taskConfig.temperature,
          maxTokens: request.maxTokens ?? taskConfig.max_tokens,
          timeoutMs: taskConfig.timeout_ms ?? this.config.defaults.timeout_ms,
          responseFormat: resolveResponseFormat(request.schemaName),
        });

        const result: ModelResponse = {
          provider: candidate.provider,
          model: candidate.model,
          text: response.text,
          usage: response.usage,
          elapsedMs: Date.now() - startedAt,
        };

        const validated = await this.validateAndMaybeRepair(
          request,
          candidate,
          result
        );

        await this.logger.logSuccess(request, validated);
        return validated;
      } catch (error) {
        const normalized = normalizeProviderError(error);
        lastError = normalized;
        await this.logger.logFailure(request, candidate, normalized);

        if (!this.shouldFallback(normalized.kind)) {
          throw normalized;
        }
      }
    }

    throw new Error(`All model candidates failed: ${String(lastError)}`);
  }

  private shouldFallback(kind: RouterErrorKind): boolean {
    return [
      "rate_limit",
      "timeout",
      "overloaded",
      "service_unavailable",
      "connection",
      "schema_validation",
    ].includes(kind);
  }
}
```

`normalizeProviderError()` は文字列マッチではなく、Provider側でSDKの型付き例外、HTTP status、エラーコードを見て分類する。  
ログには正規化済みの `kind`、安全な短い `message`、status code程度だけを保存し、生のSDK例外やヘッダを丸ごと保存しない。

SDK内リトライとRouterのフォールバックは役割を分ける。  
MVPではSDKの標準リトライをProvider内リトライ、候補モデルの切り替えをRouterの責務とする。必要ならProvider初期化時にSDKリトライ回数を明示する。

---

## 13. フォールバック方針

### 13.1 フォールバックするエラー

- rate limit
- timeout
- overloaded
- 5xx
- temporary unavailable
- API connection error
- 出力JSONのparse / Zod検証失敗後、同一candidateでの修復も失敗した場合

### 13.2 フォールバックしないエラー

- APIキー未設定
- APIキー不正
- 認証エラー
- 入力が長すぎる
- schemaName未定義・不正などの設定ミス
- 禁止された内容
- 課金枠不足
- 料金上限超過
- 設定ミス

フォールバックしないエラーまで別モデルに投げると、無駄な課金や意図しない情報送信が起きる。

`quota` という文字列だけでは判定しない。  
rate limitのような一時的な制限はフォールバック対象だが、課金枠不足、支払い上限、プロジェクト上限などのbilling quota系エラーはフォールバックしない。

スキーマ系エラーは2種類に分ける。  
`schemaName` が未定義・不正など、設定側が間違っている場合は `config` として即終了し、フォールバックしない。AIの出力がJSON parseまたはZod検証に失敗し、同一candidateでの修復1回にも失敗した場合は `schema_validation` として次candidateへ進む。

---

## 14. Qiita記事作成ワークフロー

```ts
async function createQiitaArticle(topic: string) {
  const brief = await router.run({
    task: "article_brief",
    input: `
次のテーマでQiita記事のArticle Briefを作成してください。

テーマ:
${topic}

出力はJSON形式。
`,
    schemaName: "ArticleBrief",
  });

  await store.save("brief.json", brief.text);

  const outline = await router.run({
    task: "outline",
    input: `
次のArticle BriefからQiita記事の構成を作ってください。

${brief.text}
`,
    schemaName: "ArticleOutline",
  });

  await store.save("outline.json", outline.text);

  const draft = await router.run({
    task: "draft_markdown",
    input: `
次の構成からQiita向けMarkdown本文を書いてください。

${outline.text}
`,
  });

  await store.save("draft.md", draft.text);

  const review = await router.run({
    task: "technical_review",
    input: `
次のQiita記事を技術レビューしてください。
問題点、改善案、修正すべき箇所をJSONで返してください。

${draft.text}
`,
    schemaName: "ReviewResult",
  });

  await store.save("review.json", review.text);

  const final = await router.run({
    task: "rewrite",
    input: `
次のレビューを反映して、Qiita記事を改善してください。

記事:
${draft.text}

レビュー:
${review.text}
`,
  });

  await store.save("final.md", final.text);

  return final.text;
}
```

---

## 15. 状態保存

制限やエラーで途中停止しても再開できるように、各工程の成果物を保存する。

```json
{
  "runId": "2026-06-16-ai-ir-article",
  "topic": "AI向けIRを設計する",
  "steps": {
    "brief": {
      "status": "done",
      "file": "brief.json"
    },
    "outline": {
      "status": "done",
      "file": "outline.json"
    },
    "draft": {
      "status": "done",
      "file": "draft.md"
    },
    "review": {
      "status": "pending"
    }
  }
}
```

再開コマンド例:

```bash
npm run article:resume -- --run 2026-06-16-ai-ir-article
```

---

## 16. 出力スキーマ検証

Zodで中間成果物を検証する。
`schemaName` が指定された場合の検証責務は `ModelRouter.run()` に置く。  
ワークフロー層は検証済みの `ModelResponse.text` だけを保存し、未検証JSONを次工程へ渡さない。

```ts
import { z } from "zod";

export const ArticleBriefSchema = z.object({
  title: z.string(),
  targetReaders: z.array(z.string()),
  goal: z.array(z.string()),
  mainClaim: z.string(),
  sections: z.array(
    z.object({
      heading: z.string(),
      points: z.array(z.string()),
    })
  ),
  codeExamples: z.array(
    z.object({
      language: z.string(),
      purpose: z.string(),
    })
  ),
});
```

処理方針:

```text
AI出力
  ↓
JSON parse
  ↓
Zod検証
  ├─ OK → 次の工程
  └─ NG → 同一candidateへ修復依頼（最大1回）
        ├─ OK → 次の工程
        └─ NG → fallback model
```

修復依頼は無制限に繰り返さない。  
MVPでは各candidateにつき最大1回までとし、修復失敗時は `schema_validation` として正規化する。次のcandidateへ進むかどうかは設定で制御してもよいが、初期実装では「同一candidateの修復1回、それでも失敗したらfallback候補へ1回ずつ進む」方針にする。

ここでいう `schema_validation` は「AI出力が期待スキーマに合わない」ことを指す。  
`schemaName` がregistryに存在しない、schema定義自体が壊れている、といった設定ミスは `config` として扱い、修復依頼もフォールバックも行わない。

OpenAI / AnthropicなどProvider側でJSON schema形式の構造化出力を使える場合は、`ProviderRequest.responseFormat` にschema情報を渡す。  
ただしMVPではProviderごとの差分を小さくするため、構造化出力は必須ではなく、プロンプト + JSON parse + Zod検証を基準実装とする。

---

## 17. ログ設計

### 17.1 基本方針

ログには全文プロンプトを保存しない。  
成果物は `runs/` 配下に保存するが、ログはメタ情報中心にする。

```json
{
  "task": "draft_markdown",
  "provider": "openai",
  "model": "gpt-5.5",
  "status": "success",
  "input_hash": "sha256:xxxx",
  "elapsed_ms": 12000,
  "input_tokens": 5000,
  "output_tokens": 3000,
  "cost_usd": 0.12
}
```

### 17.2 保存しないもの

- APIキー
- `.env` の内容
- 認証トークン
- 外部サービスの秘密情報
- 機密性の高い入力本文

---

## 18. セキュリティ設計

### 18.1 外部公開しない

MVPではCLIのみ。  
HTTPサーバー化しない。  
管理画面を作らない。

### 18.2 APIキー管理

`.env` に保存し、Git管理しない。

```env
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...
```

`.env.example` のみコミットする。

### 18.3 権限分離

可能であれば用途ごとにAPIキーを分ける。

```env
OPENAI_API_KEY_ARTICLE=...
OPENAI_API_KEY_EXPERIMENT=...
ANTHROPIC_API_KEY_ARTICLE=...
```

### 18.4 任意コード実行を入れない

ModelRouter本体に任意シェル実行機能を入れない。  
コード検証が必要な場合は、別プロセス・別サンドボックスで行う。

### 18.5 外部URL取得を勝手にしない

外部URL取得機能はMVPでは持たない。  
将来的に入れる場合は許可ドメイン制にする。

---

## 19. CLI仕様案

コマンドは Qiita 専用ではないため `article:*` を正式名とする。設定（`config/`）・`.env`・`runs/` はすべて**カレントディレクトリ相対**で解決する。

### 19.0 init（設定雛形の展開）

グローバル導入時、作業ディレクトリに設定が無いと動かないため、同梱テンプレを展開する。

```bash
llm-task-router init            # config/ と .env.example を cwd へコピー
```

- コピー対象: 同梱の `config/`（models.yaml・profiles/・criteria/）と `.env.example`。コピー元は bin 位置からパッケージroot相対に解決。
- 書き込み先は **cwd 配下の固定パス**（任意パスは受け取らない）。既存ファイルは `--force` 無しでは上書きしない。`.env` は生成しない（`.env.example` のみ）。
- 展開後の流れ: `cp .env.example .env` → キー設定 → `config/models.yaml` のモデルID調整 → `article:create`。

### 19.1 新規記事作成

短いテーマはインラインで指定する。

```bash
npm run article:create -- --topic "AIが解釈しやすい中間言語を設計する"
```

長文の指示（対象読者・論点・制約など）はテキストファイルで渡す。

```bash
npm run article:create -- --topic-file topics/ai-ir.txt
```

- `--topic` と `--topic-file` のどちらかを指定する（両方指定時はエラー）。
- `--topic-file` のときの `runId` はファイル名ベースで生成する（例: `ai-ir.txt` → `2026-06-16-ai-ir`）。
- `--run <runId>` で `runId` を明示固定できる。
- `--profile <name>`（既定 `qiita`）で `config/profiles/<name>.yaml` のプロファイルを選ぶ。プロファイルは `platform`（プロンプトのラベル）、`style`（admonition記法・front-matter作法などをdraft/final/reviseの本文生成に注入）、`language` を持つ。同梱は `qiita` / `zenn` / `blog`。`--platform <name>` はラベルのみ上書き。解決した `platform` と `style` は `meta.json` に保存され、resume/review/revise/evaluate が自動継承する。
- プラットフォーム別の評価は対応する `--criteria-file` を併用する。プロファイルは「作法（コードを増やさず外部YAMLで管理）」、criteria は「評価観点」を担い、models.yaml（モデル選択）と合わせて設定3点で多目的化する。
- 段階的拡張：プラットフォーム固有の記法変換や `markdown_format` タスクの整形ステップ昇格は、必要になった時点で追加する（現状は未使用）。

### 19.2 途中再開

```bash
npm run article:resume -- --run 2026-06-16-ai-ir-article
```

### 19.3 レビューのみ再実行

draft.md から自動レビュー → rewrite をやり直す（利用者の指示は使わない）。

```bash
npm run article:review -- --run 2026-06-16-ai-ir-article
```

### 19.4 final.md への修正指示

現在の `final.md` に、利用者の自由な修正指示を反映して書き直す。

```bash
npm run article:revise -- --run 2026-06-16-ai-ir-article --instruction "前半を簡潔に。専門用語は初出で1行説明"
```

長文の指示はファイルでも渡せる。

```bash
npm run article:revise -- --run 2026-06-16-ai-ir-article --instruction-file work/revise.md
```

- `--instruction` と `--instruction-file` のどちらか必須（両方指定時はエラー）。
- `rewrite` タスクで現在の `final.md` ＋ 指示を処理し、`final.md` を上書きする。
- 上書き前の版は `final.bak.md` に退避する。繰り返し実行可能。

### 19.5 final.md の評価と修正指示の生成

現在の `final.md` を評価し、結果を `final-review.json` に保存する。評価で見つかった指摘から修正指示ファイル `revise-instruction.md` を生成する（自動でrewriteはしない）。

```bash
npm run article:evaluate -- --run 2026-06-16-ai-ir-article --min-severity major
```

評価観点は run の profile から自動解決される（指定不要）。一回限り別観点で見たいときだけ明示する。

```bash
# 観点は profile（meta.json）→ criteria_file から自動解決
npm run article:evaluate -- --run 2026-06-16-ai-ir-article
# 一回だけ別観点にしたいとき（インライン / ファイルで上書き）
npm run article:evaluate -- --run 2026-06-16-ai-ir-article --criteria "正確性とコード例の動作を重視"
npm run article:evaluate -- --run 2026-06-16-ai-ir-article --criteria-file config/criteria/note.md
```

- 審査役は本文の書き手と**別系統のモデル**にする（`models.yaml` の `final_review` タスク。既定は anthropic 主審査、本文の `rewrite` は openai 主体）。
- `--min-severity`（`critical|major|minor|suggestion`、既定 `suggestion`＝全件）で指示に含める指摘を絞る。
- 出力は `runs/<runId>/` 固定で3つ：`final-review.json`（生スコアカード）、`final-review.md`（人が読むサマリ＝判定・severity別件数・全指摘）、`revise-instruction.md`（`--min-severity` で絞った修正指示）。
- `final-review.md` は severityフィルタを掛けず全指摘を含める（人の確認用）。`revise-instruction.md` のみフィルタ済み（rewriteへの入力用）。
- 評価結果からの指示生成は**ローカル整形で追加APIコール無し**（評価1回のみ課金）。
- 生成された `revise-instruction.md` は草案。人が確認・編集してから `article:revise --instruction-file` で適用する（自動適用はしない）。
- 指定 severity 以上の指摘が無い場合は `revise-instruction.md` を作らない。
- 評価観点は `config/criteria/*.md` に置き、profile の `criteria_file` で対象に紐づける。`evaluate` は run の profile（`meta.json`）から観点を**自動解決**する。解決順は `--criteria` > `--criteria-file` > profile の `criteria_file` > なし。共通デフォルトは `config/criteria/default.md`（qiita/zenn/blog）、note は読み物重視の `config/criteria/note.md`。観点を対象ごとに固定することで LLM-as-judge の揺れを抑え、評価を比較可能にする。

連携フロー:

```bash
npm run article:evaluate -- --run <runId> --min-severity major
# revise-instruction.md を確認・編集
npm run article:revise -- --run <runId> --instruction-file runs/<runId>/revise-instruction.md
```

### 19.6 最終記事のエクスポート

完成した `final.md` を、指定したパスへ書き出す。

```bash
npm run article:export -- --run <runId> --out ../zenn-content/articles/my-article.md
```

- 対象は **`final.md` のみ**（中間成果物は出さない）。
- ガード: 出力先が `.env` 等の秘密ファイル名なら拒否、既存ファイルは `--force` 無しでは上書きしない、ワークスペース外は警告（拒否しない）。親ディレクトリは自動作成。
- これは「CLI引数から任意の書き込み先を受け取らない」原則の**明示的な例外**。内部成果物は `runs/<runId>/` に閉じたままで、ユーザーが明示した出力だけを許可する（モデル設定不要・API不要のファイル操作）。

### 19.7 実行推移の表示

全コマンドは工程の進捗を **stderr** に出力する。`runId` と `final` パスは **stdout** に出すため、スクリプトでの解析と進捗表示が混ざらない。

```text
[1/5] brief (article_brief) ...
[1/5] brief - done via openai/gpt-5.4 (2310ms, ~$0.0123)
[2/5] outline (outline) ...
[2/5] outline - done via anthropic/claude-opus-4-8 (4120ms, ~$0.0456)
...
total: ~$0.1240 (estimate)
```

- 各工程の **使用provider/model・所要時間・概算コスト** を表示し、最後に **run合計** を出す。設定上のprimaryと異なるproviderが表示された場合はフォールバックが起きたと判断できる。
- `article:resume` / `article:review` では完了済み工程を `skip (done)` と表示する。
- 進捗は補助情報であり、機械処理が必要な値（`runId` など）は stdout 側に出す。

#### 出力ガード

本文（スキーマ無し）工程には保存前の軽量ガードを設ける。

- **truncation検知**: Provider応答が `max_tokens` / `max_output_tokens` で打ち切られた場合、その工程に警告を表示する（`models.yaml` の `max_tokens` を増やす目安になる）。
- **全体コードフェンス除去**: モデルが本文全体を ` ``` ` で囲んで返した場合のみ、外側フェンスを剥がして保存する。文中の正当なコードブロックや、複数コードブロックを含む本文には手を加えない。
- **ラップ文検知（警告のみ）**: 本文が見出し(#)で始まらない（前置きの疑い）、または末尾が追加提案・問いかけ（『…で出し直せます』等）になっている場合に警告する。自然文は正当な導入/結論と区別しにくいため**自動削除はせず**、修正は人に委ねる（プロンプト硬化が主防御、本ガードは回帰検知の安全網）。
- スキーマ工程（`brief`/`outline`/`review`）は検証済みJSONを保存するためガード対象外。

#### コスト概算について

- コストはレスポンス同梱の `usage`（トークン数）× `models.yaml` の `prices`（USD/1Mトークン）による**ローカル概算**で、表示のための追加API（count_tokens等）は呼ばない。
- `prices` 未設定または `0` のモデルはコストを出さない（`total` も加算されない）。
- 単価は価格改定でドリフトするため設定ファイルで管理する。プロンプトキャッシュ等の割引は概算に含めない。
- 修復（schema検証失敗時の再生成）が走った場合、検証失敗した初回コール分のトークンは概算に含まれない（やや過小評価）。

---

## 20. MVPスコープ

### 20.1 実装する

- TypeScript CLI
- models.yaml読み込み
- OpenAIProvider
- AnthropicProvider
- タスク別モデル選択
- フォールバック
- Zod検証
- ファイル保存
- JSONメタログ
- Qiita記事作成ワークフロー

### 20.2 後回し

- GeminiProvider
- LocalProvider
- Web UI
- Qiita API投稿
- GitHub連携
- LangGraph連携
- Dify連携
- 複雑なコスト最適化

---

## 21. Codex と Claude Code のどちらで実装するか

### 21.1 結論

このMVPは **Codex を第一候補** にする。

理由:

- TypeScriptのCLIプロジェクトを段階的に作る用途に合う
- 設計書からファイル構成、テスト、リファクタリングまで進めやすい
- OpenAI API連携やStructured Outputs周辺との相性が良い
- 今回の設計では「仕様通りに薄く作る」ことが重要で、Codexの明示的な実装・レビュー・修正の流れと相性が良い

Claude Code は第二候補として使う。

Claude Codeが向いている場面:

- 既存コードベースを広く読ませたい
- 長い設計書や仕様書を踏まえて改善させたい
- CLIで対話しながら一気に実装したい
- 文章、README、Qiita本文、設計意図の整理も同時に進めたい

### 21.2 おすすめ分担

| 作業 | 推奨 |
|---|---|
| 初期プロジェクト作成 | Codex |
| 型定義・Provider実装 | Codex |
| テスト追加 | Codex |
| README整備 | Claude Code |
| 設計書レビュー | Claude Code |
| Qiita記事化 | Claude Code または GPT |
| セキュリティ観点レビュー | Claude Code + 人間レビュー |

### 21.3 実務上の最適解

どちらか一方に固定しない。  
最初はCodexでMVPを作り、その後Claude Codeでレビュー・README・改善提案を行う。

```text
Codex:
  仕様通りに実装する担当

Claude Code:
  仕様の穴を探す、説明を整える、改善案を出す担当
```

---

## 22. Codex向け初回プロンプト例

```text
このリポジトリに、TypeScript製の薄いModelRouter CLIを実装してください。

目的:
- Qiita記事作成フローでOpenAI/Anthropicをタスク別に呼び分ける
- LiteLLMのような高機能プロキシにはしない
- 外部公開API、Web UI、任意コード実行は実装しない

実装範囲:
- src/router/ModelRouter.ts
- src/router/config.ts
- src/router/errors.ts
- src/router/types.ts
- src/providers/ModelProvider.ts
- src/providers/OpenAIProvider.ts
- src/providers/AnthropicProvider.ts
- src/storage/RunStore.ts
- src/logger/RunLogger.ts
- src/workflows/createQiitaArticle.ts
- config/models.yaml
- .env.example
- README.md

要件:
- models.yamlでタスク別primary/fallbackを定義
- rate limit / timeout / overloaded / 一時的な5xx の場合のみfallback
- 認証エラー、入力過大、schemaName不正、課金枠不足、設定ミスではfallbackしない
- AI出力のJSON parse / Zod検証失敗は同一candidateで最大1回修復し、失敗したらschema_validationとして次candidateへ進める
- SDK固有例外はProvider側で正規化し、Routerは文字列マッチでfallback判定しない
- runs/<runId>/ に brief.json, outline.json, draft.md, review.json, final.md, meta.json を保存
- ログにAPIキーや全文プロンプトを保存しない
- ZodでArticleBriefとReviewResultを検証し、schemaName指定時はRouter内で最大1回だけ修復依頼する
- npm scriptで article:create と article:resume を用意する
- テストを追加する
```

---

## 23. Claude Code向けレビュー依頼例

```text
このModelRouter実装をレビューしてください。

観点:
- 設計書に対して過剰実装になっていないか
- セキュリティ上危険な機能が入っていないか
- APIキーやプロンプト本文がログに漏れないか
- fallbackすべきでないエラーをfallbackしていないか
- Qiita記事作成フローとして再開可能になっているか
- READMEが利用者にとって十分か
- TypeScriptの型設計が保守しやすいか

出力:
- 重大な問題
- 改善した方がよい点
- 後回しでよい点
- 具体的な修正案
```

---

## 24. 今後の拡張候補

1. GeminiProvider追加
2. LocalProvider追加
3. Ollama対応
4. GitHubへの成果物保存
5. Qiita API下書き投稿
6. 記事テンプレート切り替え
7. コスト上限
8. LangGraph連携
9. Dify連携
10. Web UI

---

## 25. まとめ

このModelRouterは、複数AIを扱うための最小限の制御層である。

```text
薄いModelRouter
  = タスク別モデル選択
  + フォールバック
  + 成果物保存
  + スキーマ検証
  + 最小限ログ
```

MVPでは外部公開やWeb UIを避け、CLIとファイル保存に限定する。  
実装はCodexを第一候補、Claude Codeをレビュー・ドキュメント改善担当として併用するのが最も現実的である。
