# CLAUDE.md

この作業フォルダーは llm-task-router で記事を作成・評価・修正するためのものです。

## 記事作成の原則

- 記事の指示ファイル（topics/<slug>.txt）は `/draft-topic <テーマ>` で規約に従って起案し、承認後に `/write-article` で記事化する。
- 記事本文は手書きしない。llm-task-router の CLI パイプライン（create / refine / evaluate / revise）で生成・修正する。
- `final.md` を直接編集しない。修正は `llm-task-router article:revise --instruction-file` 経由で戻す（runs/ に集約し `final.bak.md` を残すため）。
- 作成・進行・品質判断は **article-editor-in-chief**（編集長）、Web裏取りは **article-factchecker**、コードの構文/型チェック（`tsc`・実行はしない）は **article-build-verifier** に委譲する。**事実検証（factcheck）は必須**。**構文/型チェック（build-verify）は既定オフ**（記事のコードは省略されたサンプルが多く `tsc` が構造的に落ちるため）で、`article:create --code-check` を付けて作成した記事だけ実施する（run 単位で first-write-wins 固定。progress.md ヘッダと completion-report に対象/対象外が出る）。コードは構文チェックの対象外でも引き続き factcheck の対象（API 名・バージョン等の事実誤り）。実施する場合もコードは実行せず静的検証のみ。サブエージェントから結果を受け取ったら、編集長が工程の出口で進捗イベントを記録する（`done|skip|error` は必須、入口 `start` は任意。skip は理由必須＝silent skip 禁止）。
- **各工程の進捗は `progress.events.jsonl`（正本）に記録する**。CLI 工程は実行するだけで自動記録、CLI を持たない工程（factcheck / build-verify）は編集長が `llm-task-router article:progress:event` で記録する。現在地・所要・概算コストの確認は `llm-task-router article:status --run <id>`。
- **編集長（駆動する Claude）の AI モデルは作成時に固定する**。`article:create` に `--editor-model <id>`（例 `claude-opus-4-8`＝自分のモデル ID）を渡すと、create の最初のイベントに刻まれ progress.md ヘッダに「編集長（AIモデル・自己申告）」として表示される。run 単位で first-write-wins（最初の申告で固定。遡及・上書きされない）。自動検出ではなく自己申告（監査値ではない）。
- **factcheck の前に方向性ゲート**（`llm-task-router article:direction-check --run <id> --verdict ok|revise`）を通す（任意の推奨ステップ）。高コストな factcheck/build の前にテーマ適合・構成・読者を編集長が判定する軽量ゲート（正確性ゲートではない）。`--verdict ok` で factcheck へ、`revise` なら直してから。`runs/<id>/direction-check.md` に閉じる。
- **再 factcheck は差分で要否判定**（二度手間回避）。初回 factcheck 後に `llm-task-router article:factcheck-stamp --accepted-after factcheck --note ...` で baseline を受理し、以降は `article:factcheck-scope` で `full|skip|diff` を判定（差分ゼロなら skip）。`factcheck-stamp` は信頼状態を変えるので factcheck 前に打たない（v0.2.31 でコマンド実行プロンプトは外れたので、順序は編集長が手順で担保する）。**本文を変えたら（編集レビューの revise 含む）必ず `article:factcheck-scope` を回して判定を台帳に残す**（手動 skip で証跡を飛ばさない）。非事実差分なら `--accepted-after non-factual-diff` で stamp（`factcheck` は初回受理用）。
- **参考章のリンクは `sources.json` から機械生成**（`llm-task-router article:references`）。normalize 後に、present かつ verified な claim が参照する検証済み source のみを参考章へ付与する（**LLM に URL を書かせない＝偽 URL 防止**）。実行時に **LLM が本文に書いた参考リスト節（`## 参考リンク`/`## 出典` 等・URL 入り）は除去**し、機械生成の `## 参考` に一本化する。verify-artifacts が参考ブロック内リンクの台帳一致を検査する。**到達不能 URL は factchecker が `reachable:"dead"`＋`replacedByKey`（代替 source）で raw に記録**し、死リンクは参考章に出ない（verify-artifacts が cited かつ dead 等を弾く）。到達性は `article:sources-check`（任意・opt-in の HTTP 確認）で機械 stamp もできる。
- 公開相当の `llm-task-router article:export` は編集長が GO/NO-GO を出し、**ユーザー承認後に実行**する。自走で公開しない。**承認・条件付き GO の条件解決は `--note` で台帳（export イベント）に残す**（例 `--note "ユーザー承認済み（条件: …OK）"`）。
- **完成報告は `runs/<runId>/completion-report.md` に残す**（`llm-task-router article:completion-report`）。ゲート結果・コスト・GO/NO-GO は機械生成、構成/上申/総評は編集長が editor 欄に記入。`export/index.json`（公開台帳）には混ぜない。
- **編集レビュー**（読者・編集視点の批評）は `/review-editorial <run>`（`llm-task-router article:review-editorial`）。本文の書き手と別 provider のモデルが担当し、**採否は編集長が判断・preference と最終可否は筆者・事実は factcheck 優先**。正確性ゲートではない。
- **公開済み記事の更新**は `/update-article <slug>` で行う。import を起点に `update-base.md`（版の正本）を固定し、変更点だけを revise → `article:update-diff` で差分集中の検証（factcheck は必須、構文/型チェックは既定オフ＝`import --code-check` 指定時のみ。create と統一） → 承認後に `article:export` ＋ `article:record-publication`（同一 URL の更新。`published` と `export/index.json` を記録）。全面リライトはしない。
- **シリーズ（同じ文体で複数記事）**は `series:init`（`series/<slug>/` と voice.md 枠を作る）→ `series/<slug>/voice.md` を手書き → `series:freeze-voice`（文体を凍結。first-write-wins）→ 各記事を `article:create --series <slug>` で作成（profile.style に凍結 voice を重ねて `meta.style` に焼き込む）。束の確認・修復は `series:status [--fix]`。各記事はその後、通常どおり factcheck 等の工程を通す。`--series` 時は profile が series の profile に既定で揃う（明示 `--profile` 相違は拒否＝`--allow-profile-mismatch` で許容）。**章送り（小説）の連続性・テーマ分割の計画（`series:plan`）・`/series` スラッシュコマンドは第2段以降の予定**。
