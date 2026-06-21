# CLAUDE.md

この作業フォルダーは llm-task-router で記事を作成・評価・修正するためのものです。

## 記事作成の原則

- 記事の指示ファイル（topics/<slug>.txt）は `/draft-topic <テーマ>` で規約に従って起案し、承認後に `/write-article` で記事化する。
- 記事本文は手書きしない。llm-task-router の CLI パイプライン（create / refine / evaluate / revise）で生成・修正する。
- `final.md` を直接編集しない。修正は `llm-task-router article:revise --instruction-file` 経由で戻す（runs/ に集約し `final.bak.md` を残すため）。
- 作成・進行・品質判断は **article-editor-in-chief**（編集長）、Web裏取りは **article-factchecker**、コードの実機ビルド/実行は **article-build-verifier** に委譲する。コードを含む記事は事実検証と実機検証の両方を回す。サブエージェントから結果を受け取ったら、編集長が工程の出口で進捗イベントを記録する（`done|skip|error` は必須、入口 `start` は任意。skip は理由必須＝silent skip 禁止）。
- **各工程の進捗は `progress.events.jsonl`（正本）に記録する**。CLI 工程は実行するだけで自動記録、CLI を持たない工程（factcheck / build-verify）は編集長が `llm-task-router article:progress:event` で記録する。現在地・所要・概算コストの確認は `llm-task-router article:status --run <id>`。
- **編集長（駆動する Claude）の AI モデルは作成時に固定する**。`article:create` に `--editor-model <id>`（例 `claude-opus-4-8`＝自分のモデル ID）を渡すと、create の最初のイベントに刻まれ progress.md ヘッダに「編集長（AIモデル・自己申告）」として表示される。run 単位で first-write-wins（最初の申告で固定。遡及・上書きされない）。自動検出ではなく自己申告（監査値ではない）。
- **factcheck の前に方向性ゲート**（`llm-task-router article:direction-check --run <id> --verdict ok|revise`）を通す（任意の推奨ステップ）。高コストな factcheck/build の前にテーマ適合・構成・読者を編集長が判定する軽量ゲート（正確性ゲートではない）。`--verdict ok` で factcheck へ、`revise` なら直してから。`runs/<id>/direction-check.md` に閉じる。
- **再 factcheck は差分で要否判定**（二度手間回避）。初回 factcheck 後に `llm-task-router article:factcheck-stamp --accepted-after factcheck --note ...` で baseline を受理し、以降は `article:factcheck-scope` で `full|skip|diff` を判定（差分ゼロなら skip）。`factcheck-stamp` は信頼状態を変えるので factcheck 前に打たない（プロンプト維持）。
- **参考章のリンクは `sources.json` から機械生成**（`llm-task-router article:references`）。normalize 後に、present かつ verified な claim が参照する検証済み source のみを参考章へ付与する（**LLM に URL を書かせない＝偽 URL 防止**）。実行時に **LLM が本文に書いた参考リスト節（`## 参考リンク`/`## 出典` 等・URL 入り）は除去**し、機械生成の `## 参考` に一本化する。verify-artifacts が参考ブロック内リンクの台帳一致を検査する。
- 公開相当の `llm-task-router article:export` は編集長が GO/NO-GO を出し、**ユーザー承認後に実行**する。自走で公開しない。
- **完成報告は `runs/<runId>/completion-report.md` に残す**（`llm-task-router article:completion-report`）。ゲート結果・コスト・GO/NO-GO は機械生成、構成/上申/総評は編集長が editor 欄に記入。`export/index.json`（公開台帳）には混ぜない。
- **編集レビュー**（読者・編集視点の批評）は `/review-editorial <run>`（`llm-task-router article:review-editorial`）。本文の書き手と別 provider のモデルが担当し、**採否は編集長が判断・preference と最終可否は筆者・事実は factcheck 優先**。正確性ゲートではない。
- **公開済み記事の更新**は `/update-article <slug>` で行う。import を起点に `update-base.md`（版の正本）を固定し、変更点だけを revise → `article:update-diff` で差分集中の2検証 → 承認後に `article:export` ＋ `article:record-publication`（同一 URL の更新。`published` と `export/index.json` を記録）。全面リライトはしない。
