# article:refine 実装計画書

作成日: 2026-06-18
参照設計書: [article-refine-loop-design.md](./article-refine-loop-design.md)

## 1. 目的

設計書で確定した自動 evaluate→revise ループ（`article:refine`）を実装する。既存の `final_review` / `rewrite` タスクを束ねるだけの薄い実装にとどめ、新しいモデル呼び出し種別・外部 fetch・RAG は追加しない（Thin 思想の維持）。

## 2. 前提（設計書からの確定事項）

- ファイル配置は**フラット命名**（`refine-r<N>-*` / `refine-summary.md`）。RunStore は無改修（型追加のみ）。
- `--min-severity` 既定 `major`、`--until` 既定 `clean`、`--max-rounds` 既定 `3`（= evaluate 回数）。
- 停止理由は **clean / approved / max-rounds / stalled / regressed / no-instruction** の 6 種。
- 成功条件（clean/approved）は regressed/stalled より優先（§4.2）。
- 巻き戻しなし。悪化は severity 重み付きスコアで近似し停止判定にのみ使用。
- 評価コアは副作用なしの `runFinalEvaluation()` に分離し、ファイル出力責務は呼び出し側が持つ（§11.1）。

## 3. 変更ファイル一覧

| ファイル | 変更種別 | 内容 |
| --- | --- | --- |
| [src/storage/RunStore.ts](../src/storage/RunStore.ts) | 型追加のみ | `RunMeta` に `refine?: RefineMeta` を追加（§7）。save API は無改修。 |
| [src/workflows/createQiitaArticle.ts](../src/workflows/createQiitaArticle.ts) | リファクタ＋新規 | `runFinalEvaluation()` 抽出、`evaluateQiitaFinal` をラッパ化、`buildRevisionInstruction` のフィルタ責務を呼び出し側へ移動、`scoreReview()` 追加、`reviseQiitaFinal` シグネチャ拡張、`refineQiitaFinal()` 新規。 |
| [src/index.ts](../src/index.ts) | コマンド追加 | `article:refine` コマンド、refine 用 stderr レポータ。 |
| [tests/workflows/createQiitaArticle.test.ts](../tests/workflows/createQiitaArticle.test.ts) | テスト追加 | refine の各停止経路・副作用・後方互換。Mock provider にレビュー列挙機能を追加。 |
| [package.json](../package.json) | script 追加 | `article:refine` の npm script。 |
| [README.md](../README.md) / [README.ja.md](../README.ja.md) | 追記 | `article:refine` の説明・使用例。 |

## 4. フェーズ別実装計画

### Phase 1: 型と定数（依存なし・最初に確定）

目的: 後続フェーズが参照する型と定数を先に置く。

作業:

- `RunStore.ts` に `RefineMeta` 型を追加（設計書 §7 の形）。具体フィールド:
  ```ts
  type RefineRoundEval = {
    provider: string; model: string; elapsedMs: number; costUsd?: number;
    truncated?: boolean;          // evaluate の打ち切り（#2）
    issueCount: number;           // minSeverity 以上
    score: number;                // §5.1
    approved?: boolean;
  };
  type RefineRoundRevision = {
    provider: string; model: string; elapsedMs: number; costUsd?: number;
    truncated?: boolean; warnings?: string[];   // 既存ガード（#2/#3）
    beforeFile: string;           // refine-r<N>-before.md
  };
  type RefineRoundMeta = {
    round: number;
    evaluation: RefineRoundEval;
    revision: RefineRoundRevision | null;   // 停止ラウンドは null（#1）
    costUsdTotal: number;   // (evaluation.costUsd ?? 0) + (revision?.costUsd ?? 0)。価格未設定は 0 寄せ（#3）
  };
  type RefineMeta = {
    // 開始時に確定するフィールド（in-progress でも成立）
    rounds: RefineRoundMeta[];
    minSeverity: Severity; until: "clean" | "approved";
    maxRoundsAtRun: number;   // この実行の --max-rounds。次回 cleanup 範囲に使う（中断耐性、#4）
    // 終了処理で確定する optional フィールド（実行中は未設定、#1）
    stoppedReason?: "clean" | "approved" | "max-rounds" | "stalled" | "regressed" | "no-instruction";
    finalIssueCount?: number; finalScore?: number; finalApproved?: boolean;
    costUsdTotal?: number;
  };
  ```
  - `RunMeta` に `refine?: RefineMeta` を追加（オプショナルなので既存 run と後方互換）。
