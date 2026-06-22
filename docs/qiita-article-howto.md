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

### 0.1 Claude Code の承認プロンプト（init が設定済み）

オペレーターを Claude Code で回す場合の承認プロンプト軽減は、**`llm-task-router init` が記事フォルダーに展開する `.claude/` に同梱済み**（手順 2 参照）。中身は:

- `.claude/settings.json` … 記事ワークフローの `llm-task-router article:*`（`export` / `record-publication` を含む）と `WebSearch` / `WebFetch`（裏取り用・全ドメイン）を allow。
- `.claude/hooks/auto-approve-llm-task-router.mjs` … 別ディレクトリから `bash -c 'cd "<記事フォルダー>" && llm-task-router article:...'` の形で実行されると先頭が `bash` になり前方一致 allowlist が効かないため、**コマンド全文を見て自動承認する** PreToolUse フック（`settings.json` に登録済み）。
- `.claude/agents/`・`.claude/commands/`・`CLAUDE.md` … 編集長／factchecker／build-verifier と各スラッシュコマンド。

公開（`article:export`）も自動承認に含めているが、**公開ゲートは編集長の GO/NO-GO ＋ ユーザー承認（会話レベル）で担保**する設計（CLAUDE.md「自走で公開しない」）。権限プロンプトでは止めない。

> テンプレートを更新したら、記事フォルダーで `llm-task-router init --force` を再実行すると `.claude/` が上書き展開される（`--force` 無しでは既存ファイルを上書きしない）。設定変更が効かない場合は Claude Code で `/hooks` を開く（リロード）か再起動。

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

Ctrl-C 等で強制中断した場合、中断した工程のイベントが記録されないことがある。resume の前に `article:status --run <id>` で記録の有無を確認するとよい。

---

## 4.5 進捗の可視化（progress / status）

各 run には `progress.events.jsonl`（正本・追記のみ）と、そこから再生成される `progress.json` / `progress.md`（派生スナップショット）が残る。CLI 工程（create/refine/evaluate/revise/resume/review/claims-normalize/verify-artifacts/review-editorial/export）は実行するだけで自動記録される。CLI を持たない factcheck / build-verify は、編集長が結果を受け取った時点で `article:progress:event` を打って記録する（6章・6.5章を参照）。

現在地・所要時間・概算コスト合計は次で確認する：

```bash
llm-task-router article:status --run 2026-06-18-ai-ir          # 人が読む表
llm-task-router article:status --run 2026-06-18-ai-ir --json   # スクリプト用
```

工程は `create → refine（評価・改稿）→ direction（方向性ゲート）→ factcheck → build-verify → editorial → claims-normalize → verify-artifacts → export` の**9段**（標準工程順は `src/progress/stepOrder.ts`）。各工程の後に `article:status` を挟むと「今N/9工程目」が常に分かる。

> 「評価・改稿」は1段に統合（`article:refine` の評価→改稿ループでも `article:evaluate` 単独でも同じ枠を満たす）。現在地の分母は **canonical 工程数（9）**で、`revise` 等の追加実行（非 canonical）があっても膨らまない。

**所要・コストの見方**: `article:status` の表に各工程の **所要(ms)・概算$** と末尾の **概算コスト合計**が出る（出どころは `progress.json`）。CLI 工程は自動、factcheck/build-verify は編集長の `progress:event` 記録分。概算コストは `models.yaml` の価格表に依存する**概算**（表にも「概算」と明記される）。**開始・終了・更新の時刻は表示上ローカルタイム**（`+09:00` 等のオフセット付き）。正本の `progress.events.jsonl` と `--json` 出力は UTC のまま。

