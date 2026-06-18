# article:refine — 自動 evaluate→revise ループ 仕様案

ステータス: ドラフト / 提案
対象バージョン: 次マイナー
関連: [thin-model-router-design.md](./thin-model-router-design.md)

> 確定済みの設計判断（§13 の未決事項より）:
> 1. ファイル配置: **フラット命名**（RunStore 無改修。`refine-r1-review.json` 等）。
> 2. `--min-severity` 既定: **`major`**（収束重視）。
> 3. 悪化時の巻き戻し: **MVP は巻き戻さない**。悪化は「severity 重み付きスコア」で測るが、ミッドループの巻き戻しには使わず、停滞判定と将来の `--keep-best`（終了時にベスト版採用）に使う（§5・§8）。

## 1. 背景と目的

現状、品質ループは「半分」しか繋がっていない。

- `article:evaluate` ([evaluateQiitaFinal](../src/workflows/createQiitaArticle.ts)) は `final.md` を判定し、`final-review.json` / `final-review.md` / `revise-instruction.md` を出力する。**ただし出力するだけ**。
- `article:revise` ([reviseQiitaFinal](../src/workflows/createQiitaArticle.ts)) は instruction を受け取り `final.md` を書き換える。**ただし instruction を人が手で渡す必要がある**。

つまり README が謳う「Writer → Judge → Revise」構造は、**Judge と Revise の間が手動**で、自動では回らない。

`article:refine` は、この間を繋ぐオーケストレーション・コマンドを追加する。新しいモデル呼び出しの種類は増やさず、既存の 2 工程を「判定が通る or 上限まで」繰り返すだけにとどめる(Thin 思想を維持)。

### 非目標 (Non-goals)

- 新しい task（モデル呼び出し種別）の追加はしない。`final_review` と `rewrite` を再利用する。
- 外部 fetch / RAG / fact-check は対象外（[README のセキュリティ方針](../README.md)を維持）。
- 評価ルーブリック自体の変更はしない（`config/criteria/` をそのまま使う）。

## 2. コマンド仕様

```bash
llm-task-router article:refine --run <runId> [options]
```

| オプション | 既定 | 説明 |
| --- | --- | --- |
| `--run <runId>` | (必須) | 対象 run。`final.md` が存在している必要がある。 |
| `--max-rounds <n>` | `3` | **evaluate の最大実行回数（= ラウンド数）**。revise はラウンドの**間**にのみ走るので最大 `n-1` 回。総モデルコール数は最大 `2n-1`（`n=3` なら evaluate 3 + revise 2 = **5 コール**）。`1` 以上。 |
| `--min-severity <level>` | `major` | この深刻度以上の指摘が残る限りループを継続する基準。`critical\|major\|minor\|suggestion`。**`--until clean` の停止判定と、`clean` モードの instruction 生成 severity に使う**（`approved` モードでは instruction 生成に使わない。§3・§4 参照）。 |
| `--until <mode>` | `clean` | 停止条件。`clean` = min-severity 以上の指摘が 0 になるまで / `approved` = judge の `approved===true` まで。 |
| `--criteria <text>` / `--criteria-file <path>` | profile 由来 | evaluate と同じ解決順（[既存ロジック](../src/index.ts) を再利用）。 |
| `--config <path>` | `config/models.yaml` | 既存と同じ。 |

> 既定 `--min-severity major`：`article:evaluate` の既定 `suggestion` より厳しめにするのは、自動ループでは「直す価値のある指摘」だけを回したいため。`suggestion` まで含めると収束しにくくコストが嵩む。

## 3. アルゴリズム

`round` は **evaluate の回数**（1 始まり）。`max-rounds` はこの evaluate 回数の上限。revise はラウンドの**間**にのみ走る。

```
for round in 1..max-rounds:
  result = evaluate(final.md)              # = runFinalEvaluation（§11.1 副作用なし, final_review task）→ review + score(§5.1)

  # --- 停止判定（§4）。順序は意図的: 成功条件(clean/approved)を regressed/stalled より優先 ---
  if until == "clean"    and (min-severity 以上の指摘 == 0):  stop "clean"        # 成功（§4.2）
  if until == "approved" and result.approved == true:         stop "approved"     # 成功（§4.2）
  if regressed(score):                                        stop "regressed"    # §5.2
  if stalled(score):                                          stop "stalled"      # §5.2
  if round == max-rounds:                                     stop "max-rounds"   # これ以上 revise しても再評価しないので打ち切り

  # --- 次ラウンドの入力（instruction）を作る ---
  sev = (until == "approved") ? "suggestion" : min-severity   # §4: approved は全指摘で直す
  instruction = build_instruction(result, sev)
  if instruction is empty:                                     stop "no-instruction"  # 直す対象が無いのに停止条件も未達

  save final.md -> refine-r<round>-before.md                  # 退避（final.bak.md は使わない）
  revise(final.md, instruction)            # = reviseQiitaFinal（rewrite task, 退避スキップ）
```

