---
description: 本文の書き手と別 provider のモデルで編集レビュー（読者・編集視点の批評）を回し、編集長が採否を確定して反映する
---
article-editor-in-chief を使い、編集レビュー（読者・編集視点の批評）を回して、**採否を編集長が判断**したうえで反映してください。

対象: $ARGUMENTS（run id）

進行:
1. `llm-task-router article:review-editorial --run <id>` を実行（本文の書き手と別 provider のモデルが担当。独立性は CLI が既定で担保し、同 provider しか無いときは失敗する。必要時のみ `--allow-same-provider` / `--allow-same-model`）。
2. `runs/<id>/editorial-review.md`（講評・スコア・強み・弱み）と `runs/<id>/editorial-instruction.candidates.md`（②機械フィルタの候補・未確定）を読む。
3. **編集長が採否を判断**: 採用する弱み（major/minor）だけを `runs/<id>/editorial-instruction.md` に確定する。preference（好みレベル）・既存方針との衝突・大きな構成変更はユーザーに上げる。事実に関わる指摘は編集レビュー単独で確定せず article-factchecker に回す。
4. `llm-task-router article:revise --run <id> --instruction-file runs/<id>/editorial-instruction.md` で適用（候補ファイルは直接 revise に渡さない）。
5. 必要なら再レビュー。公開相当（export / record-publication）はユーザー承認後。

原則: final.md は直接編集しない（revise 経由）。編集レビューは正確性ゲートではない（事実は factcheck/build-verify が担当）。