- factcheck / build-verify の**所要見積もり**（「約N分」）は、サブエージェントの作業時間が主で API ログ（`router.log`）に出ないため、現状は出さない。複数 run の `progress.json` 実績が溜まってからの将来拡張とする（憶測値を出さない）。
- **Claude Code（外側AI）のトークン使用量**は `router.log` に含まれない（別系統・本ツール外）。必要なら編集長が Claude Code の `/cost` を完成報告（7.5）の `## 総評` に**手で転記**する（参考値。完全な課金額は取得不可）。

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

工程後に `article:status --run <id>` で記録と現在地を確認する。

---

## 5.5 方向性ゲート（direction-check・factcheck の前）

高コストな factcheck / build-verify に入る前に、編集長が記事の**方向性**（テーマ適合・構成・読者）を一度見て OK / 要修正を判定する軽量ゲート。**正確性ゲートではない**（事実は factcheck、品質は refine/editorial）。方向がズレたまま factcheck に時間を溶かすのを防ぐ。

```bash
# 編集長が final.md を読んだ上で判定（OK なら factcheck へ）
llm-task-router article:direction-check --run 2026-06-18-ai-ir --verdict ok

# 要修正なら理由を添える（factcheck の前に revise で直す）
llm-task-router article:direction-check --run 2026-06-18-ai-ir --verdict revise --note "導入が長い。経済地政学の節を前倒し"
```

- `runs/<id>/direction-check.md` に保存。**auto ブロック**（タイトル・分量・見出しアウトライン・verdict・指示）は CLI 駆動で毎回上書き、**`## 所感` の editor 欄**は編集長の自由記述でマーカー保護（再生成で残る）。
- `--source draft` で `draft.md` を読む**早期プレビュー**もできる。ただし draft はこの後 refine/evaluate で final が変わるため**正式ゲートにはならない**（progress は非 canonical の `direction-draft` 記録。canonical の方向性ゲートは `--source final` のみ）。
- `--verdict revise` のときは canonical `direction` を**未通過（error）として記録**し（`article:status` の現在地は direction に留まり factcheck に進まない）、stderr で「factcheck の前に revise」と警告する。revise で直して再度 `--verdict ok` を打つと done で上書きされる。**OK が出てから** factcheck（6章）に進む。
- `--stdout` はファイルも progress も残さない確認用。これは強制ゲートではない（factcheck/verify-artifacts を direction-check の有無でブロックしない）。

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

factcheck には CLI コマンドが無いため、編集長が結果を受け取った時点で進捗イベントを記録する：

```bash
# 例: factcheck 完了を記録（done / skip / error）
llm-task-router article:progress:event --run 2026-06-18-ai-ir --step factcheck --status done --note "BLOCKING 0"
```

工程後に `article:status --run <id>` で記録と現在地を確認する。

### 再 factcheck の差分スキップ（二度手間を避ける）

編集レビュー等で本文を直すたびに全文を再 factcheck するのは無駄。**前回 factcheck した版（baseline）と現 final.md の差分**で、再検証の要否と範囲を判定する。

```bash
# 初回 factcheck が終わったら baseline を受理（snapshot を取る）。理由を必ず添える（監査）
llm-task-router article:factcheck-stamp --run 2026-06-18-ai-ir --accepted-after factcheck --note "BLOCKING 0"

# 以降、再 factcheck の前に差分で要否を判定（full / skip / diff）
llm-task-router article:factcheck-scope --run 2026-06-18-ai-ir
```

- **判定**: baseline 無し→`full`（全文）／差分ゼロ→`skip`（再検証不要・前回結果を流用）／差分あり→`diff`（変更セクション・影響 claim・新規抽出セクションを `factcheck-scope.md` に出力。factchecker はそこだけ見る）。
- `claims.json` が無くても差分判定は成立する（変更セクションだけで出力。claim 突き合わせは省略）。
- 判定結果を見て、**編集長が `article:progress:event --step factcheck --status skip|done` を記録**する。`factcheck-scope` 自体は**非 canonical の `factcheck-scope` イベント**（要否判定の記録。差分でどれだけ再検証を省いたかを台帳に残す）を自動で書くが、**canonical の `factcheck` 工程の skip|done は別途編集長が記録する**（dry run の `--json` / `--stdout` では何も記録しない）。
- 再検証（または「非事実差分だから受理」と判断）したら、再び `article:factcheck-stamp` で baseline を更新する。**`factcheck-stamp` は factcheck の前に打たない**（未検証の final を「検証済み」にしてしまう）。v0.2.31 でコマンド実行プロンプトは外れたので、この順序は編集長が手順で守る。

