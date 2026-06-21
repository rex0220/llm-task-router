# 実装計画：完成報告の保存（優先度2 / completion-report.md）

対象: [docs/課題-対策案.md](課題-対策案.md) の優先度2 — **完成報告を `runs/<runId>/completion-report.md` に閉じて保存**（課題7 を回収）。

この文書は実装計画のみ（コードは含まない）。優先度1で入った進捗ログ基盤（`progress.json` / `article:status`）を入力に使う。前提コミット: `feat/progress-logging`（`8d60dfe`）。

---

## 設計の確定事項（実装中に揺らさない）

- **保存先は `runs/<runId>/completion-report.md` に閉じる**。`export/index.json` には**混ぜない**（あれは `record-publication` の公開台帳＝公開 URL・版の正本。完成報告＝ローカルの作業結果サマリは別軸。対策案 §7-A）。
- **`progress.json`（進捗・費用）/ `progress.md`（再生成表示）/ `completion-report.md`（本項）で1セット**。1記事の「進捗・費用・完成」が `runs/<id>/` 内で完結する（対策案 §7-B）。
- **機械生成と編集判断を分ける**（重要）。完成報告は2層で構成する:
  - **機械由来（コードが埋める）**: タイトル / runId / profile / 各ゲートの実施状態（done/skipped）と要約 / GO/NO-GO と理由 / 概算コスト合計 / claims・sources 件数・blocking 件数 / build-verify status・検証ブロック数 / 系譜（lineage）・公開情報（published）。
  - **編集判断（編集長が埋める / プレースホルダで残す）**: 構成ナラティブ（課題.md 例の「導入→…→チェックリスト」）/ 上申事項（ユーザーに上げる論点）/ 総評。コードは**空欄プレースホルダ**として枠だけ出し、勝手に作文しない。
- **主入力は `publication-check.md`**。ゲート状態（done/skipped）・各 summary・GO/NO-GO・reason は既に編集長がここに書いている。completion-report はこれを正として転記・整形する（**ゲート判断を再評価しない**。verify-artifacts と同じく「中身の再判定はしない」方針）。
  - **`publication-check.md` のパーサは共通モジュールに切り出す**（ドリフト防止。「同じパターンを使う」だけだとコピペで必ずズレる）。現状 [src/cli/verifyArtifacts.ts](../src/cli/verifyArtifacts.ts) の `gateState` / `hasSkipReason` は非 export のローカル関数なので、`src/cli/publicationCheck.ts` を新設してそこへ移し、**verifyArtifacts と completion-report の両方から import** する（T1 で実施）。GO/NO-GO・reason 抽出も同モジュールに集約する。
- **コストの正本は `progress.json`**（対策案 §4-A）。completion-report は `progress.json.totalCostUsd` を転記し、`router.log` を再集計しない。価格表依存の「概算」である旨を明記する（対策案 §4-B）。
- **生成は冪等**。同じ run に対して再実行したら、機械由来セクションは最新の成果物で上書き再生成し、編集長が編集したプレースホルダ部分は**保護する**（後述 T3 の方針を確定させる）。
- **公開前ゲートとの順序**（必須/推奨を明確に分ける）:
  - **`publication-check.md` は必須**。無ければ明確にエラーで先行作成を促す（GO/NO-GO・ゲート宣言の正本がここにあるため）。
  - **`verify-artifacts` は推奨だが必須にしない**。未実行でも失敗（exit 1）でも completion-report は生成できる（NO-GO＝差し戻し報告もあり得るため）。GO/NO-GO と reason は `publication-check.md` から必ず転記する。
  - completion-report は「GO/NO-GO を出す材料が揃った後」に作る位置づけ（運用上は verify-artifacts を先に通してから作るのが望ましい、というだけ）。

---

## タスク分解

### T1. publication-check 共通パーサの切り出し ＋ 完成報告のデータ収集
- **追加（先に）**: `src/cli/publicationCheck.ts` を新設し、[src/cli/verifyArtifacts.ts](../src/cli/verifyArtifacts.ts) の `gateState` / `hasSkipReason` を**そこへ移して export**。さらに `parseGoNoGo(pc)` / `parseReason(pc)` / `parseGateSummary(pc, gate)` を追加する（GO/NO-GO・reason・各ゲート summary 抽出を1箇所に集約）。
  - **`verifyArtifacts.ts` を import 利用に置き換える**（ローカル定義を削除）。挙動を変えないため、移設後に既存の verify-artifacts テストが緑のままであることを確認する（リグレッション防止）。
