# 実装計画：progress の現在地バグ修正（evaluate 永久 pending）＋ 開始・終了のローカルタイム表示

実運用ログ（`llm-router-e2e/runs/2026-06-21-declining-birthrate`）の検証で見つかった2点を直す。前提コミット: main `bdb4501`（v0.2.22）。コードは llm-task-router 本体。

---

## 課題A: refine フローで `evaluate` が永久 pending → 現在地が過小表示（バグ）

### 事象（実ログの根拠）
- `progress.json`: `evaluate`(index 3) が `status:"pending"`、`currentIndex:3`、`complete:false`。
- 実際には create/refine/direction/factcheck/build-verify/editorial/claims-normalize/verify-artifacts(OK) まで通過済み（export だけ未了）。
- それでも `article:status`／`completion-report` の見出しが **「現在地: 3 / 11 工程目」** と出る。

### 原因
- canonical 工程に `refine`(2) と `evaluate`(3) が**別工程として並存**している。
- 実運用の主経路は `article:refine`（評価→改稿ループ）で、これは `step:"refine"` を記録し、評価成果物 `final-review.md` まで生成する。**独立した `evaluate` イベントは出ない**（`article:evaluate` は別エントリで、refine 経路では走らない）。
- 結果、canonical `evaluate` は記録されず pending のまま → `currentIndex` が evaluate に張り付き、`complete` が永久に false。
- これは課題1 の核心「現在地：N工程中M番目」を**最も一般的な refine 経路で常に誤らせる**。データ（events）は正しく、派生表示だけが誤る。

### 対策（確定方針）: `evaluate` と `refine` を1つの canonical「評価/改稿」段に統合
評価と改稿は同じ「final-review」段で、`article:evaluate`（採点のみ）と `article:refine`（評価＋改稿ループ）は**同一段の代替エントリ**。別工程として2枠持つのが誤りなので1枠に統合する。

- **`src/progress/stepOrder.ts`**:
  - `QIITA_CANONICAL_STEPS` から **`evaluate` エントリを削除**し、`refine` の1枠に集約。ラベルは中立化（例: `{ key: "refine", label: "評価・改稿（refine / evaluate）" }`）。
  - `STEP_ALIASES` に **`evaluate` → `refine`** を追加（`article:evaluate` 単独実行も refine 枠を満たす）。
  - canonical 工程数は **10 → 9**（create, refine, direction, factcheck, build-verify, editorial, claims-normalize, verify-artifacts, export）。
- **`src/index.ts`**: `article:evaluate` の progress 記録 step 名は `evaluate` のまま（alias が refine 枠へ畳む）。配線変更は不要。
- **影響**: refine done で評価段が done になり、`currentIndex` は direction 以降の最初の未完（このログなら全部 done で export だけ pending → `currentIndex=export`）。export 実施で `complete:true`。

### 対策2（同根の修正）: 現在地の「分母」と `currentIndex` を canonical 基準にする
evaluate を畳んでも、現状 `aggregate` は [src/progress/aggregate.ts](../src/progress/aggregate.ts) で `total: steps.length`（＝canonical ＋ 非 canonical 追加工程）になっている。実ログは `revise`（非 canonical）が混ざり `total:11`。このままだと canonical を9にしても「9 / 10」のように分母が膨らむ。**今回の根は「N工程中M番目」**なので、ここも直す:

- **分母を canonical 工程数にする**: `ProgressSnapshot` に `canonicalTotal`（= `steps.filter(s=>s.canonical).length`）を追加し、`renderMarkdown` の現在地表示の分母は `canonicalTotal` を使う（非 canonical の追加工程で分母が動かない）。`total`（全行数）は表の行数として残してよいが、見出しの「N / M 工程目」の M は canonical。
- **`currentIndex` を canonical 未完優先にする**: 現在の `steps.find(pending|start|error)` を **`steps.find(s => s.canonical && (pending|start|error))`** に限定（`direction-draft` や `revise` 等の非 canonical 追加工程が現在地を乗っ取らないように）。canonical は配列先頭に並ぶため、canonical step の `index` はそのまま 1..canonicalTotal に収まる。
- `complete` は既に canonical 限定（`steps.filter(canonical).every(done|skip)`）なので変更不要。
- これで「create〜verify-artifacts done＋export 未了」の run は **`export / 9 工程目`** と正しく出る（非 canonical の revise/direction-draft があっても分母9・現在地は canonical 基準）。

### 代替案（不採用だが記録）
- (a) `evaluate` を残しつつ「refine が terminal なら evaluate を covered 扱い」: aggregate に2工程の特殊結合が入り密結合。
- (d) `evaluate` を optional 工程にして currentIndex/complete から除外: 表に pending 行が残り見栄えが悪い。
- → 概念的に同段なので**統合（採用案）が最もきれい**。