---

## 6.5 構文/型チェック（コードを含む記事は必須・実行しない）

ファクトチェックは**論理レビュー**であり、コードの型/構文は検査しない。型の絞り込み失敗や tsconfig 依存の不通は、論理だけでは構造的にすり抜ける（実例: `tsc` で TS2339/TS2580 がビルド不通でも「事実誤認ゼロ」になり得る）。コードを含む記事では、事実検証とは**別系統の構文/型チェック**を必ず回す。

**コードは実行しない方針**: 記事のコードは信頼できない入力なので、`node` 等で実行はしない（ファイル削除・更新・ネットワーク送信などの副作用を避ける）。検証は静的な型/構文チェック（`tsc --noEmit`）に限定する。上の失敗例（TS2339/TS2580）はいずれも `tsc` の静的チェックで捕まり、実行は不要。「掲載どおりの出力になるか」は実行で確かめず、確証が持てない部分は未検証として残す。

1. 外側AI（`article-build-verifier` 役）に `runs/<runId>/final.md` を読ませる。
2. **使い捨ての一時ディレクトリ**に、記事掲載どおりの `package.json` / `tsconfig` で最小プロジェクトを再現し（記事が TS バージョンを明記していればそれを固定）、`npm install --ignore-scripts`（postinstall の任意コード実行も止める）→ **プロジェクトローカルの `node_modules/.bin/tsc --noEmit`**（グローバル `tsc` にフォールバックさせない。解決版を `environment.typescript` に記録）で型/構文が通るか確認させる（**コードは実行しない**）。
3. 検証の証跡を `runs/<runId>/build-verify-report.json`（検証環境・ブロック別結果。コード無し/スキップ時は `status: "skipped"` ＋ `skipReason`）に残させ、不通・不一致があれば `runs/<runId>/build-verify-instruction.md` にまとめさせ、ツールに戻す：

```bash
llm-task-router article:revise --run 2026-06-18-ai-ir \
  --instruction-file runs/2026-06-18-ai-ir/build-verify-instruction.md
```

> ファクトチェック（事実・Web）と構文/型チェックは別系統の2検証。`init` で入る `article-build-verifier` サブエージェントがこの役を担う。記事のコードは信頼できない入力として一時ディレクトリ内に隔離し、**実行はしない**（静的な型/構文チェックのみ）。

build-verify にも CLI コマンドが無いため、編集長が結果を受け取った時点で進捗イベントを記録する。コードを含まない記事で検証を回さない場合は `skip` ＋理由（silent skip 禁止）：

```bash
# 例: 構文/型チェックを完了として記録
llm-task-router article:progress:event --run 2026-06-18-ai-ir --step build-verify --status done --note "report status=passed"
# 例: コードを含まない記事のためスキップ
llm-task-router article:progress:event --run 2026-06-18-ai-ir --step build-verify --status skip --note "コードを含まない記事のため構文/型チェックは不要"
```

工程後に `article:status --run <id>` で記録と現在地を確認する。

---

## 6.6 編集レビュー（既定で実施・読者/編集視点の批評）

審査（refine の judge）・事実検証とは別に、**本文の書き手と別 provider のモデル**で「読者・編集視点の批評」を回せる。構成・読みやすさ・専門性の届き方を見る**第3のレンズ**で、**正確性ゲートではない**（事実はファクトチェックが担当）。工程としては **既定で実施**し、回さない場合（純粋な再掲・ごく軽微な修正等）は**スキップ理由を明記**する（silent skip を禁止。GO/NO-GO 前に編集長が `runs/<id>/publication-check.md` へ書き出すゲート実施チェックリストで factcheck / build-verify と並べて可視化する）。

