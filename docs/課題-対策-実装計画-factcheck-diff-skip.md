# 実装計画：factcheck 差分スキップ（優先度4 / factcheck snapshot + scope）

対象: [docs/課題-対策案.md](課題-対策案.md) の優先度4 — **factcheck の二度手間を、snapshot ＋ 変更セクション ＋ claim 突き合わせで判定し、事実差分が無ければ再 factcheck をスキップ／差分があれば対象を絞る**（課題2「同じ factcheck の二度手間」、課題3「時間がかかりすぎる」を回収）。

この文書は実装計画のみ（コードは含まない）。優先度1〜3（progress / completion-report / direction-check）の上に積む。前提コミット: `feat/progress-logging`（`f0cfff4`）。

---

## 背景（再利用できる既存資産）

- **`generateUpdateDiff(base, final)`**（[src/cli/updateDiff.ts](../src/cli/updateDiff.ts)）: 2つの Markdown の **heading 単位 changed sections**（追加/削除行数つき）を返す純関数。全文ハッシュ単独より細かく、文体差・見出し移動も「どのセクションが動いたか」で局在化できる（対策案 §2 の「全文ハッシュだけは不可」に対応）。
- **`selectRecheckClaims(claims, changed)` / `selectDiscoverySections(changed)`**（[src/cli/claimsRecheck.ts](../src/cli/claimsRecheck.ts)）: 変更セクションに属する既存 claim を陳腐化順に選ぶ／追加行のあるセクション（新規 claim が生まれ得る）を出す。**更新リライト用に実績のある関数をそのまま流用**できる。
- factcheck は CLI を持たない（factchecker サブエージェント＋編集長が `progress:event` で記録）。本計画が足すのは **「再 factcheck が要るか・どこを見るか」を決める判定 CLI** と **baseline スナップショット管理**であって、factcheck 自体の自動化ではない。

---

## 設計の確定事項（実装中に揺らさない）

- **baseline の正本は `runs/<id>/factcheck.snapshot.md`** ＝「最後に factcheck 済みとして**受理した** final.md」。再 factcheck の要否は **snapshot と現 final.md の差分**で判定する（全文ハッシュ単独は使わない）。
- **判定は2コマンドに分ける（責務分離）**:
  - **`article:factcheck-scope`（判定・read 中心）**: snapshot vs final を diff し、`full | skip | diff` を出す。`diff` のときは変更セクション・影響 claim・新規抽出セクションを `factcheck-scope.md`/`.json` に書き、factchecker が「そこだけ」を見られるようにする。
  - **`article:factcheck-stamp`（baseline 受理）**: 現 final.md を `factcheck.snapshot.md` にコピーして baseline を更新する。**実 factcheck 完了後**、または **diff を見て「非事実変更だから受理」と編集長が判断した後**に打つ（＝baseline は常に「現 final を factcheck 済みとみなす」点を表す）。
- **スコープ判定の段階**（対策案 §2-C の2段スコープを create フローにも展開）:
  - snapshot 不在 → **`full`**（初回 factcheck。全文）。**初回はスキップ判定しない**。
  - snapshot あり・差分ゼロ（added=removed=0） → **`skip`**（事実差分なし。再 factcheck 不要）。
  - snapshot あり・差分あり → **`diff`**（変更セクションに絞って再検証）。
- **claims.json 不在でも判定できる経路を必ず持つ**（対策案 §2 の ⚠。normalize 前の再 factcheck がある）:
  - 差分判定（snapshot vs final → changed sections）は**テキストのみ**で成立し、claims.json を要求しない。
  - claims.json が**あれば** `selectRecheckClaims` で影響 claim を列挙して enrich。**無ければ** 変更セクション ＋ discovery セクションだけを出す（factchecker は raw を見て新規/再検証を判断）。どちらでも `factcheck-scope.md` は生成できる。
  - **不在と破損は区別する**: claims.json が**無い**のは許容（`claimsAvailable=false`）。**存在するが JSON/schema 不正**は黙って「claims なし」に畳まず **error** にする（台帳破損の見落とし防止）。
  - **claims の解決は lineage fallback を持つ**: current run に claims.json が無ければ `meta.lineage.supersedesRunId`（更新前の版）の台帳へ fallback して enrich する（claims-recheck と同じ挙動。import/update run で enrich が黙って落ちないように）。前版から読んだ場合は scope に `claimsSourceRunId` を残し、出力にも参照元を明記する。