ポイント:

- **必ず evaluate で始まり evaluate で終わる**。最後のラウンドは evaluate のみ（revise しない）で `final-review.*` を残す。
- 初回 evaluate が既に条件達成なら revise を 1 度も呼ばずに正常終了する。
- `max-rounds=n` のとき evaluate は最大 `n` 回、revise は最大 `n-1` 回（総コール最大 `2n-1`）。
- revise に渡す instruction は、その回の evaluate から **build_instruction で生成**（新たな instruction 生成 API は呼ばない）。`clean` モードは min-severity で、`approved` モードは全指摘（suggestion 以上）で生成する。

## 4. 停止条件

以下のいずれかで停止する。停止理由を stdout に明示する。

| 理由 | 条件 | 終了コード |
| --- | --- | --- |
| `clean` | `--until clean` かつ min-severity 以上の指摘が 0 | 0 |
| `approved` | `--until approved` かつ judge の `approved === true` | 0 |
| `max-rounds` | 上限まで回しても基準未達 | 0（警告は出すが失敗扱いにはしない） |
| `stalled` | 改善が停滞（§5.2） | 0（警告） |
| `regressed` | スコアが有意に悪化（§5.2）。スパイラル防止で即停止 | 0（警告大） |
| `no-instruction` | 停止条件未達だが、build_instruction が空（直す対象が無い） | 0（警告） |

`max-rounds` / `stalled` / `regressed` / `no-instruction` 到達時も `final.md` は壊さず、未達を **stderr の `⚠`** で知らせる(`process.exitCode` は 0 のまま)。`regressed` 時は `refine-r<N>-before.md` の方が良い可能性を明示する。CI 等で未達を失敗にしたい需要があれば、将来 `--fail-on-unresolved` を追加する余地を残す（今回は実装しない）。

### 4.1 instruction 生成 severity と `approved` モードのデッドロック回避

現行 `evaluateQiitaFinal` は min-severity でフィルタし、対象が 0 件なら `revise-instruction.md` を**削除**する（[createQiitaArticle.ts:176-185](../src/workflows/createQiitaArticle.ts)）。これをそのまま `approved` モードに使うと詰む:

> judge が `approved=false` なのに残指摘が `minor/suggestion` だけ → min-severity=major では instruction が空 → でも approved にならない → 次の revise に渡すものが無い。

回避策（§3 の `build_instruction` 引数 `sev`）:

- **`clean` モード**: `sev = min-severity`。clean の停止条件自体が「min-severity 以上 0」なので、空 instruction になる前に必ず `clean` 停止する（デッドロックしない）。
- **`approved` モード**: `sev = suggestion`（= 全指摘）。approved の目標は judge 承認なので、severity に関わらず残った指摘すべてを instruction 化して直しにいく。
- それでも instruction が空（judge が `approved=false` だが具体的指摘を 1 件も返さない）なら、回しても直しようがないので **`no-instruction` で停止**して警告する。

### 4.2 停止判定の優先順位（成功条件 > regressed/stalled）

§3 の判定順は **意図的に成功条件（clean / approved）を `regressed` / `stalled` より先**に置く。

具体例（Codex 指摘）: `--until clean --min-severity major` で、あるラウンドの評価が「major は 0 になったが suggestion が激増してスコアは悪化」だった場合 —

- min-severity=major の目標は達成（major 0）→ **`clean` 停止（成功）**。
- スコア悪化（regressed）より clean を優先するのは、ユーザーが設定した成功条件を満たした以上ループを続ける理由がないため。
- これは安全: `regressed` の目的は「悪化版を次 revise の入力にしてスパイラルするのを防ぐ」だが、成功停止ならそもそも revise しない → スパイラルは起きない。よって成功優先で regressed の目的は損なわれない。

逆に成功条件**未達**のラウンドでのみ regressed / stalled が効く（掘り続けても良くならない局面の打ち切り）。

## 5. 品質スコアと停滞検知 (stalled)

### 5.1 severity 重み付きスコア

各 evaluate 結果を 1 つの数値に畳む。単純な指摘件数は揺れに弱く（critical 1 件と suggestion 1 件が同価値になる）ので、severity で重み付けする:

```
score = Σ weight[severity]      （critical=8, major=4, minor=2, suggestion=1）
```

- スコアが**低いほど良い**。`critical` 1 件 > `suggestion` 3 件 を正しく順序付けできる。
- 重みは `severityRank`（[createQiitaArticle.ts:128](../src/workflows/createQiitaArticle.ts)）と整合する単調増加列。実装は `2 ** severityRank[severity]` で代用可（1/2/4/8）。
- スコアは min-severity フィルタ**前**の全指摘で計算する（停止判定の継続条件は min-severity フィルタ後の件数、品質比較はスコア、と役割を分ける）。

### 5.2 停滞検知

LLM-as-judge は揺れるため、スコアは単調減少しない。無限往復を避けるガード:

- 各ラウンドの revise 後に再評価し、スコアを直前ラウンドと比較する。
- **改善とみなす閾値（ヒステリシス）**: スコアが直前比で **5% 以上 かつ 絶対値 1 以上**下がったら「改善」。それ未満（横ばい・微増）は「改善なし」。
  - 1 件ぶりの増減を真の変化と誤認しないための閾値。
- 「改善なし」が **2 ラウンド連続**したら `stalled` 停止。
- スコアが**有意に増加**（直前比 +25% かつ +2 以上）したら「悪化」とみなし、**`regressed` で即停止**（§4・§8）。巻き戻さない設計では悪化版が次 revise の入力になりスパイラルするため、続行せず止めてダメージ制御する。全ラウンドの成果物が残るので人が `refine-r<N>-before.md` を選べる。

## 6. 成果物とファイル命名（フラット命名・確定）

現状 `reviseQiitaFinal` は `final.md` を `final.bak.md` に退避してから上書きする。**ループだと `final.bak.md` が毎回潰れ、履歴が 1 つ前しか残らない**。これは refine では困る。

RunStore の `filePath` は `/` `\` `..` を拒否する（[RunStore.ts:88](../src/storage/RunStore.ts)）ため、サブディレクトリは RunStore 改修を伴う。**確定方針: RunStore を改修せず、フラットなファイル名で隔離する**:

```
runs/<runId>/
  final.md                      # 常に「最新の適用版」。regressed 停止時は最良とは限らない（最良候補は refine-r<N>-before.md / 将来の --keep-best）
  refine-summary.md             # 全ラウンドの推移（score・件数・判定・コスト）
  refine-r1-review.json         # ラウンド1開始時点の評価（= final-review.json 相当）
  refine-r1-review.md
  refine-r1-instruction.md      # 適用した修正指示（= revise-instruction.md 相当）
  refine-r1-before.md           # 修正前の final.md スナップショット
  refine-r2-review.json
  refine-r2-...
  final-review.json             # 最終評価（既存コマンドと互換のため最新を複製）
  final-review.md