```bash
# 初回（独立レビュー）。本文の書き手と別 provider が担当（独立性は CLI が既定で担保）
llm-task-router article:review-editorial --run 2026-06-18-ai-ir
```

- 出力: `editorial-review.md`（スコア・強み・弱み）と `editorial-instruction.candidates.md`（**候補**＝`major`/`minor` かつ未解決のみ。`preference`・解決済みは除外）。
- **候補は自動適用されない**。編集長が採用分を `runs/<runId>/editorial-instruction.md` に確定 → revise で戻す：

```bash
llm-task-router article:revise --run 2026-06-18-ai-ir \
  --instruction-file runs/2026-06-18-ai-ir/editorial-instruction.md
```

- 改稿後の再レビューは `--mode continuation`（前回レビュー時点との差分で再評価し、前回指摘の解決を追跡。weakness の id はラウンドをまたいで安定）。
- 独立性: 既定で `finalAuthorModel` の provider を reviewer から除外。緩めるなら `--allow-same-provider` / `--allow-same-model`。import（外部/人間作）の run は免除。`llm-task-router init` の `.claude/` には `/review-editorial` コマンドと編集長の③トリアージ手順が入る。

---

## 6.7 公開前ゲート（claims-normalize ＋ verify-artifacts）

ファクトチェックの結果は機械可読な台帳にして、公開前に機械チェックする。

1. factchecker は `factcheck-instruction.md` に加えて `claims.raw.json` / `sources.raw.json`（id 無しの台帳素材）を出す。**正規化は「最後に本文を変えた工程の後」に置く**（編集レビュー(6.6)の revise が主張・見出し・数値・API 記述に触れたら、normalize の前に factchecker に再確認させ raw を最新 `final.md` に合わせる。stale 台帳を防ぐ）。本文が確定したら台帳を正規化する：

```bash
# raw（id 無し）→ id 付き claims.json/sources.json（採番・台帳化はコードが担う）
llm-task-router article:claims-normalize --run 2026-06-18-ai-ir --scope full
```

1.5. **参考章に検証済みリンクを付与**（normalize の後）。本文の参考章が出典名だけだと読者が元情報を辿れない。`sources.json`（検証済み URL）から参考章を機械生成する（**LLM に URL を書かせない＝偽 URL 防止**）：

```bash
llm-task-router article:references --run 2026-06-18-ai-ir   # --stdout で生成ブロックだけ確認も可
```

- 載せるのは **`present` かつ `verified` な claim が参照する source のみ**（未検証・要出典は公開前ゲートで潰す対象）。primary→secondary・id 順。
- 参考章は `<!-- sources:begin/end -->` マーカーで管理し、再生成しても編集長の前後文を壊さない（初回の「名前のみ」リストは章本文ごと置換）。`final.md` は機械更新され、直前版は `final.references.bak.md` に退避（`revise` の `final.bak.md` とは別）。
- 検証済み source が0件なら何も書かずエラー終了（公開前に0は異常なので気づける）。
- **到達不能 URL の扱い**: factchecker は死リンクに `reachable:"dead"`＋`replacedByKey`（到達可能な代替の key）を `sources.raw.json` に記録し、`verified` claim は代替へ張り替える。normalize が `replacedBy` を解決し `cited` を焼き込む。`reachable:"dead"` は参考章に出ない（除外時は references が stderr に warn）。verify-artifacts が「cited かつ dead」「参考ブロック内の dead」「replacedBy の dangling/自己参照」「cited 焼き込みの claims 不一致」を弾く（HTTP 到達チェックは別途・verify-artifacts は通信しない）。
- **（任意）到達性の機械ふるい**: `llm-task-router article:sources-check --run <id>` で `sources.raw.json` の URL を HTTP 確認し `reachable`/`checkedAt` を stamp（opt-in・外部通信）。`--dry-run`（非書き込み）/`--only-cited`（cited のみ）/`--json`。判定は保守的で **dead は 404/410 のみ**（5xx・401/403・通信エラーは unknown）。書き込み後は `article:claims-normalize` で `sources.json` に反映し、dead は代替へ張り替える。`verify-artifacts` は通信しないので、到達確認はこのコマンドに閉じる。