---

## 課題B: 開始・終了をローカルタイムで表示

### 事象
`progress.md` / `article:status` の表「開始・終了」と「更新」が **UTC**（`fmtTime` が `toISOString().slice(11,19)`、更新は ISO そのまま）。実運用者にとって読みにくい（実ログは JST 13:xx なのに 04:xx 表示）。

### 対策（確定方針）: 表示のみローカル化・正本とJSONはUTCのまま
- **正本は不変**: events の `at`、snapshot の `startedAt`/`finishedAt`/`updatedAt` は **ISO8601 UTC のまま**（機械可読・タイムゾーン安定）。`--json` 出力も UTC を維持（スクリプト互換）。
- **表示（renderMarkdown）だけローカル化**:
  - `src/progress/renderMarkdown.ts` の `fmtTime` を**ローカル時刻 HH:MM:SS**へ（`Date` のローカルゲッタ `getHours/getMinutes/getSeconds` をゼロ詰め。`toLocaleTimeString` のロケール揺れを避け決定的に）。
  - 「更新」行はローカル日時（`YYYY-MM-DD HH:MM:SS`）＋**タイムゾーンが分かる表記**（UTC と取り違えないよう、オフセット例 `+09:00` か `JST` を併記）。
  - 表ヘッダ近くに「時刻はローカルタイム」を1行注記（UTC と誤読させない）。
- **completion-report / status**: completion-report は時刻表示を持たない（進捗・コストのみ）ため変更なし。`article:status` は renderMarkdown 経由なので自動的にローカル化。

### テスト容易性（重要）
- ローカル時刻はランタイムの TZ 依存 → テストがマシン/CI 依存で flaky になりうる。
- 対策: **TZ は `vitest.config.ts` 側で固定**する（テスト先頭での `process.env.TZ` 設定は、Node の `Date` がプロセス起動時 TZ に依存する環境があり危うい）。既存 [vitest.config.ts](../vitest.config.ts) の `test` に **`env: { TZ: "Asia/Tokyo" }`** を追加。
- 純粋関数 `formatLocalTime(date)` / `formatLocalDateTime(date)` に切り出し、TZ 固定下で**既知 UTC 入力 → 期待ローカル値**を単体テスト。あわせて `HH:MM:SS` 形の正規表現アサートも併用。

---

## タスク分解

### T1. evaluate/refine 統合 ＋ 現在地の canonical 基準化（課題A・対策1+2）
- `stepOrder.ts`: `evaluate` エントリ削除＋ラベル中立化（`評価・改稿（refine / evaluate）`）＋ alias `evaluate→refine` 追加。
- `src/progress/types.ts`: `ProgressSnapshot` に `canonicalTotal: number` を追加。
- `src/progress/aggregate.ts`:
  - `currentRow` を **canonical 限定**（`steps.find(s => s.canonical && (pending|start|error))`）。
  - 返り値に `canonicalTotal`（canonical 行数）を追加。`total` は従来どおり全行数。
- `src/progress/renderMarkdown.ts`: 現在地の分母を `canonicalTotal` に。
- **`src/cli/completionReport.ts`（自動追従しないので明示的に直す）**: completion-report は snapshot から `progress: { ..., total }` を詰め、auto セクションで `${currentIndex} / ${total} 工程目` を直接描画している（[completionReport.ts](../src/cli/completionReport.ts) collect 部と renderAutoSection）。**`CompletionReportData.progress` に `canonicalTotal` を追加**し、`collectCompletionReportData` で `snapshot.canonicalTotal` を詰め、**auto セクションの分母を `canonicalTotal` に**する。
- 影響範囲: `article:status` は renderMarkdown 経由で追従。completion-report は上記の明示対応が必要。
- **完了条件**: refine 済みで評価段 done。実ログ相当（refine 後に factcheck〜verify-artifacts done・export 未了、revise 等の非 canonical あり）で `article:status` も completion-report も **`export / 9 工程目`** と表示。

### T2. ローカルタイム表示（課題B）
- `renderMarkdown.ts`: `fmtTime`→ローカル HH:MM:SS、更新行→ローカル日時＋TZ 表記、注記1行。純関数化。
- JSON/正本は不変（変更しないことをテストで担保）。
- **完了条件**: progress.md/status の開始・終了・更新がローカル表示。`--json` は UTC のまま。