```

- ファイル名プレフィックス `refine-r<N>-*` で隔離。`/` を含まないので RunStore はそのまま使える。
- 既存の `article:evaluate` / `article:revise` が書くトップレベル名（`final-review.json` / `final.bak.md` 等）とは衝突しない。最終ラウンドの評価のみ `final-review.{json,md}` にも複製し、後続の `article:evaluate` を打たなくても結果が見えるようにする。
- バックアップは `final.bak.md` に依存せず、refine 側で各ラウンド開始時に `final.md` を `refine-r<N>-before.md` へ退避してから revise を呼ぶ。そのため `reviseQiitaFinal` のバックアップ処理（`final.bak.md` への退避）を**呼び出し側でスキップ/差し替え可能にする小改修**を入れる（§11）。

## 7. meta.json への記録

`RunMeta`（[RunStore.ts](../src/storage/RunStore.ts)）に refine 履歴を追加する。`steps` とは別物なので新フィールドにする:

```jsonc
{
  // ...既存フィールド...
  "refine": {
    "rounds": [
      {
        "round": 1,
        "evaluation": {              // この round の evaluate（final_review task）
          "provider": "anthropic",
          "model": "claude-opus-4-8",
          "elapsedMs": 3800,
          "costUsd": 0.0456,
          "truncated": false,        // 既存ガード（打ち切り）
          "issueCount": 5,           // min-severity 以上
          "score": 22,               // §5.1 の重み付きスコア（min-severity フィルタ前・全指摘）
          "approved": false
        },
        "revision": {                // この round の revise（rewrite task）。eval-only の最終 round では null
          "provider": "openai",
          "model": "gpt-5.4",
          "elapsedMs": 9100,
          "costUsd": 0.0412,
          "truncated": false,        // 既存ガード（打ち切り）
          "warnings": [],            // 既存ガード（wrap-text 検知）
          "beforeFile": "refine-r1-before.md"  // 将来の --keep-best 用スナップショット
        },
        "costUsdTotal": 0.0868       // evaluation + revision
      }
    ],
    // --- 開始時に確定（in-progress でも存在） ---
    "minSeverity": "major",
    "until": "clean",
    "maxRoundsAtRun": 3,             // この実行の --max-rounds。次回 cleanup 範囲に使う（中断耐性、§13-4）
    // --- 終了処理で確定する optional フィールド（実行中・中断時は未設定可） ---
    "stoppedReason": "clean",        // clean | approved | max-rounds | stalled | regressed | no-instruction
    "finalIssueCount": 0,
    "finalScore": 3,
    "finalApproved": true,
    "costUsdTotal": 0.2317
  }
}
```

> **in-progress の扱い（Codex 指摘）**: refine は開始時に `{ rounds: [], minSeverity, until, maxRoundsAtRun }` だけで `writeMeta` し、ループ中に `rounds` を追記、終了処理で `stoppedReason` / `final*` / `costUsdTotal` を確定する。よって **`stoppedReason` と `final*` / `costUsdTotal` は型上 optional**（実行中や中断後の run では未設定）。`stoppedReason` の有無で「完了 / 中断（or 実行中）」を判別できる。型の詳細は実装計画 Phase 1 参照。

- `evaluation` / `revision` を分けるのは、1 ラウンドに最大 2 コールあり provider/model/cost が別物だから（Codex 指摘）。最終 eval-only ラウンドは `revision: null`。
- `evaluation.score` と `revision.beforeFile` を毎ラウンド残すことで、将来 `--keep-best`（§8 案 3）は「全ラウンドの `evaluation.score` 最小の版を `final.md` に採用」するだけで後付け実装できる。

`article:refine` を再実行したら `refine` を上書きし、旧 `refine-r*-*` ファイルも作り直す（§13-4）。

## 8. 「悪化」の判定と巻き戻し戦略

### 8.1 そもそも悪化を厳密には測れない

各ラウンドの evaluate は**独立した再評価**。ラウンド N と N-1 の比較は「異なるテキスト」を「異なる(揺れる)判定サンプル」で測った結果であり、**「テキストが悪化した」のか「judge が違うサンプルを引いた」のかを原理的に分離できない**。厳密に測るにはペアワイズ比較（旧版 vs 新版を judge に直接勝敗判定させる）が要るが、API コール増 + Thin 逸脱のため不採用。

→ よって「悪化」は §5.1 の重み付きスコアの**増加**で近似する**ヒューリスティック**として扱い、過信しない。

### 8.2 巻き戻し 3 案

1. **巻き戻さない（MVP 採用）**: 常に最新 revise を `final.md` に採用。ただし有意悪化を検知したら `regressed` で**ループを止めて掘り進めない**（§5.2）。全ラウンドの `before` スナップショットが残るので人が選べる。単純で Thin 思想に合う。
2. **ミッドループで巻き戻し**: 悪化検知したラウンドを破棄して直前に戻す。**不採用** — 1 サンプルの揺れで良い改稿を捨てるリスクが高い。
3. **終了時にベスト版採用（将来 `--keep-best`）**: ミッドループでは一切巻き戻さず、**ループ終了後に全ラウンドのスコアを比較し最小スコアの版を `final.md` に採用**する。途中の単発誤判定で捨てないのでノイズに強い。案 2 の安全版。

→ **MVP は案 1**。案 3 を `--keep-best` フラグとして将来追加する（巻き戻しではなく「最後に選ぶ」設計）。各ラウンドの本文スナップショットと `score` を残しておけば、案 3 は後付けで実装できる（§6・§7 で score を保存する理由）。

## 9. コストと安全弁

- evaluate は最大 `max-rounds` 回、revise は最大 `max-rounds-1` 回 → 総コール最大 `2·max-rounds-1`。`--max-rounds 3` で最大 **5 コール**（§2・§3）。既存の per-step コスト概算（[cost.ts](../src/utils/cost.ts)）をラウンドごとに加算し、`refine-summary.md` と stderr の `total:` に出す。
- `--max-rounds` は必須の安全弁。上限なしは許可しない（暴走防止）。
- 既存の truncation / wrap-text ガード（[text.ts](../src/utils/text.ts)）は revise 経由でそのまま効く。

## 10. 進捗出力

現行 `WorkflowEvent`（[createQiitaArticle.ts](../src/workflows/createQiitaArticle.ts)）には **round 番号も issue 件数も score も無い**。よって `WorkflowEvent` 型は拡張せず、**refine が専用の stderr を組み立てる**:

- **ラウンド境界**（`[refine] round N/M` / `[refine] stopped: ...`）は refine が直接 stderr に出す。
- **各ステップ行**の provider/model/**elapsedMs**/cost は、評価コア `runFinalEvaluation()`（§11.1）と小改修した `reviseQiitaFinal` の **戻り値から組み立てる**（イベントを scrape しない）。戻り値の正確なフィールドは §11・§11.1・§11.2。
- `issues>=major: N` と `score` は `runFinalEvaluation()` の戻り値（`issueCount` / `score`）から付ける。

出力イメージ:

```text
[refine] round 1/3
  [1/2] evaluate (final_review) - done via anthropic/claude-opus-4-8 (3800ms, ~$0.0456) — issues>=major: 4
  [2/2] revise (rewrite) - done via openai/gpt-5.4 (9100ms, ~$0.0512)
[refine] round 2/3
  [1/2] evaluate (final_review) - done via anthropic/claude-opus-4-8 (3600ms, ~$0.0431) — issues>=major: 1
  [2/2] revise (rewrite) - done via openai/gpt-5.4 (8800ms, ~$0.0498)
[refine] round 3/3
  [1/1] evaluate (final_review) - done via anthropic/claude-opus-4-8 (3500ms, ~$0.0420) — issues>=major: 0