2. 編集長が `runs/<id>/publication-check.md` にゲート実施チェックリストを書き出したら、公開前ゲートを機械チェックする：

```bash
# 成果物の揃い・スキーマ・出典 integrity・build-verify 成否・blocking を検査（外部通信なし）
llm-task-router article:verify-artifacts --run 2026-06-18-ai-ir
```

`verify-artifacts` は次を見る（FAIL なら原因を潰して再実行。GO はそれから）：
- `final.md` / `final-review.md` / `publication-check.md`（GO/NO-GO 記載）の存在。
- 各ゲート（factcheck / build-verify / editorial-review）が publication-check で `done|skipped` 宣言済み（silent skip 禁止。skipped は理由必須）。
- `factcheck=done` なら `claims.json`／`sources.json` 必須・スキーマ適合・出典参照 integrity・**blocking な claim ゼロ**（blocking = present かつ critical/major かつ unverified/needs-source/incorrect）。
- `build-verify=done` なら report が `status=passed`（failed/partial・未検証混入・宣言不整合は弾く）。
- **参考リンク**: 参考マーカーブロック内のリンクは `sources.json` に全て存在すること（偽/未登録 URL は **FAIL**）。ブロック外の本文リンク（GitHub・公式 doc・画像等）で `sources.json` に無いものは **warning**（一般リンクは壊さない）。

> 採番（`CNNN-<hash8>` / `SNNN`）は **コードが担い**、factchecker や編集長は hash を計算しない。`verify-artifacts` は外部通信を行わないため安全方針と無衝突。

`claims-normalize` と `verify-artifacts` は CLI コマンドなので進捗は自動記録される。工程後に `article:status --run <id>` で記録と現在地を確認する。

---

## 7. 書き出し

完成したら `final.md` を任意のパス（Qiita 投稿用リポジトリ等）へコピー：

```bash
llm-task-router article:export --run 2026-06-18-ai-ir \
  --out ../qiita-content/ai-ir.md          # 既存があれば上書きは --force
```

`export` は秘密ファイル名（`.env*`）を拒否し、ワークスペース外への書き出しは警告する。書き出されるのは `final.md` のみ。

---

## 7.5 完成報告（completion-report.md）

完成報告を `runs/<id>/completion-report.md` に残す。チャットに流すだけでなく、ゲート結果・概算コスト・GO/NO-GO を run 内に証跡として閉じる（`export/index.json`＝公開台帳には混ぜない）。

```bash
llm-task-router article:completion-report --run 2026-06-18-ai-ir
```

- **機械生成**（`<!-- auto:begin/end -->` 内）: 記事タイトル・profile・進捗・概算コスト合計・GO/NO-GO/reason（`publication-check.md` から転記）・ゲート結果表（factcheck/build-verify/editorial の宣言＋ claims/build-report の件数）。
- **編集長が記入**（auto 範囲の外）: `## 構成`（構成ナラティブ）・`## 上申事項`（ユーザー判断を要する論点）・`## 総評`。コードは作文せずプレースホルダだけ置く。
- 入力は `progress.json`（コスト・進捗）と `publication-check.md`（ゲート宣言・GO/NO-GO）。**`publication-check.md` は必須**（無ければエラー）。`verify-artifacts` は推奨だが未実行/失敗でも生成できる（NO-GO の差し戻し報告も作れる）。
- **再生成は安全**: 既定では auto 範囲だけ最新化し、編集長が書いた `## 構成`/`## 上申事項`/`## 総評` は保持する。editor 欄ごと初期化したいときだけ `--reset-editor`（既存は `completion-report.bak.md` に退避）。ファイルを書かず確認だけなら `--stdout`。

