# 実装計画：sources.json に到達性／差し替えメタを持たせる

課題: factcheck の過程で **到達不能になった URL（404/403/到達不能）が `sources.json` に `primary`/`secondary` のまま残り**、台帳だけ見ると「一次情報なのに辿れない」混在になる。実害は限定的（参考章には出ていない＝後述）だが、**台帳が自己説明的でなく、差し替えの経緯が summary 散文に埋もれる**ため監査しづらい。前提ブランチ: PR #27（監査ログ可視化）反映後の新ブランチ。

実データ確認（`llm-router-e2e/runs/2026-06-21-pure-audio-decline`）: `sources.json` 15件のうち S001 Sony history / S002 Fraunhofer / S008 Analog Devices が到達不能（403/404/到達不能）。factchecker は cited source を到達確認済みの Wikipedia（S012–S015）へ差し替え、参考章は到達確認済み 12 URL のみで構成した。**差し替えは正しく行われたが、死リンクが primary のまま残り、置換関係は各 source の `summary` 文末（「旧URL…のため Wikipedia に差し替え」）でしか追えない。**

---

## 現状アーキテクチャ（確認済み）

- **sources の役割は「cited（参考章に出す）」が claims から導出**される。`selectReferenceSources`（[src/cli/references.ts](../src/cli/references.ts)）が `lifecycle:"present" && status:"verified"` の claim が参照する source だけを参考章に出す。→ **死リンクが cited でなければ参考章には出ない**（pure-audio はこれで実害ゼロ）。
- **sources.json は factchecker が見た全 source の台帳**。raw（`key`/url/…）→ `claims-normalize` が urlHash で安定 `SNNN` を採番（[src/cli/claimsNormalize.ts](../src/cli/claimsNormalize.ts) `mergeSource`）。差し替えで使わなくなった死リンクも、raw に残っていれば sources.json に残る。
- **verify-artifacts**（[src/cli/verifyArtifacts.ts](../src/cli/verifyArtifacts.ts)、外部通信なし）は「参考ブロック内リンク ⊆ sources.json の URL」を必須、ブロック外の未登録リンクは warning。**到達性は一切見ない**（HTTP 通信しない設計）。

→ つまり問題は **正確性でも参考章でもなく、台帳の可読性／監査追跡性**。設計はそこに絞る。

---

## 設計の確定方針（codex 制約「参考章に出す／factcheck で見たが引用しない を分ける」への回答）

**「cited（出す）」は claims から導出のまま正本にし、source 固有の属性として「到達性」と「差し替え関係」を足す。** cited を別途手入力フラグにすると claims と二重管理になり drift するため持たせない。代わりに：

1. **`reachable`（到達性・intrinsic）**: `"ok" | "dead" | "unknown"`。最後に到達確認した結果。**省略可（default を付けない）**。これで「**旧 run＝未記録（省略）**」と「**確認したが不明＝`"unknown"`**」を区別できる（codex D）。factchecker または将来の CLI が記録。
2. **`replacedBy`（差し替え・relational）**: 後継 source の `SNNN`。死リンクを実質置換した live な source を指す。raw では `replacedByKey`（後継の raw key）で書き、normalize が `SNNN` に解決する。**自己参照（`S001→S001`）は error**（最低限。循環 `S001→S002→S001` も弾ければなお良いが初手は自己参照のみで十分／codex C）。
3. **`cited`（導出・materialized）**: `boolean`。**normalize 時に present+verified claim の参照集合から毎回再計算して sources.json に焼き込む**（手編集しない＝drift しない）。これで「台帳単体で cited/notCited が読める」という codex の要望（`notCited`）を、claims を正本にしたまま満たす。**ただし `cited` は正本ではない**ので、verify-artifacts が **claims.json から再導出した cited 集合と `sources.json[].cited` の一致を検査**する（手編集でズレたら気づける／codex A）。normalize は常に boolean を出す。

`reachable`/`replacedBy` は optional。**既存 run（メタ無し）はそのまま valid・新エラーを出さない**（死リンク系の assert は `reachable:"dead"` が明示記録されたときだけ発火）。retroactive に旧 run を fail させない。

到達性チェック（HTTP 通信）の担い手:
- **フェーズ1**: factchecker が死リンクに気づいた時点で raw に `reachable:"dead"` ＋ `replacedByKey` を記録する（factchecker は既に WebFetch する）。verify-artifacts は **記録済みフラグを読むだけ**（通信しない設計を維持）。
- **フェーズ2（別 PR・任意）**: `article:sources-check` CLI（URL を HEAD/GET して `reachable`/`checkedAt` を自動 stamp）。**外部通信は verify-artifacts ではなく専用 CLI に閉じる**。本計画のスコープ外。