[refine] stopped: clean (3 rounds, ~$0.2317 estimate)
final: runs/<runId>/final.md
```

- 進捗は **stderr**、`runId` / `final` パスは **stdout**（既存規約を踏襲）。
- 停止理由の 1 行を stdout にも出し、スクリプトから判定できるようにする。

## 11. 実装範囲（既存コードへの差分）

| 箇所 | 変更 |
| --- | --- |
| [createQiitaArticle.ts](../src/workflows/createQiitaArticle.ts) | `refineQiitaFinal()` を新規追加。内部で評価ヘルパと revise を回す。score 計算 `scoreReview(review)` をヘルパ抽出。停止判定・stalled/regressed・build_instruction(sev) を実装。 |
| 評価コアの抽出（§11.1） | `evaluateQiitaFinal` から**副作用なしの評価コア** `runFinalEvaluation()` を抽出。コアはモデル呼び出し＋parse＋score のみを行い、`{ provider, model, elapsedMs, costUsd, truncated, rawReviewJson, review, score, approved, issueCount }` を返す（`truncated` = 既存ガード維持、`rawReviewJson` = 生 `response.text`、`review` = parse 済み。§11.1）。**ファイルは一切書かない**。既存 `evaluateQiitaFinal` はコアを呼んで `final-review.{json,md}`（json は `rawReviewJson`）/ `revise-instruction.md` を書く薄いラッパに変える（`article:evaluate` の挙動・出力は不変）。 |
| build_instruction の所在 | 既存の `buildRevisionInstruction(issues)`（[createQiitaArticle.ts:236](../src/workflows/createQiitaArticle.ts)）を**そのまま再利用**（severity 引数は追加しない）。**フィルタは呼び出し側の責務**: refine は `result.review.issues` を `sev` でフィルタしてから渡す（ファイル再読込はしない）。`sev = approved ? "suggestion" : min-severity`（§4.1）。空配列なら `no-instruction`。`evaluateQiitaFinal` ラッパも同様に min-severity でフィルタしてから渡す。 |
| `reviseQiitaFinal` | (1) バックアップ先を呼び出し側で制御できるよう **第6引数に `options: { backupTo?: string \| null } = {}`** を追加（`backupTo` 既定 `final.bak.md`、`null` で退避スキップ）。**第5引数 `onEvent` の後ろに足す**ので現行 `reviseQiitaFinal(router, store, runId, instruction, reporter.report)` は不変（§11.2）。(2) 戻り値に `provider`/`model`/`elapsedMs`/`costUsd`/`truncated`/`warnings` を追加（§10・§11.2。refine は noop 呼び出しのため戻り値で警告を受ける）。 |
| [index.ts](../src/index.ts) | `article:refine` コマンド追加。criteria 解決は既存 `resolveEvaluationCriteria` を再利用。 |
| [RunStore.ts](../src/storage/RunStore.ts) | `RunMeta.refine` 型追加のみ。フラット命名（§6 確定）なので save API は無改修。 |
| ReviewResultSchema | 変更なし（既存 schema を再利用）。 |
| tests | `refineQiitaFinal` の単体（モック router で各停止経路: 2 ラウンド→`clean` / 初回 clean で revise なし / `max-rounds` 到達 / `stalled`（2 連続改善なし）/ **`regressed`（score 有意増で即停止）** / **`no-instruction`（`approved=false` かつ issues=[]）** / **成功条件優先**（major 0 だが suggestion 激増でスコア悪化 → `regressed` ではなく `clean`、§4.2）。`scoreReview` の単体。`runFinalEvaluation` がファイルを書かないこと。**refine 開始時に stale なトップレベル `revise-instruction.md` を削除すること**。**`refine-r<N>-review.json` が `store.save` 経由で保存され、parse→再 stringify せず、現行 `article:evaluate` の `final-review.json`（同一 raw 入力）と内容一致すること（末尾改行正規化込み、§11.1）**。**`truncated`/`warnings` の警告維持（`runFinalEvaluation` が `truncated` を、`reviseQiitaFinal` が `truncated`/`warnings` を返し refine stderr に `⚠` が出ること）**。`reviseQiitaFinal` の後方互換（第6引数省略時 `final.bak.md` 退避）。 |

### 11.1 評価コアの分離（Codex 指摘: evaluate の副作用）

現行 `evaluateQiitaFinal` は副作用としてトップレベルの `final-review.{json,md}` と `revise-instruction.md` を作成/削除する（[createQiitaArticle.ts:158-185](../src/workflows/createQiitaArticle.ts)）。これを refine が毎ラウンド呼ぶと:

- トップレベル `revise-instruction.md` が毎ラウンド上書き/削除され、refine が適用した `refine-r<N>-instruction.md` と**食い違う**（特に approved モードは severity が違うので中身が別物になる）。
- `final-review.{json,md}` も毎ラウンド上書きされ「最終評価」の意味が壊れる。

→ **解決: 副作用なしの `runFinalEvaluation()` を抽出**し、refine はこれを使う。ファイル出力の責務は呼び出し側が持つ。

**戻り値**（ファイルは書かない）:

```ts
runFinalEvaluation(...): Promise<{
  provider; model; elapsedMs; costUsd?;
  truncated?: boolean;       // response.truncated。既存ガード（max_tokens 打ち切り警告）維持のため必須
  rawReviewJson: string;     // = response.text。final-review.json / refine-r<N>-review.json にそのまま保存
  review: ReviewResultJson;  // parse 済み。score 計算・build_instruction・停止判定に使う
  score: number;             // §5.1
  approved?: boolean;
  issueCount: number;        // min-severity 以上
}>
```

`rawReviewJson`（生テキスト）と `review`（parse 済み）の両方を返すのは、既存 `evaluateQiitaFinal` が `final-review.json = response.text`（生）を保存しているため。parse→再 stringify だと整形が変わり `article:evaluate` の出力が変質する。生テキストを保存に、parse 済みをロジックに使い分ける。

> **保存経路の注意（Codex 指摘）**: `RunStore.save()` は末尾に改行を補う（[RunStore.ts:58](../src/storage/RunStore.ts)）ので、`rawReviewJson` が改行で終わらない場合のファイル内容は「完全 byte 一致」ではなく「`store.save` の末尾改行正規化込みで一致」。refine も `store.save(runId, "refine-r<N>-review.json", rawReviewJson)` と**現行 `article:evaluate` と同じ保存経路**を通すこと（生 raw を保存する別 API は追加しない。追加すると既存 evaluate と挙動が分岐する）。要件は「parse→再 stringify しない」＝ `store.save` 後の内容が現行 `article:evaluate` の `final-review.json` と同一であること。

ファイル出力の責務:

- **refine 中の各ラウンド**: `runFinalEvaluation()` → refine が `refine-r<N>-review.json`（= `rawReviewJson`）/ `refine-r<N>-review.md` と（revise する場合のみ）`refine-r<N>-instruction.md` を書く。トップレベルの `revise-instruction.md` は **refine では作らない**（混乱回避）。
- **refine 開始時**: 既存 `article:evaluate` が残した**古いトップレベル `revise-instruction.md` を削除**する（stale 指示で誤適用しないため。`refine-r*-*` の作り直し（§13-4）と同じタイミング）。
- **refine 終了時**: 最終ラウンドの `rawReviewJson` / review.md を `final-review.{json,md}` に複製（§6）。トップレベル `revise-instruction.md` は終了後も作らない（最新指示は `refine-r<N>-instruction.md` を見る）。
- **既存 `article:evaluate`**: 従来どおり `runFinalEvaluation()` + 既存のファイル出力ラッパ（`final-review.json = rawReviewJson`、`revise-instruction.md` の生成/削除も従来どおり）。挙動・出力ファイルは不変。

### 11.2 `reviseQiitaFinal` のシグネチャ（Codex 指摘: 引数衝突）

現行: `reviseQiitaFinal(router, store, runId, instruction, onEvent?)`（第5引数 `onEvent`）。

`backupTo` を第5引数に割り込ませると既存呼び出し `(..., instruction, reporter.report)` が壊れる。**`onEvent` の後ろ、第6引数に options を足す**:

```ts
reviseQiitaFinal(
  router, store, runId, instruction,
  onEvent: WorkflowReporter = noop,
  options: { backupTo?: string | null } = {},   // 追加（既定 final.bak.md）
): Promise<{
  runId; finalText?;
  provider; model; elapsedMs; costUsd?;
  truncated?: boolean;     // response.truncated（refine は noop 呼び出しなので戻り値で警告を受ける）
  warnings?: string[];     // detectWrapText(text)（同上。wrap-text 警告）
}>
```

refine からは `reviseQiitaFinal(r, s, runId, instr, noop, { backupTo: null })` で呼ぶ（refine 側で事前に `refine-r<N>-before.md` を退避済みなので revise の退避は不要）。`truncated` / `warnings` を戻り値に乗せるのは、refine が `noop` で呼ぶため event 経由では警告を拾えないから（設計書「既存ガードが revise 経由で効く」§9 と整合）。

## 12. 受け入れ条件

- [ ] `article:refine --run X` が evaluate→revise を繰り返し、`--until` 条件 or `--max-rounds` で停止する。
- [ ] 初回 evaluate が既に clean なら revise を 1 度も呼ばずに終了する。
- [ ] revise を行ったラウンドでは指示（`refine-r<N>-instruction.md`）と修正前スナップショット（`refine-r<N>-before.md`）が残り、全ラウンドの評価（`refine-r<N>-review.*`）が残る。最終 eval-only ラウンドや初回 clean / no-instruction 停止では instruction/before は作られない。
- [ ] `meta.json` に refine 履歴と停止理由が記録される。
- [ ] ラウンドごと＋合計のコスト概算が出る。
- [ ] `--max-rounds n` で evaluate は最大 `n` 回・revise は最大 `n-1` 回に収まる（§3）。
- [ ] `--until approved` で残指摘が minor/suggestion だけでも instruction を生成して回り、judge が指摘ゼロで非承認なら `no-instruction` 停止する（§4.1・デッドロックしない）。
- [ ] `--max-rounds` / `stalled` / `regressed` / `no-instruction` でも `final.md` は壊れず、警告が出て exit 0。
- [ ] 成功条件（clean/approved）は `regressed` / `stalled` より優先される（major 0 だが suggestion 激増でスコア悪化 → `clean` 停止、§4.2）。
- [ ] refine 開始時に既存の stale なトップレベル `revise-instruction.md` が削除される（§11.1）。
- [ ] `refine-r<N>-review.json` / 複製先 `final-review.json` は `rawReviewJson` を `store.save` 経由で保存し（parse→再 stringify しない）、現行 `article:evaluate` と同じ内容になる（`store.save` の末尾改行正規化込み。完全 byte 一致ではない、§11.1）。
- [ ] 既存の `article:evaluate` / `article:revise` の挙動・出力ファイル・戻り値の既存フィールドは不変（戻り値はフィールド追加のみ）。

## 13. 決定事項 / 残課題

確定:

1. ファイル配置: **フラット命名**（§6・RunStore 無改修）。
2. `--min-severity` 既定: **`major`**（収束重視）。
3. 悪化時の巻き戻し: **MVP は巻き戻さない**（§8 案 1）。悪化は §5.1 の重み付きスコアで近似し、停止/停滞判定にのみ使用。将来 `--keep-best`（§8 案 3：終了時にベスト版採用）を追加できるよう `score` と `before` を毎ラウンド保存する。

Codex レビュー反映（v2）:

- `--max-rounds` = **evaluate 回数**に固定。revise は `n-1` 回、総コール `2n-1`（§2・§3・§9）。
- `--until approved` のデッドロック回避を §4.1 に追加（approved モードは全指摘で instruction 生成、空なら `no-instruction` 停止）。
- `final.md` の表記を「最新の適用版（regressed 時は最良とは限らない）」に修正（§6）。
- 成果物・summary をフラット命名に統一（`refine-summary.md` / `refine-r<N>-*`、§6・§9）。
- `meta.refine.rounds` を `evaluation` / `revision` に分割し cost 内訳を保持（§7）。
- 進捗は `WorkflowEvent` 非拡張、refine 専用 stderr + 評価/改稿ヘルパの戻り値拡張で出す（§10・§11）。

Codex レビュー反映（v3）:

- 評価の副作用を分離: 副作用なしの `runFinalEvaluation()` を抽出し refine はこれを使用。トップレベル `revise-instruction.md` / `final-review.*` を毎ラウンド汚さない（§11.1）。
- `reviseQiitaFinal` の `backupTo` は**第6引数 options** として追加し、第5引数 `onEvent` との衝突・後方互換破壊を回避（§11.2）。
- `reviseQiitaFinal` 戻り値にも `elapsedMs` を追加（§10・§11）。
- テスト計画に `regressed` / `no-instruction` 経路を追加（§11 tests）。

Codex レビュー反映（v4）:

- refine 開始時に既存 `article:evaluate` 由来の**古いトップレベル `revise-instruction.md` を削除**（stale 指示の誤適用防止、§11.1）。
- `runFinalEvaluation()` は `rawReviewJson`（生 `response.text`）と parse 済み `review` の**両方を返す**。`final-review.json` の生テキスト保存を維持し `article:evaluate` の出力を不変に（§11.1）。

Codex レビュー反映（v5）:

- raw JSON 保存は「完全 byte 一致」ではなく「`store.save` の末尾改行正規化込みで現行 `article:evaluate` と一致」に訂正（`RunStore.save` が末尾改行を補うため）。raw 保存用の別 API は追加しない（§11.1・§11 tests・§12）。

Codex レビュー反映（v6・実装計画と同期）:

- `runFinalEvaluation()` 戻り値に `truncated` を追加（既存 max_tokens 打ち切り警告の維持、§11.1・§11 表）。
- `reviseQiitaFinal` 戻り値に `truncated` / `warnings` を追加（refine は noop 呼び出しのため戻り値で警告を受ける、§11.2）。
- `meta.refine.rounds` の `evaluation` / `revision` に `elapsedMs` / `truncated`（revision は `warnings` も）を追加（§7）。詳細な型は実装計画 Phase 1 参照。
- 停止判定の優先順位を明文化: **成功条件（clean/approved）> regressed/stalled**。major 0 だが suggestion 激増のようなケースは `clean` 成功停止（§4.2）。

Codex レビュー反映（v7・実装計画と同期）:

- §11 表の `reviseQiitaFinal` 戻り値・tests 行を `truncated`/`warnings` 維持テストまで同期（v6 の本文と表のドリフト解消）。
- 再実行時の cleanup 範囲に `meta.refine.maxRoundsAtRun`（その実行の `--max-rounds`）を使う。前回 `maxRounds` が今回より大きく、かつ meta 追記前クラッシュした場合の orphan `refine-r<N>-*` も拾える（§13-4）。

Codex レビュー反映（v8・in-progress meta）:

- `RefineMeta` の `stoppedReason` / `final*` / `costUsdTotal` を **optional** に変更。refine 開始時は `{ rounds: [], minSeverity, until, maxRoundsAtRun }` だけで `writeMeta` するため（§7・実装計画 Phase 1）。`stoppedReason` の有無で完了/中断を判別。
- §11 表の `buildRevisionInstruction` を「severity 引数を取る形に一般化」から「**そのまま再利用＋フィルタは呼び出し側**」に訂正（計画書と統一。severity 引数は追加しない）。

Codex レビュー反映（v9・中断耐性とコスト規約）:

- 各ラウンドは evaluate 追記直後・revise 反映直後に `store.writeMeta` して永続化（中断耐性、§13-4・実装計画 Phase 4）。
- cleanup 範囲に旧 `rounds.length` を併用（`maxRoundsAtRun` 導入前の旧 meta 後方互換、§13-4）。
- コスト合算規約: `costUsd` が `undefined`（価格未設定モデル）は **0 寄せ**で `costUsdTotal` に合算。meta は 0 寄せ数値、stderr 合計表示は実額のみ（実装計画 Phase 4）。

Codex レビュー反映（v10・finalize の原子性）:

- 停止時は `finalize(reason)` で **`stoppedReason` と `final*`/`costUsdTotal` を同一 `writeMeta` で確定**（`final*` は `rounds` から導出可能なので停止時点で算出）。`stoppedReason` だけ残って `final*` が無い窓を作らず、§7 の「`stoppedReason` 有無＝完了/中断」と整合（実装計画 Phase 4）。
- 永続化タイミングを明記: 開始直後 / evaluate round 追加直後 / revise 反映直後 / `finalize`。各点で `writeMeta`（中断耐性、実装計画 Phase 4・6）。

Codex レビュー反映（v11・finalize の順序と成果物冪等性）:

- `finalize` の順序を **「①final* をメモリにセット → ②成果物生成（`final-review.*`/`refine-summary.md`）→ ③`stoppedReason` を含む完了 meta を `writeMeta`（最後）」** に確定。「meta は完了なのに成果物未生成」のクラッシュ窓を消し、`stoppedReason` 有無＝完了/中断を**成果物の有無まで含めて**閉じる（実装計画 Phase 4）。
- `finalize` の冪等性は meta だけでなく `final-review.*`/`refine-summary.md` の再生成も含む（中断復旧時に再実行すれば meta も成果物も揃う、実装計画 Phase 4）。

Codex レビュー反映（v12・完了 meta は派生オブジェクト）:

- `finalize` は `stoppedReason`/`final*` を**生きている `meta` に書かず**、`completedMeta = { ...meta, refine: { ...meta.refine, stoppedReason, final* } }` を最後の write 専用に作る。成果物生成が途中で throw しても、元 `meta`（`stoppedReason` 未設定）が retry/例外処理で誤って完了 write される事故を防ぐ（実装計画 Phase 4）。

残課題 → 確定方針:

4. **再実行は上書き**。既存ツール（`evaluate`/`revise` も上書き）との一貫性を優先。開始時に既知 suffix を列挙して旧 `refine-r<N>-*` を削除して作り直し、stale ファイルを防ぐ。削除範囲は `max(旧 maxRoundsAtRun, 旧 rounds.length, 今回の maxRounds)`。`maxRoundsAtRun` を使うのは meta 追記前クラッシュの orphan を拾うため、`rounds.length` も併用するのは `maxRoundsAtRun` 導入前の旧 meta（フィールド無し）でも範囲を取れるようにするため（中断耐性＋後方互換）。各ラウンドは evaluate 追記直後・revise 反映直後に `writeMeta` して永続化する（中断耐性）。
5. **ヒステリシス閾値は初期値のままコード内定数**（改善 5%/+1、stalled は改善なし 2 連続）。CLI フラグにはしない（Thin 維持）。stalled は score 比較を 2 連続で要するため evaluate が 3 回目（round 3）以降で初めて発火し得る。`--max-rounds 3` でも round 3 で stalled 判定が max-rounds 判定より**先**に走る（§3 の判定順）ので、2 連続改善なしなら停止理由は `stalled`（max-rounds ではなく）。`--max-rounds` を上げるほど早期 stalled の機会が増える。実運用ログを見て定数調整。
6. **悪化は独立の停止理由 `regressed` として即停止**（前案の「警告のみ続行」から変更）。巻き戻さない設計では悪化した `final.md` が次 revise の入力になりスパイラルする risk があるため、有意悪化（25%/+2、ノイズはヒステリシスで除外済み）を検知したらダメージ制御として停止。stderr で大きく警告し `refine-r<N>-before.md` が良い可能性を明示。停止理由は **clean / approved / max-rounds / stalled / regressed / no-instruction** の 6 種（§4）。
