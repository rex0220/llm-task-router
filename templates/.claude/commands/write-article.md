---
description: 編集長として記事を作成→評価→ファクトチェック/構文・型チェック→修正まで駆動する
---
article-editor-in-chief サブエージェントを使い、記事を企画から仕上げまで駆動してください。

対象: $ARGUMENTS

進行:
1. topics/ の該当指示ファイル（無ければユーザーと企画を詰めて作成）と --profile を確定。
2. `llm-task-router article:create --editor-model <自分のモデルID>`（例 `claude-opus-4-8`。progress.md ヘッダに編集長として表示・作成時に固定）→ `llm-task-router article:refine` で底上げ。**読者がそのまま動かす runnable なコードを載せる記事だけ `--code-check` も付ける**（構文/型チェックは既定オフ＝省略サンプルが多いため。作成時に run 単位で固定）。
3. final-review.md を読み、停止理由・残課題・概算コストを要約して合否を判断。
4. article-factchecker（事実）を発注（**必須**）。`--code-check` を付けた記事だけ、追加で article-build-verifier（構文/型チェック・実行しない）を別系統で発注する。指摘を統合した修正指示を `llm-task-router article:revise` で適用。factchecker は claims.raw.json/sources.raw.json（id 無しの台帳素材）も出す。**コードは構文チェックの対象外でも factcheck の対象**（API 名・バージョン等の事実誤り）。
5. 編集レビューを実施（**既定で実施**）: `llm-task-router article:review-editorial`（本文と別 provider）→ editorial-review.md と候補を読み、編集長が採否を確定 → 採用分だけ `llm-task-router article:revise` で適用。スキップする場合は理由を明示。
6. **台帳の正規化は「最後に本文を変えた工程の後」に置く**（stale 台帳を防ぐ）。本文を変えたら（編集レビューの revise 含む）必ず `llm-task-router article:factcheck-scope --run <id>` を回して要否判定を台帳に残す（手動 skip で証跡を飛ばさない）。事実・見出し・数値・API 記述に触れた場合は factchecker に再確認させて claims.raw.json/sources.raw.json を最新本文に合わせ、非事実差分（重複解消・体裁等）なら `article:factcheck-stamp --accepted-after non-factual-diff --note ...` で受理する。その後 `llm-task-router article:claims-normalize --run <id> --scope full` で正規化。blocking が残る間は revise → 再 factcheck → 再 normalize で潰す。
7. **ゲート実施チェックリスト**（factcheck / editorial-review を各「実施＝結果要約」か「スキップ＝理由」で列挙。build-verify は `--code-check` を付けた run だけ `done|skipped` を宣言する。**既定オフ（未指定）の run は build-verify を列挙しなくてよい**＝verify-artifacts も対象外として宣言を要求しない）を `runs/<id>/publication-check.md` に書き出し、`llm-task-router article:verify-artifacts --run <id>` を回す（公開前ゲートの機械チェック。FAIL なら原因を潰してから再実行）。pass を確認したうえで GO/NO-GO を推奨。`llm-task-router article:export` はユーザー承認後に実行し、承認・条件付き GO の条件解決は `--note` で export イベントに残す。