---

## スキーマ変更（後方互換・全 optional）

[src/schemas/ClaimsSchema.ts](../src/schemas/ClaimsSchema.ts):

```ts
const REACHABILITY = ["ok", "dead", "unknown"] as const;

// RawSource（factchecker 出力）に追加（default を付けない＝未記録は省略のまま）
reachable: z.enum(REACHABILITY).optional(),
replacedByKey: z.string().optional(),   // 後継 source の raw key（normalize で SNNN へ解決）

// Source（normalize 後の公開ビュー）/ LedgerSource に追加
reachable: z.enum(REACHABILITY).optional(),       // 省略=旧run/未記録、"unknown"=確認したが不明（D）
replacedBy: z.string().regex(SOURCE_ID_RE).optional(),
cited: z.boolean().default(false),      // normalize が毎回再計算して焼き込む（手編集禁止・常に boolean を出す）
```

> `reachable` に `.default(...)` を付けないのは codex D の指摘どおり。default を付けると既存 `sources.json` を parse しただけで値が混ざり「旧 run」と「明示 unknown」が潰れる。`cited` だけは normalize が必ず書くので `.default(false)` で常時 boolean。

---

## タスク分解

### T1. スキーマ＋normalize の配線
- **変更**: `ClaimsSchema.ts` に上記フィールド（Raw/Source/Ledger）。
- **変更**: `claimsNormalize.ts`
  - `mergeSource`: `reachable` を raw→ledger へ伝播（**記録があるときだけ**保存。再出現は最新で上書き。未記録は省略のまま＝D）。
  - `replacedByKey` → `replacedBy(SNNN)` 解決（`keyToUrlHash`→ledger 検索を流用、URL 直書きも許容、未解決は throw＝typo を握り潰さない）。**resolve は全 source の id 確定後の2パス必須**（代替 source が raw 配列上で後ろに出るケースを許すため／codex C）。**自己参照（`replacedBy === 自分の id`）は error**。循環検出は best-effort（初手は自己参照のみ必須）。
  - `cited` 再計算: present+verified claim の `sourceIds` 集合を作り、各 source へ `cited` を焼き込む（`selectReferenceSources` の cited 判定を共有関数に切り出して再利用＝references と一本化）。
  - `toPublicSource` に新フィールドを反映（`reachable`/`replacedBy` は値があるときだけ、`cited` は常時）。
- **完了条件**: メタ無し raw も従来どおり normalize できる。`reachable`/`replacedBy`/`cited` が sources.json に出る。`replacedByKey` 未解決・自己参照は明確なエラー。

### T2. references 生成の防御（codex B：references は「防御的に焼かない」役割）
- **変更**: `references.ts`
  - `selectReferenceSources` から cited 判定ロジックを共有関数化（T1 と一本化）。
  - **`reachable:"dead"` の source は参考章に出さない**（万一 cited でも防御的に除外し、warn 情報を返す）。死リンクを参考章ブロックに焼かない。
  - **warn の返し方（codex 追加・確定）**: `prepareReferencesBlock` の戻りを `{ block, count }` → **`{ block, count, warnings: string[] }`** に拡張。`article:references` CLI は `warnings` を **stderr** に出す（本処理は継続）。テストからも warnings を検査できる形にする。
  - 役割の切り分け（codex B）: references は**整合性ゲートではなく防御**。「claim が dead を引用している」という台帳不整合の検出は T3（verify-artifacts）が担う。両者は衝突せず補完。
- **完了条件**: 死リンクは参考章ブロックに絶対入らない。

### T3. verify-artifacts の読み取り専用 assert（通信しない／codex B：整合性ゲート役割）
- **変更**: `verifyArtifacts.ts`（既存のリンク検査に追加）
  - **error**: `cited:true` かつ `reachable:"dead"`（＝claim が死リンクを引用している台帳不整合。factchecker は代替へ張り替えるべき）。
  - **error**: 参考ブロック内に出ている URL の source が `reachable:"dead"`（block⊆sources は既存、到達性を追加）。
  - **error**: `replacedBy` が存在しない source id を指す（dangling）／自己参照。
  - **error（codex A）**: `claims.json` から再導出した cited 集合と `sources.json[].cited` が不一致（焼き込み値の手編集 drift を検出。`cited` を正本扱いしない担保）。
  - **warn は初期なし（codex B/E）**: `reachable:"unknown"` の cited 警告はフェーズ1では unknown が常態でノイズになるため出さない。`sources-check`（フェーズ2）導入後に warn/error を再検討。
