# Qiita 記事作成 手順書（llm-task-router）

llm-task-router を使って Qiita 記事を「作成 → 評価 → 修正 → ファクトチェック → 書き出し」まで回すための手順書。

> 役割分担の前提
> - **本文生成・評価・修正の品質**は llm-task-router 内部のモデル（`config/models.yaml`）が担保する。本文執筆=OpenAI、構成/審査=Claude。
> - **外側のAI（codex / claude code）はオペレーター役**。CLI を叩き、`final-review.md` を読んで判断する。本文を直接書き換えない。
> - **ファクトチェック（Web裏取り）はツールがやらない**唯一の穴。Web検索できる別系統のAI（本文がOpenAIなので Claude Code 推奨）で行い、結果は `article:revise --instruction-file` 経由で戻す。

---

## 0. 必要環境

- Node.js >= 20（`node --version` で確認）
- OpenAI / Anthropic の API キー

---

## 1. llm-task-router をグローバルインストール

```bash
# npm から（パッケージはスコープ付き。コマンド名は llm-task-router）
npm install -g @rex0220/llm-task-router

# 確認
llm-task-router -v
llm-task-router --help
```

ローカルの開発版を使う場合は、リポジトリ側で `npm run build && npm link`（不要になったら `npm rm -g llm-task-router`）。

---

## 2. Qiita 記事用フォルダーを作成して初期化

CLI は **カレントディレクトリ基準**で `config/`・`.env` を読み、`runs/` を書き出す。記事用の作業フォルダーを切る。

```bash
mkdir qiita-articles
cd qiita-articles

# config/ と .env.example をこの場所へ展開（既存は上書きしない。上書きは --force）
llm-task-router init
```

### 2.1 .env を設定

```bash
cp .env.example .env
```

`.env` を編集してキーを入れる。`config/models.yaml` は `*_ARTICLE` キーを参照する設定なので、そちらを埋めるのが確実：

```dotenv
# 記事ワークフロー用（models.yaml が参照）
OPENAI_API_KEY_ARTICLE=sk-...
ANTHROPIC_API_KEY_ARTICLE=sk-ant-...

# 汎用フォールバック名（未設定なら標準名にフォールバック）
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
```

### 2.2 モデルIDを確認

`config/models.yaml` のモデル名は**利用時点の公式ドキュメントで必ず確認**して実在IDに合わせる。
- OpenAI: https://developers.openai.com/api/docs/pricing
- Anthropic: https://docs.anthropic.com/en/docs/about-claude/models/overview

価格（`prices:`）もコスト概算に使うので、現行に合わせて更新する。

### 2.3 Qiita プロファイルの確認（既定でOK）

`--profile qiita`（既定値）が `config/profiles/qiita.yaml` を使う。Qiita 作法（言語付きコードフェンス、`:::note info/warn`、front-matter は本文に含めない）が本文プロンプトへ注入される。評価観点は `config/criteria/default.md`。基本そのままでよい。

フォルダー構成（init 直後）：

```text
qiita-articles/
├─ .env
├─ config/
│  ├─ models.yaml
│  ├─ profiles/qiita.yaml
│  └─ criteria/default.md
├─ topics/        ← 指示プロンプトを置く（自分で作成）
└─ runs/          ← 生成物（自動作成）
```

---

## 3. 指示プロンプト（topic-file）を書く

短いテーマなら `--topic "..."`、しっかり指定するなら `topics/*.txt` に書いて `--topic-file` で渡す（両方指定はエラー）。
ファイル名から runId が決まる（`ai-ir.txt` → `2026-06-18-ai-ir`）。

### 3.1 指示プロンプトのテンプレート

`topics/ai-ir.txt` を作成：

```text
# タイトル仮
AIが解釈しやすい中間言語（IR）を設計する

# 想定読者
TypeScript で開発する中級エンジニア。コンパイラ/IR の前提知識は薄め。

# 記事のゴール（読者が得るもの）
- IR を設計する際の判断基準を3点で説明できる
- 最小実装を手元で動かせる

# 含めたい要素
- 背景と課題（なぜ中間言語が要るか）
- 設計方針3点（具体例つき）
- TypeScript の最小サンプル（そのまま動く・import 明記）
- 落とし穴とまとめ

# トーン / 制約
- 煽らない。断定しすぎない。未解明点は「まだ分かっていない」と明示
- コードは Node 20 / TypeScript 前提を明記
- 文字数の目安: 4000〜6000字
```