- `createQiitaArticle.ts`（または近傍）に定数を置く:
  - `SEVERITY_WEIGHT: Record<Severity, number>`（`2 ** severityRank`: suggestion=1, minor=2, major=4, critical=8）
  - ヒステリシス定数 `IMPROVE_REL=0.05` / `IMPROVE_ABS=1` / `REGRESS_REL=0.25` / `REGRESS_ABS=2` / `STALL_STREAK=2`（CLI フラグにはしない、§13-5）

受け入れ条件:

- `npm run build` が通る（型のみ追加なので既存ロジック不変）。
- 既存テストが緑のまま。

### Phase 2: 評価コアの分離（§11.1）

目的: `evaluateQiitaFinal` の副作用をはがし、refine と `article:evaluate` の両方から使える純粋コアを作る。**挙動互換が最重要**。

作業:

- `runFinalEvaluation(router, store, runId, options)` を新規抽出。モデル呼び出し＋parse＋score のみ。**ファイルを書かない**。戻り値:
  ```ts
  { provider; model; elapsedMs; costUsd?;
    truncated?: boolean;       // response.truncated（既存ガード維持のため必須。#2）
    rawReviewJson: string;     // response.text（生）
    review: ReviewResultJson;  // parse 済み
    score: number;             // scoreReview(review)
    approved?: boolean;
    issueCount: number;        // minSeverity 以上
  }
  ```
- `scoreReview(review): number` を追加（`SEVERITY_WEIGHT` で全指摘を加算、§5.1）。
- `buildRevisionInstruction` の責務を統一: **フィルタは呼び出し側が行い、`buildRevisionInstruction(issues)` は渡された（フィルタ済み）配列をそのまま整形する**。現状 `evaluateQiitaFinal` 内にある severity フィルタは呼び出し側（ラッパ / refine）へ移す。severity 引数は追加しない。
- 既存 `evaluateQiitaFinal` を `runFinalEvaluation` のラッパに変更:
  - `runFinalEvaluation` を呼ぶ
  - `store.save(runId, "final-review.json", rawReviewJson)` … **生テキストを現行と同じ保存経路で**（§11.1。`store.save` の末尾改行正規化込みで現行と一致）
  - `final-review.md` 生成（既存 `buildReviewSummary`）
  - minSeverity でフィルタ → `buildRevisionInstruction` で `revise-instruction.md` を生成、対象0件なら削除（既存挙動維持）
  - 進捗 event には従来どおり `truncated`（= 戻り値の `truncated`）を流す（#2）
  - 戻り値の既存フィールド（`EvaluationResult`）は不変に保つ → index.ts 影響なし

受け入れ条件:

- 既存の `article:evaluate` テスト（evaluate / stale 削除 / judge routing の 3 本）が**無改修で緑**。
- `runFinalEvaluation` 単体: ファイルが 1 つも作られないこと、`rawReviewJson` が `response.text` と同一、`score` が手計算と一致。

### Phase 3: `reviseQiitaFinal` の拡張（§11.2）

目的: refine がバックアップ先を制御でき、進捗行を戻り値から組めるようにする。後方互換厳守。

作業:

- シグネチャを **第6引数 options 追加**に変更（第5 `onEvent` の後ろ）:
  ```ts
  reviseQiitaFinal(router, store, runId, instruction,
    onEvent: WorkflowReporter = noop,
    options: { backupTo?: string | null } = {},
  ): Promise<{
    runId; finalText?;
    provider; model; elapsedMs; costUsd?;
    truncated?: boolean;     // response.truncated（#3）
    warnings?: string[];     // detectWrapText(text)（#3）
  }>
  ```