- **誤検出（見出し移動・文体だけ）への割り切り**: テキスト差分は非事実変更も拾う。**安全側＝「差分があれば skip しない（対象を出す）」**に倒す。ただし scope 出力で「変更セクションに present claim が無い／追加行が無い」セクションは**低リスク**として分けて示し、編集長が「非事実変更ゆえ受理（stamp）」を判断しやすくする。CLI は事実/非事実を**判定しない**（factchecker・編集長の役割）。
- **progress への記録は編集長が行う（CLI は read 中心）**: `skip` 判定でも `article:factcheck-scope` は progress を自動で書かない。編集長が結果を見て `article:progress:event --step factcheck --status skip --note "no factual diff (snapshot 一致)"` あるいは `done` を打つ（優先度1の運用に合わせる。silent skip 禁止）。
- **canonical 工程は増やさない**。factcheck は既存の canonical 工程。snapshot/scope はその内部補助であって新工程ではない。
- **更新リライトの `claims-recheck` とは別物・並行物**: あちらは `update-base.md`（公開版の起点）→ final の差分。こちらは `factcheck.snapshot.md`（前回 factcheck baseline）→ final の差分。**ロジック（generateUpdateDiff / selectRecheckClaims / selectDiscoverySections）は共有**するが、base ファイルと出力ファイル名を分ける。

---

## タスク分解

### T1. snapshot baseline の管理
- **追加**: `src/cli/factcheckScope.ts`（または `factcheckSnapshot.ts`）に baseline I/O。
  - `FACTCHECK_SNAPSHOT_FILE = "factcheck.snapshot.md"`。
  - `stampSnapshot(store, runId, acceptedAfter, note)`: 現 final.md を読み（無ければエラー）→ `factcheck.snapshot.md` に保存し、**受理メタ `factcheck.snapshot.meta.json`**（`acceptedAfter: "factcheck"|"non-factual-diff"` / `note` / `at`（ISO 時刻）/ `finalHash`（final.md の sha256）/ `runId`）を併せて書く。`acceptedAfter`・`note` は必須（誤 stamp の抑止と監査のため。後述 T4 のガードと連動）。
  - `readSnapshot(store, runId): string | null`: 無ければ null（初回判定に使う）。
- **完了条件**: stamp 後に snapshot が現 final.md と一致し、`factcheck.snapshot.meta.json` に受理理由・時刻・final hash が残る。final.md 不在は明確にエラー。

### T2. スコープ判定（純関数）
- **追加**: `src/cli/factcheckScope.ts` に判定ロジック。
  - `decideFactcheckScope(snapshot: string | null, final: string, claims: Claim[] | null): FactcheckScope`
    - `snapshot === null` → `{ mode: "full" }`。
    - 差分計算は `generateUpdateDiff(snapshot, final)` を再利用。`added === 0 && removed === 0` → `{ mode: "skip" }`。
    - それ以外 → `{ mode: "diff", changedSections, recheckClaims, discoverySections, lowRiskSections, claimsAvailable }`。
      - `recheckClaims` = claims があれば `selectRecheckClaims(claims, changed)`、無ければ `[]`。
      - `discoverySections` = `selectDiscoverySections(changed)`（追加行のあるセクション。**`claimsRecheck.ts` で現状 non-export なので実装時に export 化する**）。
      - `lowRiskSections` = **`claimsAvailable === true` のときだけ**算出する。変更セクションのうち「present claim が紐づかず・追加行も無い（削除/文体のみ）」もの＝事実リスクが低い候補（編集長の受理判断補助）。**claims.json 不在時は `lowRiskSections = []`**（「claim が無い」のか「台帳が無いだけ」か区別できないため、全 changed section を通常の検証対象として残す。誤って低リスク扱いしない）。
  - `claimsAvailable: boolean` をスコープに含め、出力で「claims.json 不在のため claim 突き合わせ・低リスク判定は省略」と明示する。