---

## 承認回数を減らす（Claude Code の permission）

Claude Code で回すと Bash 実行のたびに承認を求められ、数が多いと中身を見ずに承認しがちになる。`init` は `.claude/settings.json` に **記事ワークフローのコマンドだけの allowlist** を入れて配るので、`create / refine / evaluate / revise / resume / review` は事前許可済み（プロンプトが出ない）。記録系の `article:status` / `article:progress:event` / `article:completion-report` / `article:direction-check` / `article:factcheck-scope` / `article:references` も allowlist に入っており、進捗確認・記録・方向性ゲート・完成報告・再 factcheck 判定・参考リンク付与のたびに承認を求められることはない。さらに **v0.2.31 以降は `article:export` / `article:record-publication` / `article:factcheck-stamp` も allowlist に入り、コマンド実行プロンプトは出ない**（エクスポート一連を承認連打にしないため）。

> 注意（公開相当の操作）: `export` / `record-publication` の **コマンド実行**プロンプトは外したが、**公開可否の承認自体は無くなっていない**。公開相当の操作は編集長が GO/NO-GO を出し**ユーザー承認後に実行**する運用は不変で、承認・条件は `--note` で台帳に残す（自走で公開しない）。`factcheck-stamp` も「factcheck 前に打たない」規律は維持する（プロンプトに依存せず編集長が順序で担保する）。

意図的に**プロンプトを残している**のは次の1つ — ここは毎回中身を見て承認する：

- `article-build-verifier` の `npm install --ignore-scripts` / `tsc`（記事内の**未知コードを一時ディレクトリで型/構文チェック**する部分。コードは実行しないが、依存取得でネットワークに出るため承認対象に残す）

許可を足したい/外したい場合は `.claude/settings.json` の `permissions.allow` を編集する。設定変更は次回セッション開始時に反映される。

### 承認の棚卸し（プロンプトが多いと感じたら）

承認過多の主因は「コマンドが足りない」ことより、**allowlist にマッチしない叩き方**であることが多い。次のパターンは事前許可に当たらず毎回プロンプトになるので潰す：

- `cd ../foo && llm-task-router ...`（`cd &&` の連結）→ **カレント（プロジェクト直下）で1コマンドずつ**実行する。
- `npx llm-task-router ...` や相対パス起動 → PATH 上の `llm-task-router` を直接呼ぶ。
- パイプ・複合（`|` / `;` / `&&` で連結）→ 1 Bash 呼び出し＝1 コマンドに分ける。

Claude Code に **`/fewer-permission-prompts` スキルがあれば**、実際に出たプロンプト履歴をスキャンして allowlist 追加候補を出せる（本ツール同梱ではなく Claude Code 側の機能。あれば使う）。**追加するのは「正当だが未許可」と棚卸しで判明したパターンに限る**（むやみに広げない。上に残したプロンプト＝`article-build-verifier` の `npm install` / `tsc` はそのまま）。

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

# 4.5) 方向性ゲート（factcheck の前。OK で進む／要修正なら revise してから）
llm-task-router article:direction-check --run 2026-06-18-ai-ir --verdict ok

# 5) ファクトチェック（Claude Code 等）→ 結果受領時に編集長が進捗を記録 → 指摘があれば revise
llm-task-router article:progress:event --run 2026-06-18-ai-ir --step factcheck --status done --note "BLOCKING 0"
llm-task-router article:revise   --run 2026-06-18-ai-ir --instruction-file runs/2026-06-18-ai-ir/factcheck-instruction.md
# 初回 factcheck 後に baseline 受理（以降の再 factcheck は factcheck-scope で要否判定）
llm-task-router article:factcheck-stamp --run 2026-06-18-ai-ir --accepted-after factcheck --note "BLOCKING 0"