- `options.backupTo` 既定 `"final.bak.md"`、`null` で退避スキップ。
- 戻り値に `provider`/`model`/`elapsedMs`/`costUsd` に加え **`truncated` / `warnings` を追加**。refine は `noop` で呼ぶため、これらを戻り値に乗せないと max_tokens 打ち切り警告・wrap-text 警告を refine 専用 stderr に出せない（設計書「既存ガードが revise 経由で効く」と整合、#3）。既存 event 出力（onEvent 経由）も従来どおり。

受け入れ条件:

- 既存 revise テスト 2 本（backup / fence 除去）が**無改修で緑**（第6引数省略時 `final.bak.md` 退避が従来どおり）。
- `backupTo: null` を渡すと `final.bak.md` を作らないテスト。

### Phase 4: `refineQiitaFinal()` 本体（§3・§4・§5）

目的: ループ・停止判定・成果物保存・meta 記録を実装する。

作業:

- `refineQiitaFinal(router, store, runId, options, onEvent)` を新規。`options: { maxRounds; minSeverity; until; criteria? }`。
- **開始処理**（#5: RunStore に glob/list が無いので既知 suffix を列挙して削除）:
  - `cleanupTo = max(oldMeta.refine?.maxRoundsAtRun ?? 0, oldMeta.refine?.rounds.length ?? 0, maxRounds)` まで `for (n of 1..cleanupTo)` で `refine-r<n>-{review.json,review.md,instruction.md,before.md}` を `store.remove`（`remove` は `force:true` で不在でも無害）。`refine-summary.md` も `store.remove`。
  - 旧 `maxRoundsAtRun` を使うのは、前回が「ラウンド成果物保存後・meta 追記前」にクラッシュして旧 `rounds` 配列に出ない orphan が残った場合でも、前回の上限まで掃除すれば拾えるため（中断耐性、#4）。`oldRounds.length` だと前回 `maxRounds=5` で round 4 保存後クラッシュ → 今回 `maxRounds=3` 再実行時に `refine-r4-*` を取りこぼす。
  - `oldMeta.refine?.rounds.length` も上限に含めるのは、`maxRoundsAtRun` 導入**前**に作られた旧 meta（このフィールドが無く `undefined → 0`）でも `rounds.length` から削除範囲を拾えるようにするため（後方互換、#2）。
  - stale なトップレベル `revise-instruction.md` も `store.remove`（§11.1・§13-4）。
  - 順序厳守: ①旧 `meta.refine?.maxRoundsAtRun` を読む → ②上記 cleanup（`refine-r*-*` / `refine-summary.md` / `revise-instruction.md` 削除）→ ③`meta.refine` を **`{ rounds: [], maxRoundsAtRun: maxRounds, minSeverity, until }`** で初期化して `writeMeta`。`stoppedReason` / `final*` / `costUsdTotal` は**終了処理で確定する optional フィールド**なのでここでは設定しない（#1。`RefineMeta` 型で optional にする）。③で今回の `maxRoundsAtRun` を残すので、今回のループ中にクラッシュしても次回の cleanup が今回の上限まで掃除できる。
- **ループ**（§3 擬似コードのとおり、`round` = evaluate 回数）:
  1. `runFinalEvaluation` 実行 → `refine-r<N>-review.{json,md}` 保存（json は `rawReviewJson`）
  2. **この時点で round を `meta.refine.rounds` に追加**（`evaluation` を埋め、`revision: null`、`costUsdTotal = evaluation.costUsd ?? 0`）→ **`store.writeMeta(meta)`**（中断耐性、#1）。revise しない停止経路（clean/approved/max-rounds/stalled/regressed/no-instruction）でも最終 evaluate ラウンドが必ず永続化される。
  3. 停止判定（順序厳守、§4.2）: clean → approved → regressed → stalled → max-rounds。いずれかなら **`finalize(reason)`** を呼んで break（下記）。
  4. `sev = until==="approved" ? "suggestion" : minSeverity` でフィルタ → 空なら **`finalize("no-instruction")`** で break。
  5. `refine-r<N>-instruction.md` 保存、`final.md` を `refine-r<N>-before.md` へ退避
  6. `reviseQiitaFinal(..., noop, { backupTo: null })` → **戻り値で当該 round の `revision` を埋め**（provider/model/elapsedMs/costUsd/before/truncated/warnings）、`costUsdTotal = (evaluation.costUsd ?? 0) + (revision.costUsd ?? 0)` に更新 → **`store.writeMeta(meta)`**（#1）。