### T3. tests ＋ ドキュメント
- **tests**:
  - `aggregate`/`stepOrder`: canonical が 9 工程・`evaluate` 単独イベントが refine 枠に畳まれる・refine done で評価段 done・refine 後に後続 done で `currentIndex` が正しく前進し全 done＋export 済みで `complete:true`。既存の「10工程」前提テスト（aggregate/renderMarkdown）を **9工程へ更新**（index/total/`direction` 位置）。
  - **「3 / 11」再発防止テスト（重要）**: `direction-draft` や `revise` のような**非 canonical 追加工程がある run でも、現在地の分母が canonical 数（9）で、`currentIndex` が非 canonical に乗っ取られない**こと（create〜verify-artifacts done＋export 未了で `export / 9` 相当、`canonicalTotal=9`）。
  - `renderMarkdown`: TZ 固定で既知 UTC→ローカル HH:MM:SS、更新行の TZ 表記（`+09:00`）、現在地の分母が `canonicalTotal`。`formatLocalTime`/`formatLocalDateTime` の単体。
  - snapshot/`--json` の時刻（`at`/`startedAt`/`finishedAt`/`updatedAt`）は **ISO8601 UTC のまま**（正本不変）。
  - `completionReport`: auto セクションの現在地分母が `canonicalTotal`（非 canonical 追加工程があっても膨らまない）。
  - 既存の direction/factcheck/completion 系テストが緑のまま。
- **ドキュメント**:
  - [docs/qiita-article-howto.md](qiita-article-howto.md) 4.5: 工程列を **9工程**（evaluate を refine に統合）へ更新、「時刻はローカル表示・JSON は UTC」を一文。
  - 必要なら [CLAUDE.md](../CLAUDE.md) は変更不要（粒度的に howto で足りる）。
- **完了条件**: `npm test` 緑、`npm run typecheck` クリーン。

---

## 依存関係と着手順

```
T1 (evaluate/refine 統合) ─┐
T2 (ローカルタイム表示) ───┼─ T3 (tests / docs)
```
- T1 と T2 は独立（別ファイル中心）。どちらからでも可。T3 で両方のテスト・doc を更新。

---

## スコープ外
- events / progress.json / `--json` のタイムゾーン変更（UTC 正本は維持）。
- **古い `progress.json` の後方互換（ユーザー判断で不要）**: `canonicalTotal` 欠落時の `readSnapshot` 強制 regenerate や表示側フォールバックは入れない。新規 run は `regenerate` で常に `canonicalTotal` を持つため、通常運用では欠落しない（events が JSON より新しければ読む直前に再生成される）。コード更新前に作られた既存 run の古い JSON だけが対象だが、互換対応はしない。
- 完成報告のゲート表の verify-artifacts 相互参照（別の軽微改善。本計画外）。
- direction-check の「テーマ」全文ダンプの切り詰め（軽微・別途）。
- factcheck の所要見積もり（優先度6の将来拡張）。

---

## 受け入れ基準
1. refine 済みの run で `evaluate` 起因の pending が消え、`currentIndex`/`complete` が実態に一致する（実ログ相当で「export だけ未了」と表示）。
2. canonical は 9 工程。`article:evaluate` 単独実行も評価段を満たす（alias）。
3. **現在地の分母は canonical 工程数（`canonicalTotal`）**で、`revise`/`direction-draft` 等の非 canonical 追加工程があっても膨らまない。`currentIndex` は canonical 未完を指す（非 canonical に乗っ取られない）。`article:status` と **completion-report の双方**で成立する。＝「3 / 11」が再発しない。
4. `progress.md` / `article:status` の開始・終了・更新が**ローカルタイム**表示で、UTC と取り違えない TZ 表記（`+09:00`）がある。
5. events / `progress.json` / `article:status --json` の時刻は **ISO8601 UTC のまま**（正本・スクリプト互換を壊さない）。
6. ローカルタイムのテストが `vitest.config.ts` の TZ 固定で決定的（CI で flaky にならない）。
7. `npm test` 緑・`typecheck` クリーン。既存機能（direction/factcheck/completion）にリグレッションなし。

---

## 確定した論点（レビュー反映済み）
- **統合後のラベル**: 「評価・改稿（refine / evaluate）」で確定（UI 中立・実装キーが分かる人にも通る）。
- **TZ 表記**: 更新行に **`+09:00` オフセット併記**で確定（`JST` 名称は DST/ロケールで面倒、オフセットが堅い）。
- **統合の方向**: canonical キーは **`refine` 寄せ＋`evaluate→refine` alias**で確定（主経路が `article:refine`）。
- **分母・currentIndex（レビュー追加）**: 現在地の分母は `canonicalTotal`、`currentIndex` は canonical 未完優先で確定（非 canonical 追加工程に影響されない＝「3/11」再発防止テストを T3 に追加）。