- **完了条件**: claims 有無の両経路で落ちない。claims 不在時は `recheckClaims=[]`・`lowRiskSections=[]` で全 changed section が通常対象。差分ゼロで skip、差分ありで対象を返す。純関数として単体テスト可能。

### T3. スコープ出力（factchecker が読む artifact）
- **追加**: `renderFactcheckScope(scope, runId): string` → `factcheck-scope.md`。CLI 既定では markdown（`factcheck-scope.md`）と機械可読 JSON（`factcheck-scope.json`、scope オブジェクトそのもの）の**両方を保存**する（T4 既定モードと揃える）。
  - `full`: 「初回（または baseline 無し）。全文を factcheck」。
  - `skip`: 「snapshot と差分なし。再 factcheck 不要。前回結果を流用」。
  - `diff`: 変更セクション一覧、優先再検証 claim（price/api/version 優先＝claims-recheck と同じ並び）、新規抽出対象セクション、低リスクセクション（**claims.json があるときのみ**。無いときは「claims 不在＝低リスク判定省略・全 changed section が対象」と明示）。`claims-recheck.md` の文面を参考にしつつ **factcheck-scope 専用の見出し**にする（混同回避）。
  - **共通化**: `selectRecheckClaims`/`selectDiscoverySections`（**export 化**）/型 `RecheckCandidate` は `claimsRecheck.ts` から流用。markdown 整形に共通部があれば小さなヘルパに寄せる（コピペ回避。優先度2/3 と同方針）。ただし claims-recheck.md の本文は更新リライト前提の文言なので**全面共有はしない**（関数共有・本文別）。
- **完了条件**: 3 モードの markdown が生成でき、既定で `factcheck-scope.md` ＋ `factcheck-scope.json` が保存される。claims 不在時も `diff` 出力が出る。

### T4. CLI サブコマンド
- **追加**: [src/index.ts](../src/index.ts) に2つ登録。
  - `article:factcheck-scope --run <id> [--json] [--stdout]`（**read 中心・状態を変えない**）:
    1. `assertRunExists`。final.md を読む（無ければエラー）。
    2. snapshot 読み（null 可）。claims.json 読み（null 可）。
    3. `decideFactcheckScope` → 出力モードで分岐（下記）。
    4. **progress は書かない**（編集長が記録）。
    - **出力モードの固定**（曖昧さを残さない。3 つは排他）:
      - **既定（フラグ無し）**: `factcheck-scope.md` と `factcheck-scope.json` を runs/ に保存し、stdout に `scope: full|skip|diff (changed N sections / M claims)` の1行サマリ。
      - **`--stdout`**: ファイルを一切書かず、`factcheck-scope.md`（markdown）を stdout に出すだけ（dry run）。
      - **`--json`**: ファイルを一切書かず、scope を JSON で stdout に出すだけ（スクリプト用 dry run）。
      - `--stdout` と `--json` の同時指定はエラー（どちらの dry run か曖昧なため）。
  - `article:factcheck-stamp --run <id> --accepted-after <factcheck|non-factual-diff> --note <text>`（**baseline ＝信頼状態を変える。強いガード**）:
    1. `assertRunExists`。`--accepted-after` と `--note` は**必須**（factcheck 前の誤 stamp ＝未検証 final を「検証済み baseline」にする事故を抑止）。**`--note` は空文字（trim 後 0 長）を弾く**（監査メタの実効性担保）。
    2. `stampSnapshot(store, runId, acceptedAfter, note)`（final.md → factcheck.snapshot.md ＋ 受理メタ）。
    3. stdout に `factcheck baseline updated: runs/<id>/factcheck.snapshot.md (accepted-after=<...>)`。
