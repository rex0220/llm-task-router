# 生成AI 編集レビューの自動化 実装計画

> 対象仕様: [editorial-review-spec.md](editorial-review-spec.md)（提案・Codex 12巡反映）
> 作成: 2026-06-20
> 方針: 仕様 §11 の3段（独立 → 継続 → 安定化）に沿う。既存の `ModelRouter`/タスク機構・`evaluate→revise` パターン・`update-diff` を再利用し、**編集レビュアーはパイプラインのモデルタスク**（サブエージェントにしない、spec §12.1）。

---

## 0. 現行コードのアンカー（変更起点）

| 領域 | 現状 | ファイル |
|---|---|---|
| タスク列挙 | `ModelTask` union（8種）。`editorial_review` 無し。 | [router/types.ts:3-11](../src/router/types.ts#L3-L11) |
| config 検証 | `modelTaskSchema` enum がタスク名を固定。 | [router/config.ts:7-16](../src/router/config.ts#L7-L16) |
| スキーマ | `SchemaName` union（3種）＋ `schemaRegistry`/`schemaHints`。 | [router/types.ts:13](../src/router/types.ts#L13), [schemas/index.ts](../src/schemas/index.ts) |
| 候補組み立て | `const candidates = [taskConfig.primary, ...(taskConfig.fallback ?? [])]`。除外機構なし。 | [router/ModelRouter.ts:28](../src/router/ModelRouter.ts#L28) |
| request 型 | `ModelRequest`（task/input/schemaName/maxTokens/temperature）。`excludeProviders` 無し。 | [router/types.ts:15-22](../src/router/types.ts#L15-L22) |
| 実応答の provider/model | `ModelResponse.provider/model` が候補から確定（記録可能）。 | [router/ModelRouter.ts:82-96](../src/router/ModelRouter.ts#L82-L96) |
| profile | `criteria_file` のみ。`editorial_criteria_file` 無し。 | [workflows/profile.ts:14-19](../src/workflows/profile.ts#L14-L19) |
| 評価→修正の型 | `runFinalEvaluation`/`evaluateQiitaFinal`/`buildRevisionInstruction`（severity=critical/major/minor/suggestion）。 | [workflows/createQiitaArticle.ts](../src/workflows/createQiitaArticle.ts) |
| final.md 更新経路 | create の final step（`runQiitaArticle`）・`reviseQiitaFinal`・refine 内 revise・import。 | createQiitaArticle.ts / [cli/import.ts](../src/cli/import.ts) |
| 差分生成 | `generateUpdateDiff(base, final)` は任意の base/final で動く（継続の since-last に流用可）。 | [cli/updateDiff.ts](../src/cli/updateDiff.ts) |
| RunMeta | published/lineage/tags 等あり。`finalAuthorModel`/`reviewerModel`/editorial round 無し。 | [storage/RunStore.ts](../src/storage/RunStore.ts) |
| models.yaml | `rewrite` = OpenAI primary / **Anthropic fallback**（finalAuthor は両 provider になり得る）。 | [config/models.yaml](../config/models.yaml) |

---

## 1. ワークストリーム一覧

| WS | 内容 | 仕様 | 段階 |
|---|---|---|---|
| WS1 | router/型の土台（`editorial_review` task enum、`EditorialReview` schema、`ModelRequest.excludeProviders`＋候補 filter） | §5.2 §13 | 第1段 |
| WS2 | `finalAuthorModel`/`reviewerModel` 記録（RunMeta＋final.md 更新経路・import=external） | §5.1 | 第1段 |
| WS3 | `editorial_review` の config（models.yaml 両 provider candidate set、criteria/editorial.md、profile の `editorial_criteria_file`＋合成順） | §5.3 §13 | 第1段 |
| WS4 | 編集レビュー・コア（独立モード：criteria 合成→raw→normalize(id/status:open)→候補生成＋専用 formatter＋独立性 filter/override/recheck） | §5.1 §5.2 §5.4 | 第1段 |
| WS5 | CLI `article:review-editorial --mode independent` ＋ index 配線 | §8 | 第1段 |
| WS6 | 運用接続（editor-in-chief ③トリアージ、`/review-editorial` command、allowlist、CLAUDE.md。templates＋repo） | §12 | 第1段 |
| WS7 | 継続レビュー（`EditorialReviewContinuation`、`editorial-r<N>-before.md`＋前回 hash、since-last 差分、status 解決追跡、`--mode continuation`） | §5.5 | 第2段 |
| WS8 | 安定化・評価（`TaskConfig`/request に seed・サンプル数、複数サンプル中央値、ハイブリッド運用、手動 vs 自動 一致率ハーネス） | §9 §11 | 第3段 |

実装順: **WS1 → WS2 → WS3 → WS4 → WS5 → WS6**（第1段）で独立レビューを通し、**WS7**（第2段）で継続、**WS8**（第3段）で安定化。

---

## 2. 第1段（独立レビュー）

### WS1: router/型の土台
- [router/types.ts](../src/router/types.ts): `ModelTask` に `"editorial_review"`、`SchemaName` に `"EditorialReview"` を追加。`ModelRequest` に **`excludeProviders?: string[]` と `excludeCandidates?: {provider, model}[]`** を追加。
  - **なぜ candidate 単位も要るか**: `--allow-same-provider` は「同 provider の別 model は使うが**完全同一 model だけ落として次候補へ進む**」挙動（spec §5.1）。provider 除外だけでは表現できず、**応答後 reject だと [ModelRouter.ts:28](../src/router/ModelRouter.ts#L28) の候補順で先に成功した同一 model で打ち止め、使える fallback に到達できない**。事前の candidate(provider+model)除外で次候補へ進ませる。
- [router/config.ts:7-16](../src/router/config.ts#L7-L16): `modelTaskSchema` enum に `"editorial_review"` を追加（**これが無いと models.yaml に足しても config validation で落ちる**、spec §13）。
- [schemas/](../src/schemas/): `EditorialReviewSchema`（raw・独立モード。`verdict`/`scores[]`/`strengths[]`/`weaknesses[]`（id なし）/`summary`）を新規。[schemas/index.ts](../src/schemas/index.ts) の `schemaRegistry`/`schemaHints` に登録。
- [router/ModelRouter.ts:28](../src/router/ModelRouter.ts#L28): 候補を **provider 除外（`excludeProviders`）＋ candidate(provider+model)除外（`excludeCandidates`）の両方で filter** する。filter 後に候補が空なら設定/独立性エラーで**早期に失敗**（応答後 reject だけにしない）。

**テスト**（`tests/router/ModelRouter.test.ts`）: `excludeProviders` で同 provider 候補スキップ／`excludeCandidates` で完全同一 model だけ落として次候補に進む／全除外で失敗。config テストで `editorial_review` task が通る。

### WS2: `finalAuthorModel` / `reviewerModel` 記録
- [storage/RunStore.ts](../src/storage/RunStore.ts) `RunMeta`: `finalAuthorModel?: {provider, model} | "external"`、`reviewerModel?: {provider, model}` を追加。
- **final.md を更新する全経路で `finalAuthorModel` を実応答（`ModelResponse.provider/model`）で更新**:
  - create の final step（`runQiitaArticle` の rewrite 応答）
  - `reviseQiitaFinal`（revise 応答）→ factcheck/build/update/editorial の revise すべてここを通る
  - refine 内 revise
- [cli/import.ts](../src/cli/import.ts): import 直後は `finalAuthorModel = "external"`。
- `editorial_review` 実行時に `reviewerModel` を記録（WS4）。
- **更新順の注意（記録の消失防止）**: create は [createQiitaArticle.ts:695](../src/workflows/createQiitaArticle.ts#L695) の汎用 step 保存、revise は [同:115](../src/workflows/createQiitaArticle.ts#L115) で保存し、**直後に `markDone` が meta を再読込して書く**。finalAuthorModel を `markDone` の**前**に書くと上書きで消える → **`markDone` 後**に `markFinalAuthored(runId, {provider, model})` ヘルパを呼ぶ、または `markDone` に meta patch を渡す形にする。

**テスト**（`tests/workflows/createQiitaArticle.test.ts` / `tests/cli/import.test.ts`）: create/revise 後に `finalAuthorModel` が実応答モデルになる（`markDone` で消えない）／import 後は `"external"`。

### WS3: `editorial_review` の config
- [config/models.yaml](../config/models.yaml): `editorial_review` タスクを追加（§8-1 確定）。**`primary = Anthropic Opus` / `fallback = OpenAI GPT-5.4` / `temperature: 0.2`**。candidate set が両 provider をまたぐので、`rewrite` が OpenAI/Anthropic どちらに転んでも runtime filter 後に別 provider が残る。`prices` に reviewer モデル単価を追加。
- `config/criteria/editorial.md`（新規）: 軸・辛口度・断定ガード（spec §5.3）。
- [workflows/profile.ts:14-19](../src/workflows/profile.ts#L14-L19): profile schema に **`editorial_criteria_file`** を追加（`criteria_file` と別系統）。各 `config/profiles/*.yaml` に既定 `config/criteria/editorial.md`。
- **criteria 合成順（spec §5.3）**: 固定 rubric（`editorial_criteria_file`、上書き不可）＋ 追加コンテキスト（`brushup-criteria.md` 等があれば末尾連結）。`evaluate` の `resolveEvaluationCriteria`（[index.ts](../src/index.ts)）とは**別ロジック**にする（brushup に固定 rubric を上書きさせない）。

**テスト**（`tests/workflows/profile.test.ts`）: `editorial_criteria_file` の解決。合成（固定＋追加）順のユニット。

### WS4: 編集レビュー・コア（独立モード）
**新規**: `src/workflows/editorialReview.ts`（または cli 配下）。
0. **finalAuthorModel の解決とガード**（spec §5.1）:
   - `meta.imported` または `finalAuthorModel="external"` → 独立性チェック**免除**。
   - 生成 run で `finalAuthorModel` が**未記録（WS2 以前に作られた既存 run）** → **失敗**し、『一度 `article:revise`/`resume` で final.md を再生成して finalAuthorModel を記録してから editorial review を回す』と促す（独立性不明のまま通さない）。
1. criteria を合成（WS3）。下記 override に応じた除外を付けて `router.run({ task:"editorial_review", schemaName:"EditorialReview", excludeProviders, excludeCandidates })`。`reviewerModel` を記録。
2. **独立性 filter/override/recheck**（WS1 の2機構を使う）:
   - 既定: `excludeProviders=[finalAuthorModel.provider]`。残候補が空なら失敗。
   - `--allow-same-provider`: `excludeProviders` を外し、`excludeCandidates=[finalAuthorModel]`（完全同一 model だけ落として次候補へ進む）。
   - `--allow-same-model`: 除外なし。
   - **実応答後 recheck**: 応答 provider/model が override レベルの許可範囲かを検証。
3. raw（`EditorialReview`）→ **normalize**: 新規 weakness に id 採番 **`WNNN-<hash8>`**（連番 `WNNN` が主キー・**run 内台帳で単調増加**、`hash8` は `severity|location|problem|recommendation` 正規化の内容照合用。§8-3）、**`status:"open"` 起票**。`editorial-review.json`（normalized・共通形式）/`editorial-review.md`（講評・preference 別掲）を保存。
4. **専用 formatter**（`buildRevisionInstruction` は流用しない）: `severity∈{major,minor}` かつ `status∈{open,partial}` を `editorial-instruction.candidates.md` に整形（preference・resolved 除外、spec §5.4）。**確定版 `editorial-instruction.md` はここでは作らない**（③編集長の責務）。

**テスト**（`tests/workflows/editorialReview.test.ts`）: 独立性 filter（finalAuthor=openai→reviewer=anthropic）／`--allow-same-provider` で同 provider 別 model に進み完全同一 model は落ちる／`--allow-same-model` で同一可／**imported は免除・生成 run で finalAuthorModel 欠落なら失敗**／normalize で id＋status:open／候補 formatter が major|minor＋open のみ・preference 除外。

### WS5: CLI `article:review-editorial`
- [index.ts](../src/index.ts): `article:review-editorial --run <id> --mode independent [--allow-same-provider|--allow-same-model]`。出力は `editorial-review.{json,md}` ＋ `editorial-instruction.candidates.md`。

**テスト**（`tests/cli/bin.e2e.test.ts`）: `--help` に `--mode`/`--allow-same-*`。run 不在で適切に失敗。

### WS6: 運用接続（Claude Code 側、spec §12）
- `templates/.claude/agents/article-editor-in-chief.md`＋repo: ③トリアージ責務（`editorial-instruction.candidates.md`＋`editorial-review.md` を読み、採用分を **`editorial-instruction.md` に確定**、preference・衝突・大改変は筆者へ、事実系は factcheck へ、**確定版だけ** revise に渡す）。
- `templates/.claude/commands/review-editorial.md`（新規）＋repo。
- `templates/.claude/settings.json`: `Bash(llm-task-router article:review-editorial:*)` を追加（**§8-2 確定: 標準運用を既定**。厳格運用は §12.3 の代替として残すのみ）。
- `CLAUDE.md`（root＋templates）: 原則1行（採否＝編集長、preference と最終＝筆者、事実は factcheck 優先）。

---

## 3. 第2段（継続レビュー）

### WS7: 継続レビュー
- [schemas/](../src/schemas/): `EditorialReviewContinuation`（`trackedWeaknesses[]{id,status,evidence}` ＋ `newWeaknesses[]`（id なし））＋ `SchemaName` 追加。
- **ラウンド成果物**: 各レビュー時に `editorial-r<N>-before.md`（本文スナップショット）を固定、`RunMeta` に前回 `final.md` hash を記録。`editorial-r<N>-review.{json,md}`。
- **最新 alias の更新（stale 防止）**: 継続モードでも、ラウンド成果物 `editorial-r<N>-*` に加えて**最新 alias `editorial-review.{json,md}` と `editorial-instruction.candidates.md` を現ラウンドで上書き**する（refine が最終ラウンドを `final-review.{json,md}` に複製するのと同方針）。WS6 の編集長は最新 alias と候補を読むので、**stale な独立レビューをトリアージする事故を防ぐ**。
- **since-last 差分**: `generateUpdateDiff(editorial-r<N-1>-before.md, 現 final.md)` を流用（累積 `update-diff` は使わない、spec §5.5）。
- **解決追跡**: 前回未解決を id 付きで入力に渡し、`trackedWeaknesses` の `status` で台帳更新。**モデルが返し忘れても open のまま残す**。新規は `WNNN-<hash8>` 採番＋`status:"open"`。**同じ指摘の再出現は hash 内容照合で既存 `WNNN` に紐づけ**、新 ID を無闇に増やさない（§8-3）。
- CLI: `--mode continuation`（前回レビュー＋since-last 差分を入力に組む）。

**テスト**: since-last 差分が前回 before 起点／tracked の status 反映／返し忘れた id が open 維持／**最新 alias と候補が現ラウンドで上書き**／continuation 候補が open|partial のみ。

---

## 4. 第3段（安定化・評価）

### WS8（将来）
- [router/types.ts](../src/router/types.ts) `TaskConfig` と provider request に **seed・サンプル数**を追加（複数サンプル中央値）。**非対応モデルには送らない**（既存 Model Notes 方針）。
- ハイブリッド運用（継続＋定期独立フル読み）。
- 手動 vs 自動レビューの一致率（総合スコア差・major 一致率・自動適用後に factcheck が捕える誤り件数）を測る評価ハーネス。

---

## 5. 受け入れ条件（Done の定義）

- [ ] `editorial_review` が `ModelTask`/`modelTaskSchema`/models.yaml に入り、config validation を通る（WS1/WS3）。
- [ ] `ModelRequest.excludeProviders`/`excludeCandidates` で候補が provider／完全同一 model 除外され、全除外時に失敗する（WS1）。
- [ ] `finalAuthorModel` が final.md 更新経路で更新され（`markDone` で消えない）、import は `"external"`（WS2）。
- [ ] 既存 run（`finalAuthorModel` 欠落・非 imported）で editorial review が失敗し、revise/resume を促す（WS4）。
- [ ] 独立性: 既定で finalAuthor と同 provider を除外して reviewer を選ぶ。`--allow-same-provider` は `excludeCandidates` で完全同一 model だけ落として次候補へ。override 3段＋実応答 recheck（WS4）。
- [ ] normalize で新規 weakness に id＋`status:"open"`、候補は `major|minor`＋`open|partial`、preference/resolved 除外（WS4）。
- [ ] `editorial-instruction.candidates.md`（②）と `editorial-instruction.md`（③編集長確定）が分離され、revise は確定版のみ読む（WS4/WS6）。
- [ ] 継続モードが since-last 差分＋前回未解決（id）で再レビューし、status 台帳を更新し、**最新 alias/候補を現ラウンドで上書き**する（WS7）。
- [ ] `npm test` / `npm run typecheck` 緑。
- [ ] editor-in-chief/command/allowlist/CLAUDE.md が templates＋repo で更新（WS6）。

---

## 6. テスト計画

| 追加/更新 | 観点 |
|---|---|
| `tests/router/ModelRouter.test.ts` | excludeProviders で候補 filter／全除外で失敗 |
| `tests/router/config`（既存 enum テストがあれば） | `editorial_review` task が validation を通る |
| `tests/schemas/`（新） | EditorialReview(Continuation) の round-trip／不正で reject |
| `tests/workflows/editorialReview.test.ts`（新） | 独立性 filter・override・normalize(id/status)・候補 formatter |
| `tests/workflows/createQiitaArticle.test.ts` / `import.test.ts` | finalAuthorModel 記録／import=external |
| `tests/workflows/profile.test.ts` | editorial_criteria_file 解決・合成順 |
| `tests/cli/bin.e2e.test.ts` | review-editorial の help／mode・override フラグ |

---

## 7. リスクと留意点

- **独立性は静的設定だけで保証されない**（spec §5.1）: finalAuthorModel は実行時に変わるので、必ず**実行時 filter ＋ 実応答 recheck**。candidate set は両 provider をまたぐ。
- **編集レビューは正確性ゲートではない**（spec §10）: 事実系は factcheck/build へ。自動適用は ③編集長確定＋④revise のみ（候補を直接 revise に渡さない）。
- **criteria 合成の取り違え**: 固定 rubric が `brushup-criteria.md` に上書きされないよう、`evaluate` とは別ロジックにする（spec §5.3）。
- **`buildRevisionInstruction` 流用禁止**: severity 体系が違う（critical/... vs major/minor/preference）。専用 formatter（spec §5.4）。
- **二重管理**: agent/command/CLAUDE.md/settings は templates と repo 両方。

---

## 8. 決定事項（採用方針・着手はこれに従う）

1. **`editorial_review` の既定モデル**: `primary = Anthropic Opus` / `fallback = OpenAI GPT-5.4`、`temperature = 0.2`。通常 `rewrite=OpenAI` なので編集レビューは Claude が担当。`rewrite` が Anthropic fallback した場合は runtime filter で Anthropic を落として OpenAI に回る。**2 provider しかない現状では「同 provider 回避を優先し、別 provider が無ければ失敗」**が正（override で緩和可）。
2. **allowlist 運用**: **標準運用を既定**。`Bash(llm-task-router article:review-editorial:*)` を templates/repo に追加（編集レビューは読み＋LLM 生成の安全工程で、独立性ガードは CLI 側で既定 fail するため）。厳格運用は §12.3（spec）の代替として残すだけ。
3. **id 採番方式**: **`WNNN-<hash8>`**（例 `W003-a1b2c3d4`）。**連番 `WNNN` が ID の主キー**で、**run 内台帳で単調増加**（ラウンド内ではない）。`hash8` は正規化した `severity|location|problem|recommendation` の内容照合用。**モデル出力の小揺れで hash が変わっても、既存 tracked ID（WNNN）は保持**する（同じ指摘の再出現を内容照合で既存 ID に紐づける）。
4. **schema 分割**: **2スキーマで確定**。`EditorialReview` = 独立 raw、`EditorialReviewContinuation` = 継続 raw。**normalized 保存形式は共通の `editorial-review.json`**。1スキーマ mode 分岐は条件分岐と検証が増えるだけなので採らない。