# 5.5) 構文/型チェック（コードを含む記事・実行しない）→ 結果受領時に編集長が進捗を記録 → 指摘があれば revise
llm-task-router article:progress:event --run 2026-06-18-ai-ir --step build-verify --status done --note "report status=passed"
llm-task-router article:revise   --run 2026-06-18-ai-ir --instruction-file runs/2026-06-18-ai-ir/build-verify-instruction.md

# 5.7) 編集レビュー（既定で実施。本文と別 provider）→ 編集長が採否を確定 → 指示を戻す
llm-task-router article:review-editorial --run 2026-06-18-ai-ir
llm-task-router article:revise   --run 2026-06-18-ai-ir --instruction-file runs/2026-06-18-ai-ir/editorial-instruction.md

# 5.8) 台帳の正規化（factcheck の raw → id 付き claims.json/sources.json）
#      編集レビューが主張・見出し・数値・API に触れたなら、ここで再 factcheck して raw を最新化してから normalize する
llm-task-router article:claims-normalize --run 2026-06-18-ai-ir --scope full

# 5.85) 参考章に検証済みリンクを付与（sources.json 由来・LLM に URL を書かせない）
llm-task-router article:references --run 2026-06-18-ai-ir

# 5.9) 公開前ゲート（publication-check.md を書き出してから機械チェック。FAIL なら潰して再実行）
llm-task-router article:verify-artifacts --run 2026-06-18-ai-ir

# 5.95) 現在地・概算コストを確認
llm-task-router article:status --run 2026-06-18-ai-ir

# 5.97) 完成報告を生成（構成/上申/総評の editor 欄は編集長が記入）
llm-task-router article:completion-report --run 2026-06-18-ai-ir

# 6) 書き出し（GO ＋ ユーザー承認後）
llm-task-router article:export   --run 2026-06-18-ai-ir --out ../qiita-content/ai-ir.md
```

## 既存記事を取り込んでブラッシュアップする（article:import）

このパイプライン外で書いた既存記事（手書き・公開済み・他ツール製）を、本文を手書き編集せずに評価/修正フローへ乗せられる。`create` の代わりの入口で、`export`（run → 外）の対（外 → run）。

```bash
# 既存 md を run として取り込む（meta は profile から正しく生成される）
llm-task-router article:import --from ../old/kintone.md --profile qiita \
  --criteria-file ./brushup-criteria.md   # ブラッシュアップ観点（任意・推奨）
```

- runId はファイル名から導出（`kintone.md` → `2026-06-18-kintone`）。`--run` で明示も可。
- `topic` は本文先頭の H1 → 無ければ runId。`platform`/`style` は profile から解決。
- `--criteria-file` は `runs/<runId>/brushup-criteria.md` に保存され、**以後の `evaluate`/`refine` が自動で採用**する（評価は topic を見ず criteria が主舵。消えた指示プロンプトの代替になる）。
- front-matter らしきブロックは**警告のみ**（自動除去しない。Qiita は本文に含めない方針）。
- 既存 run があるときは `--force` で **import run として置き換え**（旧 review/refine 成果物を掃除）。

取り込み後は通常フローと同じ。ただし import run は生成系工程を持たないため **`evaluate` / `refine` / `revise` のみ**対応（`resume` / `review` は拒否される）。既存・公開済み記事は意図を壊さないよう、まず `evaluate`（読み取り）→ 納得した指摘だけ `revise`、`refine` は控えめ（`--max-rounds 2`）に。

```bash
# 取り込み → 評価（criteria 自動採用）→ 修正
llm-task-router article:import   --from ../old/kintone.md --criteria-file ./brushup-criteria.md
llm-task-router article:evaluate --run 2026-06-18-kintone --min-severity minor
llm-task-router article:revise   --run 2026-06-18-kintone --instruction-file runs/2026-06-18-kintone/revise-instruction.md
```

詳細仕様は [article-import-proposal.md](article-import-proposal.md) を参照。

## 公開済み記事を更新リライトする（/update-article）

一度公開した記事を「同一性（URL・骨格）を保ったまま、陳腐化した差分だけ」更新する運用。新規作成（`/write-article`）とは別系統で、import を起点にする。`/update-article <slug>` が編集長を介して下記を駆動する。詳細は [update-article-plan.md](update-article-plan.md)（仕様 [update-article-spec.md](update-article-spec.md)）。

正本を3つ固定するのが肝: **版＝`update-base.md`** / **公開先＝`meta.published`** / **系譜＝`meta.lineage`**。

```bash
# 1) 起点化: 公開済み md を新 run として import（update-base.md と lineage が記録される）
llm-task-router article:import --from export/<slug>.md --run 2026-06-19-<slug>-v2 \
  --supersedes 2026-06-18-<slug> --root 2026-06-01-<slug> --profile qiita