- **`finalize(reason)`（停止時の確定処理。順序が重要）**:
  1. `final*` を**ローカル変数**で算出（`finalScore`/`finalIssueCount`/`finalApproved` は最終 round の `evaluation` から、`costUsdTotal` は全 round 合計）。**生きている `meta.refine` には `stoppedReason`/`final*` をまだ書かない**。
  2. **成果物を先に生成**: 最終 round の `rawReviewJson`/review.md を `final-review.{json,md}` に複製、`refine-summary.md` を生成。
  3. **完了 meta を派生オブジェクトとして作って write**: `const completedMeta = { ...meta, refine: { ...meta.refine, stoppedReason: reason, finalScore, finalIssueCount, finalApproved, costUsdTotal } }` → `store.writeMeta(completedMeta)`。
  - 生きている `meta` に `stoppedReason` を持たせないのは、手順 2 の成果物生成が throw した場合に、例外処理や将来の retry が同じ `meta` を誤って `writeMeta` しても**完了扱いにならない**ため（中断＝`stoppedReason` 未設定 のまま残す、Codex 指摘）。
  - この順序により「`stoppedReason` あり ⟹ `final*` も成果物（`final-review.*`/`refine-summary.md`）も揃っている」が成立し、§7 の「`stoppedReason` 有無＝完了/中断」が**成果物の有無まで含めて**閉じる（#1）。逆順（write 先・成果物後）や、生き meta への先付けはしない。
- **コスト合算規約（#3）**: `costUsd` が `undefined`（= `models.yaml` に価格未設定/0 のモデル。[README の cost ルール](../README.md)）は **0 として合算**する。`RefineRoundMeta.costUsdTotal` と `RefineMeta.costUsdTotal` は常に数値（不明分は 0 寄せ）。stderr の合計表示は既存 `createProgressReporter` と同様、cost が取れた分のみを積む（meta は 0 寄せ数値、表示は実額のみ、と役割を分ける）。
- `stalled` / `regressed` 判定はヘルパに切り出す（直前ラウンド score との比較＋ヒステリシス）。score 履歴は `meta.refine.rounds[].evaluation.score` から取得。
- **終了処理は `finalize(reason)` に集約**（上記）。ループはどの停止経路でも必ず `finalize` を通って抜ける（評価成功 = clean/approved、打ち切り = max-rounds/stalled/regressed/no-instruction のすべて）。
- **`finalize` の冪等性は meta だけでなく成果物も含む（#2）**: 再呼び出し時は `final-review.{json,md}` / `refine-summary.md` も同じ内容で再生成する（同じ `rounds` から決定的に作られる）。`stoppedReason` 未設定（= 前回が `finalize` 前に中断）で復旧するとき、`finalize` を再実行すれば meta も成果物も揃う。meta だけ冪等では成果物が欠けた中断復旧に足りないため。
- 戻り値: `{ runId, finalText, stoppedReason, rounds, costUsdTotal }`（CLI 出力用）。

受け入れ条件:

- §12 受け入れ条件の各項目に対応する単体テスト（Phase 6）が緑。
- `final.md` は常に「最新の適用版」。どの停止経路でも壊れない。

### Phase 5: CLI `article:refine`（§2・§10）

目的: コマンドと専用進捗出力を追加する。

作業:

- `index.ts` に `article:refine` コマンド追加:
  - `--run`（必須）/ `--max-rounds`（既定3, 1以上を検証）/ `--min-severity`（既定 major, 既存 `parseSeverity` 再利用）/ `--until`（既定 clean, `clean|approved` 検証）/ `--criteria` / `--criteria-file`（既存 `resolveEvaluationCriteria` 再利用）/ `--config`
- refine 専用 stderr 出力（§10）: round 境界 `[refine] round N/M`、各ステップ行（戻り値から組む）、`issues>=<sev>: N` と score、`[refine] stopped: <reason> (...)`。
- **警告行**: evaluate/revise の戻り値の `truncated`（max_tokens 打ち切り）と revise の `warnings`（wrap-text）を既存コマンドと同じ `⚠` 形式で stderr に出す（#2/#3。既存 `createProgressReporter` の警告表示と文言を揃える）。
- stdout は `runId` / `final` パス＋停止理由 1 行（既存規約）。
- `package.json` に `"article:refine": "tsx src/index.ts article:refine"` を追加（受け入れ条件で `npm run` を使うため Phase 5 で前倒し、#1）。

受け入れ条件:

- `npm run article:refine -- --help` が動き、オプションが表示される（CLI 経由で mock を差し込む仕組みは無いので、ループ動作の検証は Phase 6 の関数テストに寄せる）。
- 不正引数の検証が効く（`--max-rounds 0` / 不正 `--min-severity` / 不正 `--until` でエラー）。
- 実 API を使う場合は既存 run（`final.md` あり）に対して 1 回疎通確認（任意・手動）。
- stdout/stderr の分離が既存コマンドと一貫。

### Phase 6: テスト（§11 tests・§12）

目的: 課金（ループ回数）と成果物・後方互換を保護する。

作業（Mock provider 拡張）:

- `WorkflowProvider` に **レビュー列挙** `reviewQueue: string[]` を追加し、`final_review`/`technical_review` 呼び出しごとに先頭から返す（ラウンドごとに異なる review を返すため）。`nextReview` は単発互換で残す。

追加テスト:

- 停止経路: `clean`（2 ラウンドで major 0）/ 初回 clean（revise 0 回）/ `max-rounds` 到達 / `stalled`（2 連続改善なし）/ `regressed`（score 有意増で即停止）/ `no-instruction`（`approved=false` かつ issues=[]）。
- **成功条件優先**: major 0 だが suggestion 激増でスコア悪化 → `regressed` ではなく `clean`（§4.2）。
- **コール回数**: `--max-rounds n` で evaluate ≤ n・revise ≤ n-1。
- **副作用**: `runFinalEvaluation` がファイルを書かない。refine 中トップレベル `revise-instruction.md` を作らない。開始時に stale な `revise-instruction.md` を削除。
- **cleanup 範囲（中断耐性）**: 旧 `meta.refine.maxRoundsAtRun` が今回 `maxRounds` より大きい場合も `refine-r<N>-*` を掃除する（前回 `maxRoundsAtRun=5`・`refine-r4-*` 残置 → 今回 `maxRounds=3` 再実行で `refine-r4-*` が消えることを検証。#3 の反例そのもの）。
- **raw 保存**: `refine-r<N>-review.json` が `store.save` 経由で、parse→再 stringify せず現行 `article:evaluate` と同内容（末尾改行正規化込み、完全 byte 一致ではない）。
- **成果物**: revise したラウンドのみ `instruction`/`before` が残る。最終 eval-only・初回停止では作られない。
- **meta（完了時）**: 正常終了した run では `meta.refine` に rounds（evaluation/revision 分割）・`stoppedReason`・`finalScore`/`finalIssueCount`・`costUsdTotal` が記録される。**revise しない停止経路でも最終 evaluate ラウンドが `revision: null` で記録される**（#1。clean/max-rounds/no-instruction の各ケースで rounds 末尾を検証）。
- **meta（in-progress / 中断）**: 開始直後の `writeMeta` 後は `{ rounds: [], minSeverity, until, maxRoundsAtRun }` のみで、`stoppedReason` / `final*` / `costUsdTotal` は **未設定**（optional、#2）。`stoppedReason` の有無で完了/中断を判別できることを確認。
- **段階的永続化（中断耐性）**: spy/wrap した `store.writeMeta` の呼び出しを観測し、(a) 開始直後 (b) 各 evaluate round 追加直後（`rounds.length` が増え `revision: null`）(c) 各 revise 反映直後（`revision` が埋まる）(d) `finalize` で `stoppedReason`+`final*` が同一 write で確定、の順に永続化されることを検証（#1/#2/#3）。`finalize` 後は `stoppedReason` と `final*` が必ず揃っている（片方だけの状態が無い）。
- **完了 ⟹ 成果物（finalize 順序）**: `stoppedReason` が書かれた最終 `writeMeta` の時点で `final-review.{json,md}` と `refine-summary.md` が既に存在することを検証（v11 の「成果物生成→完了 write」順。`store.writeMeta` spy 内で成果物の有無を assert する等）。`finalize` を 2 回呼んでも meta・成果物が同一になる冪等テスト。
- **警告維持**: evaluate が `truncated` を、revise が `truncated`/`warnings` を戻り値で返し、refine stderr に `⚠` が出る（#2/#3）。`runFinalEvaluation` 単体で `truncated` を、`reviseQiitaFinal` 単体で `truncated`/`warnings` を返すことも確認。
- **後方互換**: 既存 evaluate 3 本・revise 2 本が無改修で緑。

