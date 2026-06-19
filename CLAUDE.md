# CLAUDE.md

このリポジトリは llm-task-router（記事ワークフローを駆動する薄い ModelRouter の CLI）です。

## 記事作成の原則

- 記事の指示ファイル（topics/<slug>.txt）は `/draft-topic <テーマ>` で規約に従って起案し、承認後に `/write-article` で記事化する。
- 記事本文は手書きしない。llm-task-router の CLI パイプライン（create / refine / evaluate / revise）で生成・修正する。
- `final.md` を直接編集しない。修正は `llm-task-router article:revise --instruction-file` 経由で戻す（runs/ に集約し `final.bak.md` を残すため）。
- 作成・進行・品質判断は **article-editor-in-chief**（編集長）、Web裏取りは **article-factchecker**、コードの実機ビルド/実行は **article-build-verifier** に委譲する。コードを含む記事は事実検証と実機検証の両方を回す。
- 公開相当の `llm-task-router article:export` は編集長が GO/NO-GO を出し、**ユーザー承認後に実行**する。自走で公開しない。
- **公開済み記事の更新**は `/update-article <slug>` で行う。import を起点に `update-base.md`（版の正本）を固定し、変更点だけを revise → `article:update-diff` で差分集中の2検証 → 承認後に `article:export` ＋ `article:record-publication`（同一 URL の更新。`published` と `export/index.json` を記録）。全面リライトはしない。

## 手順書

- 記事作成の詳細フローは [docs/qiita-article-howto.md](docs/qiita-article-howto.md) を参照。
- 既存記事の更新リライトのフローは [docs/update-article-plan.md](docs/update-article-plan.md)（仕様は [docs/update-article-spec.md](docs/update-article-spec.md)）を参照。