- **追加**: `src/cli/completionReport.ts` に収集ロジック。run の各成果物を読み、`CompletionReportData` に集約する（publication-check のパースは上記共通モジュール経由）。
  - 入力（すべて optional に強く・無ければ "n/a" / 未実施扱い。silent fail させない）:
    - `meta.json`: `topic` / `articleTitle` / `profile` / `refine`（stoppedReason・finalScore・finalApproved・costUsdTotal）/ `lineage` / `published` / `finalAuthorModel` / `reviewerModel`。
    - `final.md`: 本文先頭 H1 をタイトル候補に（export と同じく body H1 を優先し、無ければ `meta.articleTitle`、さらに無ければ runId に fallback）。
    - `progress.json`（`RunProgress.readSnapshot` 経由で「読む直前に再生成」）: `totalCostUsd` / `complete` / `currentIndex` / 各 step の status。
    - `publication-check.md`: 各ゲート（factcheck / build-verify / editorial-review）の done/skipped＋summary、GO/NO-GO、reason。
    - `claims.json` / `sources.json`: 件数、blocking 件数（`isBlocking` を再利用）。
    - `build-verify-report.json`: status、checkedBlocks 件数、unverified 件数。
- **完了条件**: I/O（読み込み）と整形（次の T2）を分離し、収集部は「与えた run ディレクトリ → data オブジェクト」のテスト可能な形にする。欠損成果物は例外にせず data 上で「未実施/なし」として表現する。

### T2. Markdown レンダリング（`renderCompletionReport(data)`）
- **追加**: `src/cli/completionReport.ts`（or `src/cli/renderCompletionReport.ts`）に純関数 `renderCompletionReport(data): string`。
- **出力テンプレート**（課題.md の完成報告例に準拠。`<!-- editor: ... -->` で編集長記入欄を明示）:
  ```md
  # 完成報告: <runId>

  - 記事: <本文H1 or articleTitle or runId>
  - ファイル: final.md
  - profile: <profile>
  - 最終モデル: <finalAuthorModel>
  - 進捗: <complete ? "全工程完了" : "N / total 工程目">
  - 概算コスト合計: ~$X.XXXX（概算 / 価格表依存 / 不明分は除外）

  ## ゲート結果
  | ゲート | 状態 | 要約 |
  |---|---|---|
  | refine | <stoppedReason>（score, approved） | … |
  | factcheck | done/skipped | <summary>（claims N / sources M / blocking K） |
  | build-verify | done/skipped | <status>（checkedBlocks N / unverified M） |
  | editorial-review | done/skipped | <summary>（reviewerModel） |
  | claims-normalize | <claims.json 有無> | claims N / sources M / blocking K |
  | verify-artifacts | <OK/未実行は publication-check 経由では判定不可→注記> | … |

  ## 構成
  <!-- editor: 記事の構成ナラティブ（導入→…→まとめ）。編集長が記入 -->

  ## 上申事項（ユーザー判断を要する論点）
  <!-- editor: 企画方針との衝突・preference・大改変など。無ければ「なし」 -->

  ## 総評 / GO・NO-GO
  - GO/NO-GO: <publication-check より転記>
  - reason: <publication-check より転記>
  <!-- editor: 補足総評 -->
  ```
- **注意**: `verify-artifacts` の合否は `publication-check.md` には直接出ない（別コマンドの exit code）。表では「verify-artifacts 実行済みか」を機械判定できないため、行は出すが値は「不明 / 推奨」などの注記に留める（過剰に断定しない）。
- **完了条件**: data → 文字列の純関数。`|` エスケープなど renderMarkdown と同じ作法。スナップショットテストで列・プレースホルダを固定。

### T3. 再生成と編集長記入欄の保護（冪等性＝マーカー保護方式に決定）
- **方式は「マーカー保護方式」に確定する**（上書き＋bak は採らない。完成報告は人が編集する前提で、全面再生成は編集事故が起きやすいため）。
  - 機械由来セクションを `<!-- auto:begin --> ... <!-- auto:end -->` で囲んで出力する。再生成時は**その範囲だけを差し替え**、範囲外（`## 構成` / `## 上申事項` / `## 総評` などの editor 欄）は既存ファイルの内容をそのまま保持する。
  - 既存 `completion-report.md` がある場合: ファイルを読み、auto 範囲外のテキストを抽出 → 新しい auto ブロックと結合して書き戻す。初回（ファイル無し）は editor 欄をテンプレ（プレースホルダ）で生成。
  - editor 欄は**見出しで識別**する（auto ブロックの外にある既知の見出し配下を editor 領域とみなす）。マーカーが壊れている/見つからない既存ファイルは、安全側に倒して**バックアップ（`completion-report.bak.md`）を残してから**再生成し、警告を出す。
- **完了条件**: 「機械生成 → 編集長が構成/上申を記入 → 成果物が変わって再生成 → 編集内容が残る」を満たす。マーカー破損時は bak を残す。

### T4. CLI サブコマンド `article:completion-report`
- **追加**: `src/index.ts` に登録。
  - `--run <id>`（必須）
  - `--stdout`（ファイルに書かず標準出力へ出すドライラン）
  - `--reset-editor`（editor 欄も含めて**全面初期化**＝プレースホルダに戻す。既存内容は `completion-report.bak.md` に退避してから実施）
