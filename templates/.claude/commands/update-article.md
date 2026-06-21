---
description: 公開済み記事を import 起点で差分更新し、編集長 GO＋承認後に再公開（同一記事の更新）まで駆動する
---
article-editor-in-chief サブエージェントを使い、**既に公開済みの記事**を「同一性（URL・骨格）を保ったまま、陳腐化した差分だけ」更新してください。新規作成（/write-article）とは別系統です。

対象（記事 slug）: $ARGUMENTS

原則（厳守）:
- `final.md` を直接編集しない。修正は必ず `llm-task-router article:revise --instruction-file` 経由。
- 全面リライトはしない（それは /write-article の領分）。変更点リストに基づく差分更新だけ。
- 公開相当の操作（export / record-publication）は**ユーザー承認後**に実行。自走で公開しない。
- 再公開は**同一 URL の更新**。新規投稿と取り違えないよう、承認時に対象 URL を必ず提示する。

進行:
1. **解決**: `export/index.json` で slug → 最新 run / 公開 URL / articleId / version を引く。次版の新 runId を決める。
2. **起点化**: `llm-task-router article:import --from export/<slug>.md --run <new-id> --supersedes <前の runId> --root <根 runId> --profile qiita`。これで `update-base.md`（版の正本）が固定保存され、`lineage` が meta に記録される。
3. **棚卸し → 差分指示**: 更新トリガー（バージョン追従／事実の陳腐化／読者FB）を確認し、変更点を `runs/<new-id>/update-instruction.md` に列挙する。各点に一次情報（新版の --help 実出力・公式リリースノート等）を根拠として添える。
4. **差分適用**: `llm-task-router article:revise --run <new-id> --instruction-file runs/<new-id>/update-instruction.md` → `llm-task-router article:update-diff --run <new-id>` で `update-diff.md` / `changed-sections.json` を生成。
4.5. **再検証対象の抽出**: `llm-task-router article:claims-recheck --run <new-id>` で `claims-recheck.md` を生成（更新前の版＝supersedes 元 run の `claims.json` を参照し、変更セクションに属する既存 claim を価格・API・バージョン優先で列挙しつつ、追加行から新規 claim を抽出すべきセクションも列挙）。
5. **差分集中の2検証**: article-factchecker（事実）と article-build-verifier（コードを含むなら構文/型チェック・実行しない）に、**`update-diff.md`（＋周辺）と `claims-recheck.md`** を渡して発注。factchecker は `claims-recheck.md` の既存 claim を再検証し、さらに update-diff.md の追加行から新規 claim を抽出して `claims.raw.json` を更新 → `llm-task-router article:claims-normalize --run <new-id> --scope diff` で台帳へ戻す。全文再検証はしない。指摘は `article:revise` で適用。
6. **GO/NO-GO**: 編集長が差分の妥当性・残課題・概算コストを要約して合否を推奨。
7. **承認後の再公開**: ユーザー承認を得てから
   - `llm-task-router article:export --run <new-id> --out <公開用パス>`（ローカル書き出し。コピーのみ）
   - `llm-task-router article:record-publication --run <new-id> --slug <slug> --url <同一URL> --article-id <articleId> --article-version <次版>`（`published` と `export/index.json` を更新）
   - 実際の公開先（同一 URL の記事）への反映はユーザーが行う。承認時に URL を提示する。