> コツ：**想定読者・ゴール・含めたい要素・制約**の4点を具体的に書くほど質が安定する。
> 指示プロンプト自体を AI（codex / claude code どちらでも可）と対話で練ってから保存するとよい。

---

## 4. 記事を作成する

```bash
llm-task-router article:create --topic-file topics/ai-ir.txt --profile qiita
```

進捗は **stderr** に `[1/5] ...` 形式で出る（使用モデル・所要時間・概算コスト）。runId と最終パスは **stdout**。
生成物は `runs/<runId>/`（`draft.md` / `final.md` / `meta.json` など）。

途中で止まった場合：

```bash
llm-task-router article:resume --run 2026-06-18-ai-ir   # 未完ステップから再開
```

---

## 5. チェック・修正

### 5.1 自動ループで仕上げる（推奨の第一手）

`article:refine` が「評価→修正」を内部で自動反復する。まずこれで底上げする。

```bash
llm-task-router article:refine --run 2026-06-18-ai-ir \
  --max-rounds 3 --min-severity major --until clean
```

- `--max-rounds 3`：評価は最大3回（modelコールは最大 `2n-1`=5回）。安全弁。
- `--min-severity major`：major 以上の指摘が残る限り継続。
- `--until clean`：基準以上の指摘が消えたら停止（`approved` 指定で「審査が承認」を停止条件にできる）。

停止理由は `clean` / `approved` / `max-rounds` / `stalled`（改善が頭打ち）/ `regressed`（悪化＝巻き戻し提示）/ `no-instruction`。
各ラウンドの成果物は `runs/<runId>/refine-r<N>-*.md` と `refine-summary.md` に残る。`final.md` は常に最新版。

### 5.2 人が確認する（評価のみ・書き換えなし）

審査役モデルで `final.md` を採点し、指摘と修正指示の下書きを生成（自動では書き換えない）：

```bash
llm-task-router article:evaluate --run 2026-06-18-ai-ir --min-severity minor
```

出力：
- `final-review.json` … 生スコアカード
- `final-review.md` … 人が読む要約（判定・重大度別件数・全指摘）← **まずこれを読む**
- `revise-instruction.md` … `--min-severity` で絞った修正指示（レビューして編集可）

### 5.3 指示を当てて修正する

`revise-instruction.md` を確認・編集したうえで適用（`final.md` を書き換え、直前版を `final.bak.md` に退避）：

```bash
llm-task-router article:revise --run 2026-06-18-ai-ir \
  --instruction-file runs/2026-06-18-ai-ir/revise-instruction.md
```

自由記述の単発修正もできる：

```bash
llm-task-router article:revise --run 2026-06-18-ai-ir \
  --instruction "導入を短く。たとえ話を1つ追加。"
```

---

## 6. ファクトチェック（ツール外・必須）

llm-task-router の審査は LLM-as-judge のみで **Web検証はしない**。ここは外側AIで埋める。

1. **本文と別系統**のAI（本文=OpenAI のため、Web検索できる **Claude Code** を推奨）に `runs/<runId>/final.md` を読ませる。
2. 事実・数値・API/バージョン・出典の裏取りをさせ、**誤り箇所と要出典箇所を「修正指示」としてまとめさせる**（このとき本文は直接書き換えさせない）。
3. その指示を `runs/<runId>/factcheck-instruction.md` に保存し、ツールに戻す：

```bash
llm-task-router article:revise --run 2026-06-18-ai-ir \
  --instruction-file runs/2026-06-18-ai-ir/factcheck-instruction.md
```

> なぜ revise 経由で戻すか：成果物を `runs/` に集約し、`final.bak.md` のバックアップと criteria/meta の整合を保つため。外側AIに `final.md` を直接編集させない。

---

## 6.5 ビルド検証（コードを含む記事は必須）

