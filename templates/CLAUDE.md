# CLAUDE.md

この作業フォルダーは llm-task-router で記事を作成・評価・修正するためのものです。

## 記事作成の原則

- 記事の指示ファイル（topics/<slug>.txt）は `/draft-topic <テーマ>` で規約に従って起案し、承認後に `/write-article` で記事化する。
- 記事本文は手書きしない。llm-task-router の CLI パイプライン（create / refine / evaluate / revise）で生成・修正する。
- `final.md` を直接編集しない。修正は `llm-task-router article:revise --instruction-file` 経由で戻す（runs/ に集約し `final.bak.md` を残すため）。
- 作成・進行・品質判断は **article-editor-in-chief**（編集長）、Web裏取りは **article-factchecker**、コードの実機ビルド/実行は **article-build-verifier** に委譲する。コードを含む記事は事実検証と実機検証の両方を回す。
- 公開相当の `llm-task-router article:export` は編集長が GO/NO-GO を出し、**ユーザー承認後に実行**する。自走で公開しない。
- **編集レビュー**（読者・編集視点の批評）は `/review-editorial <run>`（`llm-task-router article:review-editorial`）。本文の書き手と別 provider のモデルが担当し、**採否は編集長が判断・preference と最終可否は筆者・事実は factcheck 優先**。正確性ゲートではない。
- **公開済み記事の更新**は `/update-article <slug>` で行う。import を起点に `update-base.md`（版の正本）を固定し、変更点だけを revise → `article:update-diff` で差分集中の2検証 → 承認後に `article:export` ＋ `article:record-publication`（同一 URL の更新。`published` と `export/index.json` を記録）。全面リライトはしない。