- **`--force` は設けない / 既定で再生成は安全**: 既定の再実行は **auto 範囲のみ差し替え・editor 欄は保持**（T3）。「`--force` だと editor 欄も消えるのか？」という曖昧さを作らないため、editor 欄を捨てる操作は `--reset-editor` という明示オプションに分離する（誤って編集を飛ばさない）。
- **挙動**: T1 収集 → T2 レンダリング → T3 のマーカー保護で `runs/<id>/completion-report.md` に保存。`publication-check.md` 不在時は「先に publication-check を作成」と促すエラー（verify-artifacts は推奨だが必須ではない）。
- **進捗記録**: この工程自体は canonical 9工程に**含めない**（export 後の報告書作成であり記事生成工程ではない。record-publication と同じ扱い）。`progress:event` も打たない。
- **allowlist**: `templates/.claude/settings.json` に `Bash(llm-task-router article:completion-report:*)` を追加（記録系と同じく読み取り中心で安全＝自動承認）。
- **完了条件**: `article:completion-report --run <id>` で `runs/<id>/completion-report.md` が生成され、ゲート結果・コスト・GO/NO-GO が埋まる。

### T5. tests ＋ ドキュメント
- **tests（`vitest`）**:
  - `publicationCheck`（共通パーサ）: gateState / hasSkipReason / parseGoNoGo / parseReason / parseGateSummary の単体。既存 verify-artifacts テストが移設後も緑（リグレッション）。
  - `completionReport`（収集）: 成果物が揃った run → data が正しく埋まる。欠損（publication-check 以外）があっても "n/a"/未実施で落ちない。
  - `renderCompletionReport`（整形）: 列・editor プレースホルダ・コスト表記・`|` エスケープ・auto マーカーの出力。
  - 再生成（マーカー保護）: editor 欄に書いた内容が、auto 範囲再生成後も残る。`--reset-editor` で editor 欄が初期化され bak が残る。マーカー破損ファイルは bak を残して再生成。
  - CLI: publication-check.md 不在で明確にエラー。`--stdout` でファイルを書かない。
- **ドキュメント**:
  - [docs/qiita-article-howto.md](qiita-article-howto.md): 「7. 書き出し」前後に「完成報告（completion-report.md）」節を追加。付録フローに1行（export の後 or 前）。
  - [templates/.claude/agents/article-editor-in-chief.md](../templates/.claude/agents/article-editor-in-chief.md): 進行の最後に「`article:completion-report` を生成し、構成/上申の editor 欄を埋めてユーザーに報告する」を追記。コマンド早見に追加。
  - [CLAUDE.md](../CLAUDE.md) / [templates/CLAUDE.md](../templates/CLAUDE.md): 完成報告を `runs/<id>/completion-report.md` に残す原則を1行（export/index.json には混ぜない旨）。
- **完了条件**: `npm test` 緑。`init` 後フォルダで `article:completion-report` がプロンプトなしで動く。

---

## 依存関係と着手順

```
T1 (共通パーサ＋収集) ─ T2 (整形) ─ T3 (マーカー保護) ─ T4 (CLI) ─ T5 (tests/docs)
```

- T1（共通パーサ切り出し＋収集）→T2（整形）が土台。T3 はマーカー保護方式（確定）。T4 で結線、T5 で配布。
- 最小縦切り: **T1 → T2 → T4（初回生成）**。マーカー保護の再生成（T3）は初回生成の直後に同 PR 内で入れる（受け入れ基準7を満たすため必須。後回しにしない）。

---

## スコープ外（この計画に含めない）

- direction-check.md（優先度3）。completion-report とは独立。
- factcheck 差分スキップ（優先度4）。
- 所要時間見積もり・Claude Code 使用量（優先度6。`progress.json` 実績が溜まってから / 手動）。
- `export/index.json` への完成サマリ追記（**意図的に行わない**。公開台帳と混ぜない）。

---

## 受け入れ基準（優先度2 全体）

1. `article:completion-report --run <id>` が `runs/<id>/completion-report.md` を生成する。
2. ゲート結果表が `publication-check.md` ＋ `claims.json` ＋ `build-verify-report.json` から埋まり、GO/NO-GO と reason が転記される。
3. 概算コスト合計が `progress.json.totalCostUsd` から入り、「概算」である旨が明示される。
4. 構成・上申・総評は編集長記入欄（プレースホルダ）として残り、コードが作文しない。
5. `export/index.json` には一切書き込まない（完成報告は `runs/<id>/` に閉じる）。
6. `publication-check.md` 不在時は明確なエラーで先行作成を促す。`verify-artifacts` 未実行/失敗でも生成は可能。
7. 再生成（既定）で editor 欄（構成/上申/総評）が残る。`--reset-editor` のときのみ初期化し、その際は bak を残す。
8. publication-check パーサが `src/cli/publicationCheck.ts` に一本化され、verify-artifacts もそれを使う（コピペ実装が無い）。
9. `npm test` 緑、`article:completion-report` がプロンプトなしで動く。