- **完了条件**: `reachable:"dead"` を明示した死リンクが cited/参考章にあると FAIL。cited 焼き込みが claims と不一致なら FAIL。メタ無し既存 run は従来どおり PASS（新エラー無し）。

### T4. factchecker への指示＋docs
- **変更**: [templates/.claude/agents/article-factchecker.md](../templates/.claude/agents/article-factchecker.md)
  - URL が到達不能なら raw source に `reachable:"dead"` を記録し、代替を立てた場合は死リンクに `replacedByKey:<代替のkey>` を付ける。**死リンクを cited のまま残さない（claim の sourceRef を代替へ張り替える）**。
- **変更**: [docs/qiita-article-howto.md](qiita-article-howto.md) の factcheck／公開前ゲート節に1〜2行。
- **変更**: [CLAUDE.md](../CLAUDE.md) 参考章の行に「到達不能 URL は `reachable:"dead"`＋`replacedBy` で台帳に残す（死リンクは参考章に出さない）」を最小追記。
- **完了条件**: 次回 run から死リンクが台帳上で自己説明的になる。

### T5. tests
- `claimsNormalize`: reachable 伝播（未記録は省略・明示 unknown は保持）/ `replacedByKey`→`replacedBy` 解決（key・URL・未解決エラー・**後方参照（代替が raw 後方）でも2パスで解決**・**自己参照エラー**）/ `cited` 再計算（present+verified のみ true）/ メタ無し raw の後方互換。
- `references`: `reachable:"dead"` は参考章から除外し、`warnings` に1件返す（`{ block, count, warnings }`）。
- `verifyArtifacts`: dead かつ cited→FAIL、参考ブロック内 URL が dead→FAIL、dangling/自己参照 `replacedBy`→FAIL、**`cited` 焼き込みが claims 再導出と不一致→FAIL**、メタ無し run→PASS（回帰防止）。
- **完了条件**: `npm test` 緑・typecheck クリーン。

---

## スコープ外（別 PR）
- **`article:sources-check`（HTTP 到達性の自動 stamp）**。外部通信を伴うためフェーズ2。verify-artifacts には入れない。
- 旧 run の sources.json への retroactive なメタ付与（移行スクリプト）。必要なら別途。
- インライン脚注・参考章の見出し揺れ対応（既存スコープ外のまま）。

---

## 受け入れ基準
1. sources.json に `reachable`（省略可）/ `replacedBy`（省略可）/ `cited`（常時 boolean）が出る。既存 run は `reachable`/`replacedBy` 無しでも valid。
2. `replacedByKey` が normalize で `SNNN` に2パス解決され、未解決・自己参照はエラー。
3. `cited` は present+verified claim から毎回再計算（手編集に依存しない）。verify-artifacts が claims 再導出との一致を検査。
4. 参考章に `reachable:"dead"` は出ない。verify-artifacts は「cited かつ dead」「参考ブロック内 URL が dead」「dangling/自己参照 replacedBy」「cited 焼き込みの claims 不一致」を FAIL、メタ無し既存 run は PASS。
5. factchecker が死リンクを `reachable:"dead"`＋`replacedBy` で記録する手順が docs/agent に入る。
6. `npm test` 緑・typecheck クリーン。

---

## 確定した論点（codex レビュー反映済み）
- **A. `cited` 焼き込み（採用）**: normalize で再計算して materialize。ただし正本扱いせず、verify-artifacts が claims 再導出との一致を検査（手編集 drift 検出）。
- **B. dead の役割分担（確定）**: references=防御的に焼かない／verify-artifacts=「cited かつ dead」「参考ブロック内 URL が dead」を error。両者は補完で衝突しない。
- **C. `replacedBy` 解決（確定）**: 全 id 確定後の2パス必須。自己参照は error（循環は best-effort）。
- **D. `reachable` は省略可（確定）**: `.default` を付けず、未記録（旧 run）と明示 `"unknown"` を区別。`cited` のみ常時 boolean。
- **E. unknown cited の warn（確定）**: フェーズ1 は warn しない（unknown が常態でノイズ）。`sources-check` 後に再検討。
- **F. PR 分割（確定）**: T1–T5 を1 PR（メタを「持てる・読める・守れる」まで）。`article:sources-check`（HTTP 自動チェック）は別 PR。