- **allowlist**: `templates/.claude/settings.json` に **`article:factcheck-scope` のみ追加**（read のみ＝自動承認）。**`article:factcheck-stamp` は allowlist に入れない**（baseline＝信頼状態を変える操作なので export/record-publication と同様にプロンプト維持。必須フラグと二重のガード）。
- **完了条件**: 初回 `full` → 実 factcheck → `factcheck-stamp --accepted-after factcheck --note ...` → 無変更で `skip` → final 変更で `diff`、が CLI で再現できる。stamp は必須フラグ無しでは失敗し、allowlist に無いのでプロンプトが出る。

### T5. tests ＋ ドキュメント
- **tests（`vitest`）**:
  - `decideFactcheckScope`: snapshot 無し→full / 差分ゼロ→skip / 差分あり→diff（claims 有無の両方）。**claims 不在時は lowRiskSections=[]・全 changed section が通常対象**になること（「台帳が無いだけ」を低リスク扱いしない）。claims 有り時のみ低リスク（claim 無し・追加無し）が分離されること。見出し移動が diff になること（安全側）。
  - `stampSnapshot` / `readSnapshot`: stamp 後 snapshot=final ＋ 受理メタ（acceptedAfter/note/at/finalHash）が残る、未 stamp は null、final 不在でエラー。
  - `renderFactcheckScope`: 3 モードの出力、claims 不在時の注記。
  - CLI: `--stdout`/`--json` でファイルを書かない・両者同時指定はエラー。final 不在でエラー。`factcheck-scope` は progress を書かない（factcheck step が done/skip に勝手に進まない）。**`factcheck-stamp` は `--accepted-after`/`--note` 無しで失敗する**。
  - 共通化リグレッション: 既存 `claims-recheck` テストが緑のまま（`selectRecheckClaims`/`selectDiscoverySections` を export 化しても挙動不変）。
- **ドキュメント**:
  - [docs/qiita-article-howto.md](qiita-article-howto.md): 「6. ファクトチェック」に「再 factcheck の差分スキップ」小節を追加（初回＝full→stamp、以降＝scope で skip/diff 判定、判定後に編集長が progress:event を記録）。
  - [templates/.claude/agents/article-editor-in-chief.md](../templates/.claude/agents/article-editor-in-chief.md): 手順4（factcheck）に「2回目以降は `article:factcheck-scope` で要否を判定 → 必要分だけ factchecker に渡す → 完了（または非事実差分の受理）後に `article:factcheck-stamp --accepted-after <factcheck|non-factual-diff> --note ...`（プロンプトが出る＝意図確認）」を追記。コマンド早見に追加。stamp は **factcheck 前に打たない**（未検証 final を baseline にしない）旨を強調。
  - [CLAUDE.md](../CLAUDE.md) / [templates/CLAUDE.md](../templates/CLAUDE.md): 「再 factcheck は snapshot 差分で要否判定（二度手間回避）」を1行。
- **完了条件**: `npm test` 緑。`init` 後フォルダで `factcheck-scope` はプロンプトなしで動き、`factcheck-stamp` はプロンプトが出る（allowlist 除外＋必須フラグのガード）。

---

## 依存関係と着手順

```
T1 (snapshot I/O) ─┐
T2 (scope 判定) ───┼─ T3 (scope 出力) ─ T4 (CLI×2) ─ T5 (tests/docs)
```

- T2 は `generateUpdateDiff`/`selectRecheckClaims`/`selectDiscoverySections` の再利用が中心。新規ロジックは「skip 判定」と「低リスクセクション分離」のみ。
- 最小縦切り: **T1 → T2 → T4（factcheck-stamp と factcheck-scope の full/skip）**。diff の claim enrich（T2/T3 の claims 突き合わせ）はその後でも価値が出る。

