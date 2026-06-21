# 手順書改訂 TODO（進捗ログ基盤 実装後）

[docs/課題-対策-実装計画.md](課題-対策-実装計画.md)（優先度1：progress 基盤＋`article:status`）が入った**後に**、手順側で直す箇所をまとめた TODO。実装前に着手しない（コマンドがまだ無いため）。

対象ファイル: [CLAUDE.md](../CLAUDE.md) / [docs/qiita-article-howto.md](qiita-article-howto.md) / `templates/.claude/`（サブエージェント定義・settings.json）。

> 実質インパクトは2つ: **(1) サブエージェント終了時に `progress:event` を打つ**、**(2) 工程の合間に `article:status` を挟む**。残りは透過的かドキュメント同期。

> ⚠ **着手前チェック**: 以下の文案は実装計画時点の想定仕様で書いている。実装後に `article:status` / `article:progress:event` の**最終的なコマンド名・引数（`--step` / `--status` / `--note` 等）・status 値**を確認し、ズレていれば本 TODO 内のコマンド例をすべて最新仕様に合わせてから手順書へ反映する。

---

## A. CLAUDE.md（記事作成の原則）

### A-1. 進捗記録の原則を1行追加
- 追加場所: 「## 記事作成の原則」の箇条書き。
- 追加文案:
  > - **各工程の進捗は `progress.events.jsonl`（正本）に記録する**。CLI 工程は自動記録、サブエージェント工程（factcheck / build-verify / publication-check）は**終了時に `llm-task-router article:progress:event` を打つ**（silent skip 禁止と同じ思想。記録漏れは「7工程中N番目」を壊す）。進捗確認は `article:status --run <id>`。

### A-2. 委譲の原則に「記録義務」を追記
- 既存行（editor-in-chief / factchecker / build-verifier への委譲）に、**「各サブエージェントは工程の出口で進捗イベントを記録する（`done|skip|error` は必須、入口 `start` は任意）」**を一文追加。編集長がオーケストレーションで記録漏れを防ぐ。

---

## B. docs/qiita-article-howto.md

### B-1. 新章「進捗の可視化（progress / status）」を追加
- 位置: 「## 4. 記事を作成する」の前後、または付録の前。
- 内容:
  - 各 run に `progress.events.jsonl`（正本）/ `progress.json` / `progress.md`（派生）が残ること。
  - 確認コマンド:
    ```bash
    llm-task-router article:status --run 2026-06-18-ai-ir          # 現在地・所要・概算合計
    llm-task-router article:status --run 2026-06-18-ai-ir --json   # スクリプト用
    ```
  - 「7工程中N番目」が課題.md の現在地表に対応すること。

### B-2. 各工程の手順に status 確認を差し込む
- 「5. チェック・修正」「6. ファクトチェック」「6.5 ビルド検証」「6.7 公開前ゲート」の各節末に、
  > 工程後に `article:status --run <id>` で記録と現在地を確認する。
  を一文追加。

### B-3. ファクトチェック節（6）にサブエージェント記録手順を追加
- factchecker / build-verifier / publication-check は CLI を持たないため、**終了時に進捗イベントを打つ**手順を明記:
  ```bash
  # 例: factcheck 完了を記録（done / skip / error）
  llm-task-router article:progress:event --run 2026-06-18-ai-ir --step factcheck --status done --note "BLOCKING 0"
  # 回さない場合は skip ＋理由（silent skip 禁止。step と理由を一致させる）
  llm-task-router article:progress:event --run 2026-06-18-ai-ir --step build-verify --status skip --note "コードを含まない記事のため実機検証は不要"
  ```

### B-4. 「承認回数を減らす」節の allowlist 記述を更新
- [docs/qiita-article-howto.md:291](qiita-article-howto.md) 付近。allowlist に **`article:status` / `article:progress:event`** が追加され、記録系は自動承認になることを追記。
- プロンプト維持は従来どおり `export` / `record-publication` / build-verify の未知コード実行、と明記（方針不変）。

### B-5. 中断時の注意を1行
- action を強制中断（Ctrl-C 等）するとその工程のイベントが残らない場合があるため、**中断後は `article:status` で記録の有無を確認**する旨を「resume」の説明（[docs/qiita-article-howto.md:137](qiita-article-howto.md) 付近）に併記。

### B-6. 付録フローに status / progress:event を反映
- 「付録：典型的な1記事のフロー」のコマンド列に、各工程後の `article:status` と、サブエージェント工程の `article:progress:event` を1〜2行追加（実際の運用順を反映）。

---

## C. templates/.claude/

### C-1. settings.json の allowlist 追加
- `"Bash(llm-task-router article:status:*)"` と `"Bash(llm-task-router article:progress:event:*)"` を `permissions.allow` に追加。
- export / record-publication / build-verifier の npm install・tsc・node はプロンプト維持（変更しない）。

### C-2. サブエージェント定義に「進捗イベント記録」を追記
- `article-factchecker` / `article-build-verifier` / `article-editor-in-chief` の定義に、
  - 工程の**入口で `--status start`（任意）/ 出口で `--status done|skip|error`** を打つこと。
  - skip は理由必須（`--note`）。silent skip 禁止。
  - 編集長は各サブエージェント完了時に記録の有無を確認し、漏れを補完する。

---

## D. 保守の同期ルール（恒久 TODO）

- **canonical 工程順（`src/progress/stepOrder.ts`）と、課題.md の7工程表・howto の工程順を一致させる**。片方を変えたら両方直す（ズレると `article:status` の「N番目」が狂う）。
- `progress.*` ファイルの git 取り扱いを決める（ログ性が強いので `.gitignore` 寄り。`runs/` の既存方針に合わせる）。

---

## E. 後続（優先度2以降で再度手順改訂が要る）

- **優先度2 `completion-report.md`**: 完成報告を `progress.json` 入力で生成する手順に置き換える（現状のチャット完成報告 → run 内ファイル化）。
- **優先度3 `direction-check.md`**: factcheck の前に方向性ゲートを挟む手順を追加（create 直後=draft.md / refine 後=final.md を読む）。
- **優先度4 factcheck 差分スキップ**: 「事実差分ゼロなら再 factcheck をスキップ」の判断手順を 6章に追加。

> E はいずれもスコープ外。優先度1の手順改訂（A〜C）が終わってから着手する。
