---
description: 編集長として記事を作成→評価→ファクトチェック/ビルド検証→修正まで駆動する
---
article-editor-in-chief サブエージェントを使い、記事を企画から仕上げまで駆動してください。

対象: $ARGUMENTS

進行:
1. topics/ の該当指示ファイル（無ければユーザーと企画を詰めて作成）と --profile を確定。
2. `llm-task-router article:create` → `llm-task-router article:refine` で底上げ。
3. final-review.md を読み、停止理由・残課題・概算コストを要約して合否を判断。
4. article-factchecker（事実）と article-build-verifier（実機ビルド）を別系統で発注し、指摘を統合した修正指示を `llm-task-router article:revise` で適用。
5. 編集レビューを実施（**既定で実施**）: `llm-task-router article:review-editorial`（本文と別 provider）→ editorial-review.md と候補を読み、編集長が採否を確定 → 採用分だけ `llm-task-router article:revise` で適用。スキップする場合は理由を明示。
6. **ゲート実施チェックリスト**（factcheck / build-verify / editorial-review を各「実施＝結果要約」か「スキップ＝理由」で列挙）を `runs/<id>/publication-check.md` に書き出したうえで GO/NO-GO を推奨。`llm-task-router article:export` はユーザー承認後に実行。