---

## スコープ外（この計画に含めない）

- factcheck 自体の自動化（factchecker はサブエージェントのまま。CLI は要否判定と baseline 管理だけ）。
- 所要時間見積もり（優先度6）。
- 更新リライトの `claims-recheck`（既存・別フロー。ロジックは共有するが本計画では変えない）。
- scope による progress 自動記録（編集長が `progress:event` で記録。CLI は read 中心）。

---

## 受け入れ基準（優先度4 全体）

1. `article:factcheck-stamp --run <id> --accepted-after <factcheck|non-factual-diff> --note <text>` が `factcheck.snapshot.md` ＋ 受理メタ（acceptedAfter/note/at/finalHash）を作成/更新する。必須フラグ無しでは失敗する。
2. `article:factcheck-scope --run <id>` が snapshot 不在→`full` / 差分ゼロ→`skip` / 差分あり→`diff` を出す。
3. `diff` のとき変更セクション・影響 claim（claims.json があれば）・新規抽出セクション・低リスクセクション（claims があるときのみ）を、既定で `factcheck-scope.md` ＋ `factcheck-scope.json` に書く。
4. **claims.json 不在でも** `diff` 判定が成立する（変更セクション＋discovery のみ、claim 突き合わせ・低リスク判定は省略と明示、全 changed section が通常対象）。不在は許容・**破損（JSON/schema 不正）は error**。current に無ければ `meta.lineage.supersedesRunId` の台帳へ fallback し参照元を明記。
5. 全文ハッシュ単独に依存しない（heading 単位 changed sections で局在化）。
6. `factcheck-scope` は progress を書かない（要否判定は編集長が `progress:event` で記録）。`factcheck-stamp` は baseline 更新のみ・allowlist に入れずプロンプト維持。
7. ロジックは `generateUpdateDiff`/`selectRecheckClaims`/`selectDiscoverySections`（export 化）を再利用（コピペ実装なし）。
8. 出力モードが固定: 既定＝ファイル保存＋1行サマリ / `--stdout`＝markdown を stdout・無保存 / `--json`＝JSON を stdout・無保存 / `--stdout --json` 同時はエラー。final.md 不在は明確なエラー。
9. `npm test` 緑。`factcheck-scope` はプロンプトなし、`factcheck-stamp` はプロンプトが出る（必須フラグ＋allowlist 除外の二重ガード）。

---

## 確定した論点（レビュー反映済み）

- **2コマンド分離で確定**。`stamp` は baseline＝信頼状態を変えるので `scope` より強いガードを付ける（下記）。
- **stamp の安全ガード（High 対応）**: `--accepted-after <factcheck|non-factual-diff>` と `--note` を**必須**化し、`factcheck.snapshot.meta.json`（受理理由・時刻・final hash）を残す。さらに **allowlist に入れずプロンプト維持**（export/record-publication と同格）。factcheck 前の誤 stamp で未検証 final を baseline 化する事故を二重に防ぐ。
- **skip は差分ゼロのみで確定**。low-risk でも skip 推奨まで踏み込まない（安全側）。
- **low-risk は claims があるときのみ（Medium 対応）**: claims.json 不在時は `lowRiskSections=[]`・全 changed section を通常対象に残す（「claim が無い」と「台帳が無いだけ」を混同しない）。
- **出力モード固定（Low 対応）**: 既定＝保存＋1行サマリ / `--stdout`＝markdown を stdout・無保存 / `--json`＝JSON を stdout・無保存 / 同時指定はエラー。
- **stamp タイミングは運用**（強制せず）。stamp 側の受理理由必須化で監査性を担保。stamp し忘れは次回 diff が出るだけ＝安全側。
- **共通化は関数共有・本文別で確定**。`selectDiscoverySections` は実装時に export 化する。