受け入れ条件:

- `npm test` が緑。外部 API を呼ばない。

### Phase 7: ドキュメント

作業:

- README / README.ja に `article:refine` の説明・使用例・停止理由・成果物（`refine-r<N>-*` / `refine-summary.md`）を追記。`evaluate`→`revise` の手動手順との関係（refine は自動版）を明記。（npm script は Phase 5 で追加済み、#1）

受け入れ条件:

- README だけで `article:refine` を実行できる。

## 5. 実装順序

1. Phase 1（型・定数）
2. Phase 2（評価コア分離）← 既存 evaluate テストで安全網を確認しながら
3. Phase 3（revise 拡張）← 既存 revise テストで後方互換確認
4. Phase 4（refine 本体）
5. Phase 5（CLI）
6. Phase 6（テスト拡充）
7. Phase 7（README）

理由: 既存関数のリファクタ（Phase 2/3）を先に終え、各々の既存テストで挙動不変を保証してから、新規の refine 本体（Phase 4）を積む。外部 API 非依存なので全フェーズ mock でテスト可能。

## 6. リスクと注意

- **既存 evaluate の挙動変化**: Phase 2 のラッパ化で `final-review.json` の内容や `revise-instruction.md` の生成/削除条件が変わると `article:evaluate` の回帰になる。既存 3 テストを無改修で通すことを不可侵の制約にする。
- **score の揺れ**: ヒステリシス定数は初期値。実運用ログを見て調整（フラグ化しない）。stalled は evaluate 3 回目以降で初めて発火し得る点に注意（§13-5）。
- **コスト暴走**: `--max-rounds` を必須安全弁とし、上限なしを許可しない。テストでコール回数上限を検証。
- **Windows パス**: 成果物はフラット命名で `RunStore` の `/` 禁止に抵触しない。サブディレクトリは作らない。

## 7. 完了条件

- `npm run build` / `npm test` が緑。
- `article:refine` が 6 停止理由すべてで正しく停止し `final.md` を壊さない。
- 既存 `article:evaluate` / `article:revise` の挙動・出力・戻り値既存フィールドが不変。
- `meta.refine` と `refine-r<N>-*` / `refine-summary.md` が設計書どおり生成される。
- README に使用例がある。

## 8. 本計画でやらないこと（将来課題）

- `--keep-best`（終了時に最小スコア版採用、§8 案 3）。今回は `score`/`before` を保存するだけ。
- `--fail-on-unresolved`（未達を exit 非0 に）。
- ヒステリシス定数の CLI フラグ化。
- ペアワイズ比較による悪化判定（Thin 逸脱のため不採用）。