ファクトチェックは**論理レビュー**であり、コードを実際にコンパイル/実行はしない。型の絞り込み失敗や tsconfig 依存の不通は、論理だけでは構造的にすり抜ける（実例: `tsc` で TS2339/TS2580 がビルド不通でも「事実誤認ゼロ」になり得る）。コードを含む記事では、事実検証とは**別系統の実機検証**を必ず回す。

1. 外側AI（`article-build-verifier` 役）に `runs/<runId>/final.md` を読ませる。
2. **使い捨ての一時ディレクトリ**に、記事掲載どおりの `package.json` / `tsconfig` で最小プロジェクトを再現し、`npm install` → `tsc` →（必要なら）実行して期待出力と一致するか確認させる。
3. 不通・不一致を `runs/<runId>/build-verify-instruction.md` にまとめさせ、ツールに戻す：

```bash
llm-task-router article:revise --run 2026-06-18-ai-ir \
  --instruction-file runs/2026-06-18-ai-ir/build-verify-instruction.md
```

> ファクトチェック（事実・Web）と実機ビルド検証は別系統の2検証。`init` で入る `article-build-verifier` サブエージェントがこの役を担う。記事のコードは信頼できない入力として一時ディレクトリ内に隔離して扱う。

---

## 7. 書き出し

完成したら `final.md` を任意のパス（Qiita 投稿用リポジトリ等）へコピー：

```bash
llm-task-router article:export --run 2026-06-18-ai-ir \
  --out ../qiita-content/ai-ir.md          # 既存があれば上書きは --force
```

`export` は秘密ファイル名（`.env*`）を拒否し、ワークスペース外への書き出しは警告する。書き出されるのは `final.md` のみ。

---

## 承認回数を減らす（Claude Code の permission）

Claude Code で回すと Bash 実行のたびに承認を求められ、数が多いと中身を見ずに承認しがちになる。`init` は `.claude/settings.json` に **pipeline 系コマンドだけの allowlist** を入れて配るので、`create / refine / evaluate / revise / resume / review` は事前許可済み（プロンプトが出ない）。

意図的に**プロンプトを残している**のは次の2つ — ここは毎回中身を見て承認する：

- `article:export`（公開相当の操作）
- `article-build-verifier` の `npm install` / `tsc` / `node`（記事内の**未知コードを実行**する部分）

許可を足したい/外したい場合は `.claude/settings.json` の `permissions.allow` を編集する。設定変更は次回セッション開始時に反映される。

---

## 付録：典型的な1記事のフロー

```bash
# 0) 初期化（初回のみ）
cd qiita-articles && llm-task-router init && cp .env.example .env   # → .env 編集

# 1) 指示を書く
#    topics/ai-ir.txt を作成

# 2) 作成
llm-task-router article:create --topic-file topics/ai-ir.txt --profile qiita

# 3) 自動で底上げ
llm-task-router article:refine --run 2026-06-18-ai-ir --max-rounds 3 --until clean

# 4) 人が確認 → 必要なら修正
llm-task-router article:evaluate --run 2026-06-18-ai-ir --min-severity minor
llm-task-router article:revise   --run 2026-06-18-ai-ir --instruction-file runs/2026-06-18-ai-ir/revise-instruction.md

# 5) ファクトチェック（Claude Code 等）→ 指示を戻す
llm-task-router article:revise   --run 2026-06-18-ai-ir --instruction-file runs/2026-06-18-ai-ir/factcheck-instruction.md

# 5.5) ビルド検証（コードを含む記事）→ 指示を戻す
llm-task-router article:revise   --run 2026-06-18-ai-ir --instruction-file runs/2026-06-18-ai-ir/build-verify-instruction.md

# 6) 書き出し
llm-task-router article:export   --run 2026-06-18-ai-ir --out ../qiita-content/ai-ir.md
```

## 使うAIの目安

| 工程 | 担当AI | 補足 |
|---|---|---|
| 指示プロンプト作成 | codex / claude code（どちらでも） | 対話でテーマを練る |
| 作成・評価・修正 | llm-task-router 内部モデル | 外側AIは CLI を回すだけ |
| ファクトチェック | Claude Code（Web検索） | 本文(OpenAI)と別系統で独立検証 |
| ビルド検証 | Claude Code（article-build-verifier） | コードを実機で `tsc`/実行。論理レビューがすり抜ける不通を捕捉 |