# 2) 変更点だけを指示ファイルに列挙して revise（全面リライトしない）
#    runs/2026-06-19-<slug>-v2/update-instruction.md を作成（一次情報を根拠に）
llm-task-router article:revise --run 2026-06-19-<slug>-v2 \
  --instruction-file runs/2026-06-19-<slug>-v2/update-instruction.md

# 3) 差分の正本を生成（update-base.md → final.md）
llm-task-router article:update-diff --run 2026-06-19-<slug>-v2
#  → runs/.../update-diff.md, changed-sections.json

# 4) 差分集中の2検証（factchecker / build-verifier に update-diff.md だけ渡す）→ revise で適用

# 5) 編集長 GO → ユーザー承認後にローカル export（コピーのみ）
llm-task-router article:export --run 2026-06-19-<slug>-v2 --out ../qiita-content/<slug>.md

# 6) 公開台帳の記録（export とは別ステップ。同一 URL の更新。meta.published と export/index.json を更新）
llm-task-router article:record-publication --run 2026-06-19-<slug>-v2 \
  --slug <slug> --url https://qiita.com/.../items/xxxx --article-id xxxx --article-version 2
```

- `article:export` は **コピーのみ**で meta を更新しない。公開先 URL/版の記録は `article:record-publication` の責務（責務分離）。
- `record-publication` は同一 slug の version 退行を拒否（完全一致は no-op、訂正は `--force`）。`export` と同様の**公開相当の操作**。v0.2.31 でコマンド実行プロンプトは外れたが、再公開と新規投稿の取り違えを防ぐため**実行前に毎回 URL を内容で確認**する（編集長／ユーザーが承認）。
- `record-publication` は **progress の canonical 工程に含めない**（公開台帳＝`meta.published`/`export/index.json` の更新であって、記事生成工程ではないため）。進捗上の完了は `export`（=公開相当の書き出し）で表す。更新リライトで公開台帳まで終えたかは `article:status` ではなく `export/index.json` で確認する。

## 使うAIの目安

| 工程 | 担当AI | 補足 |
|---|---|---|
| 指示プロンプト作成 | codex / claude code（どちらでも） | 対話でテーマを練る |
| 作成・評価・修正 | llm-task-router 内部モデル | 外側AIは CLI を回すだけ |
| ファクトチェック | Claude Code（Web検索） | 本文(OpenAI)と別系統で独立検証 |
| 構文/型チェック | Claude Code（article-build-verifier） | コードを `tsc --noEmit` で型/構文検証（**実行はしない**）。論理レビューがすり抜ける不通を捕捉 |
| 編集レビュー | 本文と別 provider のモデル（独立性は CLI が担保） | 読者・編集視点の第3レンズ。既定で実施し、回さない場合は理由を明記 |
