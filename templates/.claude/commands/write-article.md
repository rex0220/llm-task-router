---
description: 編集長として記事を作成→評価→修正→ファクトチェックまで駆動する
---
article-editor-in-chief サブエージェントを使い、記事を企画から仕上げまで駆動してください。

対象: $ARGUMENTS

進行:
1. topics/ の該当指示ファイル（無ければユーザーと企画を詰めて作成）と --profile を確定。
2. `llm-task-router article:create` → `llm-task-router article:refine` で底上げ。
3. final-review.md を読み、停止理由・残課題・概算コストを要約して合否を判断。
4. article-factchecker に裏取りを発注し、指摘を統合した修正指示を `llm-task-router article:revise` で適用。
5. GO/NO-GO を推奨。`llm-task-router article:export` はユーザー承認後に実行。
