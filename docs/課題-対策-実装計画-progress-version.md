# 実装計画：progress に llm-task-router のバージョンを記録

記事 run を「どの llm-task-router バージョンで作ったか」を残す。再現・デバッグ・挙動差分の切り分けに使う。前提ブランチ: `feat/progress-fixes`（`2a9cc5a`）の上に積む（progress 系の小追加）。

---

## 設計の確定事項
- **正本はイベント**: `ProgressEvent` に `version?: string` を追加し、**append 時に RunProgress が stamp**（`at` と同じ場所）。append-only なので、run が版アップグレードを跨いでも各イベントに「記録した版」が残る（最も忠実）。
- **version の供給元は index.ts から注入**: 既に `pkg.version`（`../package.json`）を読んでいる index.ts から **`new RunProgress(store, pkg.version)`** で渡す。
  - ⚠ RunProgress 内で `import.meta.url` 経由で package.json を読むのは不可（dev=tsx はファイル単位の相対、prod=tsup は単一バンドルの相対でパスがズレる）。**注入で一本化**する。
  - 読み取り専用の構築（`status.ts` / `completionReport.ts` の `readSnapshot` 用）は version 不要（append しない）→ 引数省略でよい（`version?` は optional）。
- **スナップショットへ集約**: `aggregate` が `toolVersion`（**`version` を持ち `ev.at` が最大**のイベントの値）を `ProgressSnapshot` に出す。複数版が混在する run は最新版を採用（必要なら将来「+others」注記、本計画では最新のみ）。配列順ではなく時刻基準にするのは `aggregate` が純関数で未ソート配列が来うるため。
- **表示**: `progress.md` ヘッダと `article:status` に `- 生成ツール: llm-task-router <toolVersion>` を1行（version があるときだけ）。completion-report の auto ブロックにも1行追加。フィールド名は `toolVersion`、表示ラベルは「生成ツール: llm-task-router …」（記事バージョンと誤読させない）。
- **互換**: 既存 run（version 無しイベント）は `toolVersion` undefined → 表示は省略（行を出さない）。後方互換の特別処理は不要。
- **JSON**: `--json` は `snapshot.toolVersion` を自然に含む（スクリプト用）。

---

## タスク分解

### T1. イベントに version を持たせて stamp
- `src/progress/types.ts`: `ProgressEvent` に `version?: string`。
- `src/progress/RunProgress.ts`:
  - コンストラクタを `(store, version?)` に。
  - **`ProgressEventInput` から `version` を除外**して、呼び出し側が version を渡せないようにする（「stamp は RunProgress の責務」を型で守る）:
    ```ts
    export type ProgressEventInput =
      Omit<ProgressEvent, "at" | "runId" | "version"> & { at?: string };
    ```
  - `appendMany` で `version: this.version` を **`...stripAt(input)` の後ろ**に置いて付与（入力の version 残骸が混ざらない・`withoutUndefined` が未設定時は落とす）。`stripAt` の戻り型も `Omit<ProgressEvent, "at" | "runId" | "version">` に揃える（TS 的に整合）。
- `src/index.ts`: **append する構築箇所**を `new RunProgress(store, pkg.version)` に変更（runWithProgress 用の各 command／`recordProgress` 内／`article:progress:event`）。読み取り専用箇所は据え置き。

### T2. スナップショット集約・表示
- `src/progress/types.ts`: `ProgressSnapshot` に `toolVersion?: string`。
- `src/progress/aggregate.ts`: events のうち **`version` を持ち `ev.at` が最大**のものの version を `toolVersion` に（配列順ではなく時刻基準。`aggregate` は純関数で未ソート配列が来うるため）。
- `src/progress/renderMarkdown.ts`: ヘッダに `- 生成ツール: llm-task-router <toolVersion>`（あるときだけ）。
- `src/cli/completionReport.ts`: `CompletionReportData` に `toolVersion?` を足し、auto ブロックに `- 生成ツール: llm-task-router <toolVersion>` を1行。

### T3. tests ＋ docs
- **tests**:
  - `RunProgress`: version 付きで構築 → append → 読み戻すと event に version が入る。version 無し構築なら event に version 無し。
  - `aggregate`: version を持つイベント列 → `toolVersion` が最新版。version 無しなら `toolVersion` undefined。**時刻基準の確認**: `at` が新しい方の version が、配列順が逆でも採用される（未ソート配列でも `ev.at` 最大が勝つ）。
  - `renderMarkdown`: `toolVersion` があると「生成ツール: llm-task-router <ver>」行が出る／無いと出ない。
  - `completionReport`: auto ブロックに「生成ツール」行（snapshot.toolVersion 由来）。
- **docs**: [docs/qiita-article-howto.md](qiita-article-howto.md) 4.5 に「progress に生成ツールのバージョンが残る」を一文。

---

## スコープ外
- 既存 run への version バックフィル（不要・互換は省略表示で足りる）。
- 版混在時の詳細表記（「最新＋others」など。将来）。
- events / progress.json のタイムゾーン（別件。UTC 維持）。

---

## 受け入れ基準
1. 新規に記録される progress イベントに `version`（= `pkg.version`）が入る。
2. `article:status` / `progress.md` / completion-report に「生成ツール: llm-task-router <ver>」が表示される（version があるとき）。
3. `--json` の snapshot に `toolVersion` が出る。
4. version の供給は index.ts 注入の一本化（RunProgress が package.json を直接読まない）。
5. 既存 run（version 無し）でも壊れず、版行が省略されるだけ。
6. `npm test` 緑・`typecheck` クリーン。

---

## 確定した論点（レビュー反映済み）
- **表示ラベル**: 「生成ツール: llm-task-router <ver>」で確定（記事バージョンと誤読しにくい）。フィールド名は `toolVersion` 維持。
- **completion-report に出す**: 採用（後から完成報告だけ見ても切り分けできる）。
- **ブランチ**: `feat/progress-fixes` に相乗り（progress 観測性改善として一体・差分小）。
- **入力型ガード（レビュー追加）**: `ProgressEventInput` から `version` を除外し、stamp は RunProgress の責務に固定。
- **toolVersion 採用基準（レビュー追加）**: 配列順ではなく `ev.at` 最大基準。
