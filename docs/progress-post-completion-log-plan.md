# 仕様・実装計画: progress.md に「完成後の変更ログ」節を追加

- 起票日: 2026-06-22
- 対象リポジトリ: llm-task-router
- 関連: [src/progress/aggregate.ts](../src/progress/aggregate.ts) / [src/progress/renderMarkdown.ts](../src/progress/renderMarkdown.ts) / [src/progress/types.ts](../src/progress/types.ts) / [src/progress/stepOrder.ts](../src/progress/stepOrder.ts)
- 採用案: **A（progress.md に自動生成の追記節）**。B（progress2.md 別ファイル）と C（events.jsonl 直読み運用）は不採用（§7）。

## 1. 課題

完成（全 canonical 工程が done/skip）後に編集（revise / 再 factcheck / 再 export 等）を行うと、その経過が `progress.md` から追いにくい。

根因は、progress.md が events.jsonl を**工程単位で畳んで再生成**するビューであること（[aggregate.ts](../src/progress/aggregate.ts)）。完成後にやり直した工程は既存行に統合され、

- 時刻が `開始=最小 / 終了=最大` に潰れて間の経過が消える（例: factcheck 行が `13:09:53 → 14:33:48`）、
- 補足（note/output）が**代表イベント＝最新で上書き**され、完成時点の記述が失われる、
- コスト/トークンは積算されるため「完成時いくら／追加でいくら」の内訳が見えない。

情報自体は events.jsonl（追記専用の正本）に時系列で残っている。**ビューが完成後の差分を見せていない**だけ。

## 2. 方針（採用案 A）

events.jsonl から **「完成到達時刻より後のイベント」だけを時系列で抜き出した節**を、既存の進捗表の下に**自動生成**で追加する。

- 正本は引き続き events.jsonl。新節はそこから決定的に再生成する（手書きしない）。
- 実際の `at` 時刻だけを使い、**時刻推定アンカーを持ち込まない**（[[progress-extra-actions-branch-numbering-deferred]] の「枝番は時刻推定が誤帰属するため保留」という既存判断と整合）。
- 既存の集約表・「追加アクション」節の挙動は**変えない**（後方互換）。新節は完成後イベントがあるときだけ出す。

## 3. 「完成」境界の定義（重要）

**完成到達時刻 `completedAt` = 全 canonical 工程が最初に done/skip を満たした瞬間のイベントの `at`。**

- 判定は events を `at` 昇順で**リプレイ**して求める（aggregate の最終 `complete` 判定と同じ「canonical が全部 done/skip」を、時間軸で最初に満たした点として特定する）。
- ステータスの畳み込みは aggregate と同じ優先度（done > error > skip > start）。キーの状態は優先度で単調増加し、いったん done になれば下がらない。
- **build-verify の既定オフ**を境界判定でも踏襲する: `codeCheck === false` かつ build-verify の実イベントが1件も無い run は、build-verify を**最初から skip（terminal）**として扱う（[aggregate.ts:120-130](../src/progress/aggregate.ts) の表示ロジックと一致）。**build-verify の実イベントが1件でもあれば synthetic skip は使わず、その実イベントの status に従って通常どおりリプレイする**（terminal になるのは done/skip 到達時のみ。`start`/`error` だけでは terminal にしない）。これは build-verify に限らず全 canonical 共通のリプレイ規則（§3 冒頭の「全 canonical が done/skip を満たした最初の点」）であり、`build-verify:start` だけで完成扱いしない。
- 全 canonical が done/skip を初めて満たしたイベントを**完成イベント**とし、その `at` を `completedAt` とする。
- **完成後イベント = 時系列で完成イベントより後ろのイベント**（同 `at` の同時イベントは順序インデックスで後ろにあるものを後続とする。`at` の単純比較だけに依存しない）。
- run が一度も完成に達していなければ `completedAt = undefined` → 新節は出さない。
- **最終状態が未完へ戻った run では節を出さない**: 境界計算は snapshot の最終 `complete` が true のときだけ行う（[aggregate.ts](../src/progress/aggregate.ts) の `complete ? computePostCompletion(...) : undefined`）。瞬間的に全 canonical が done/skip を満たしても、その後の退行で最終状態が未完（例: skip→error）になった run は `completedAt`/`postCompletion` ともに undefined とし、ヘッダの「現在地: 未完」と矛盾させない。
- 完成後の編集で再び全工程が揃っても、`completedAt` は**最初の完成時刻に固定**（第2・第3版の編集はすべてこの節に積む）。これは意図どおり。
- **同 `at` の tie-break（open question）**: 完成イベントの特定と前後判定は**入力配列の順序**で行う（`at` 昇順の安定ソート後、同時刻は元の配列順を保つ）。実運用では [RunProgress.readEvents](../src/progress/RunProgress.ts) が append 順を保つので「記録順」になる。aggregate 単体に未ソート配列が渡る場合も「入力配列順」を tie-break とする（aggregate は純関数で、それ以上の順序保証は持たない）。
- **build-verify を手動で後から記録した run（findings #2）**: `codeCheck === false` でも build-verify の実イベントがあれば、それを**完成条件に含める**。したがって他工程が export まで終わっていても、手動 build-verify がそれより後に記録されれば `completedAt` はその手動イベントまで遅れる（＝ export 後・build-verify 前の revise/completion-report は「完成後ログ」に入らない）。これは「手動 build-verify をした run ではそれも完成条件」という意図どおりの挙動。誤解を生みやすいので §6 にこのケースのテストを置いて固定する。

## 4. データフロー / 型変更

集約で境界と完成後イベントを確定し、レンダラはそれを描画するだけにする（I/O・推定を持ち込まない）。

### 4-1. types.ts（[src/progress/types.ts](../src/progress/types.ts)）

`ProgressSnapshot` に2フィールド追加:

```ts
// 完成（全 canonical が done/skip）に初めて到達したイベントの at。未完なら undefined。
completedAt?: string;
// 完成イベントより後ろに記録されたイベント（時系列）。完成後の編集経過。無ければ undefined。
postCompletion?: PostCompletionEntry[];
```

新しい表示用エントリ型（生イベントの必要分だけを写像。レンダラを events 非依存に保つ）:

```ts
export type PostCompletionEntry = {
  at: string;            // ISO8601（UTC）。表示時にローカル HH:MM:SS へ
  step: string;          // 記録された生の操作名（evaluate / direction-check 等をそのまま保つ）
  canonicalStep?: string; // resolveCanonicalKey(step) が canonical キーに解決されるとき、その値（畳み先）。非 canonical は undefined
  label: string;         // 表示用ラベル。canonical なら canonical ラベル、非 canonical は step 名そのまま
  status: ProgressEventStatus; // start/done/skip/error
  costUsd?: number;
  inputTokens?: number;  // LLM 工程のみ。完成後のトークン内訳を新節で復元するため保持
  outputTokens?: number;
  note?: string;
  output?: string;
};
```

> **alias の表示方針（findings #3）**: 完成後ログは「生の時系列」を見せる役割なので、表の `工程` 列は **`step`（raw）を表示**する（`evaluate`/`direction-check` 等の実操作名を消さない）。`canonicalStep`/`label` は畳み先の参照用に保持するが、表示の主役は raw。これにより集約表（canonical 畳み）と完成後ログ（raw）で役割を分ける。

### 4-2. aggregate.ts（[src/progress/aggregate.ts](../src/progress/aggregate.ts)）

既存ロジックは温存し、関数末尾で境界計算を追加する。

1. `codeCheck`（first-write-wins）は既存計算を流用（[aggregate.ts:83-87](../src/progress/aggregate.ts)）。
2. events を `at` 昇順に安定ソートしたローカル配列を作る（aggregate は未ソート配列が来うる前提）。
3. canonical キー集合と「最初から terminal なキー」（build-verify 既定オフかつ実イベントなし）を初期化。
4. リプレイ: 各イベントで canonical キーの状態を優先度で更新し、**全 canonical が done/skip になった最初のイベント**を `completedAt`＝そのイベントの `at`、その配列インデックスを境界とする。
5. `postCompletion` = 境界インデックスより後ろのイベントを `PostCompletionEntry` に写像。`step` は生の `ev.step`、`canonicalStep` は `resolveCanonicalKey(ev.step)` が canonical キー集合に入るときのみその値、`label` は `labelOf.get(canonicalStep) ?? ev.step`。`inputTokens`/`outputTokens`/`costUsd`/`note`/`output` は各イベントの実値をそのまま写す（集約はしない＝完成後の1イベント＝1行）。空なら `undefined`。
6. snapshot に `completedAt` / `postCompletion` を載せる。

> 注: 完成後イベントには canonical のやり直し（factcheck 等）も非 canonical（revise / factcheck-stamp 等）も**両方**含める。集約表が前者を既存行に畳むので、生の時系列はこの節でしか見えないため。

### 4-3. renderMarkdown.ts（[src/progress/renderMarkdown.ts](../src/progress/renderMarkdown.ts)）

既存の表・注記の後ろに、`snapshot.postCompletion` があるときだけ節を追加する。

```
## 完成後の変更ログ（時系列）

> 完成（全工程 done/skip 到達）後に記録されたイベント。正本は progress.events.jsonl。
- 完成到達: 2026-06-22 13:14:11 +09:00

| 時刻 | 工程 | 状態 | 概算$ | トークン(in/out) | 補足 |
|---|---|---|---|---|---|
| 14:28:29 | revise | ✅ done | ~$0.4639 | 30,134/25,901 | runs/.../final.md |
| 14:28:40 | factcheck-scope | ✅ done |  |  | scope=diff (3 sections / 4 claims) |
| 14:33:48 | factcheck | ✅ done |  |  | 差分factcheck（接近距離1点）… |
| 14:35:00 | export | ✅ done |  |  | 第3版 再export |
| 14:35:03 | completion-report | ✅ done |  |  | GO（第3版） |
```

- `工程` 列は **raw `step`** を表示（`evaluate`/`direction-check` 等を畳まない。findings #3）。
- 時刻は既存 `formatLocalTime`、完成到達は `formatLocalDateTime`（UTC との取り違え回避は既存方針どおり）。
- 状態ラベルは既存 `STATUS_LABEL` を再利用。
- `概算$` 列は `costUsd` があるときだけ値を出す（無ければ空）。
- `トークン(in/out)` 列は既存表と同じく `fmtTokens` で桁区切り。`inputTokens`/`outputTokens` のどちらかがあるときだけ値を出す（完成後のトークン内訳を復元。findings #1）。完成後イベントに1件もトークンが無ければ**列ごと省略**（既存表と同じ条件付き列の方針に揃える）。
- 補足は既存表と同じく `output / note` を結合し `escapeCell`。
- 完成後イベントが無ければ節ごと出さない（既存 run・未完 run の出力を変えない）。

## 5. 出力例（2026-06-22-hayabusa2 を想定）

§4-3 のとおり、完成（13:14:11）後の revise/再factcheck/再export/completion-report が時系列で1ブロックに並ぶ。集約表は従来どおり（完成後分を畳んだ最新値）を維持しつつ、「いつ・何を・どの順で直したか」がこの節で一目で追える。

## 6. テスト

- `tests/progress/aggregate.*`:
  - 完成後イベントなし → `completedAt` セット済み・`postCompletion` undefined。
  - 完成後に revise→factcheck→export → `postCompletion` が時系列で3件、`completedAt` は最初の完成イベントの at。
  - build-verify 既定オフ（codeCheck=false・実イベントなし）でも、残り canonical が揃った時点を `completedAt` にする。
  - **build-verify を手動で export 後に記録した run（findings #2）**: `codeCheck=false` でも build-verify 実イベントを完成条件に含めるため、`completedAt` はその手動イベントまで遅れる。export〜build-verify 前のイベントは `postCompletion` に**入らない**ことを固定する。
  - **トークン内訳（findings #1）**: 完成後の revise（input/output tokens あり）が `postCompletion[i].inputTokens/outputTokens` に保持され、レンダリングでトークン列が出る。完成後にトークン記録が1件も無ければ列が省略される。
  - **raw step 保持（findings #3）**: 完成後に `evaluate` を記録 → `postCompletion[i].step === "evaluate"`、`canonicalStep === "refine"`、`label === "評価・改稿（refine / evaluate）"`。表示は raw `step`。
  - 一度も完成しない run → `completedAt`/`postCompletion` ともに undefined。
  - 完成後に再完成（第2版）しても `completedAt` は最初の完成時刻に固定。
  - 同 `at` の複数イベントは入力配列順で前後判定される（tie-break）。
- **冪等性（再生成を複数回実行）**:
  - 同一 events から `aggregate` を2回 → **`completedAt`/`postCompletion` が一致**（純関数で決定的。ただし snapshot の `updatedAt` は毎回 `new Date()` で更新されるため全体一致ではない＝既存挙動）。
  - 同一 events から `regenerate`（progress.md 書き出し）を2回 → **`更新:`（updatedAt）行を除き progress.md がバイト一致**（新節含む。全上書き・marker merge なしを固定）。
  - 完成後に同一 CLI 工程を2回記録（例: export×2）→ 集約表は1行に畳む一方、`postCompletion` には**2件**並ぶ（生の時系列＝append-only の正直な反映）。`completedAt` は不変。
- `tests/progress/renderMarkdown.*`（TZ 固定）:
  - `postCompletion` ありで「完成後の変更ログ」節・完成到達行・行数・ローカル時刻が出る。
  - undefined のとき節が出ない（既存スナップショットのレンダリングが不変）。
- 既存テストの非回帰（集約表・追加アクション節・現在地/コスト合計は不変）。

## 7. 非採用案

- **B: progress2.md 別ファイル** — 実質ログが events.jsonl と progress2.md の2系統に割れて照合が必要。いつリセットするか等の再生成意味論も濁る。reader が見るファイルを増やさない A を優先。
- **C: events.jsonl 直読み運用** — 生 JSON を人が追うのは負担。progress.md に閉じる方針（1記事の進捗が runs/<id>/ で完結）と合わない。

## 8. 非ゴール（スコープ外）

- 既存集約表の畳み込み仕様は**変えない**（完成後分を既存行に積む挙動は維持）。
- コスト合計・トークン合計の「完成前/後」分割は今回やらない（必要なら別タスク）。
- progress.json のスキーマ追加（`completedAt`/`postCompletion`）は snapshot 由来で自然に載るが、外部消費者向けの明文化は別途。

## 9. ロールアウト

1. types.ts に `completedAt` / `postCompletion` / `PostCompletionEntry` を追加。
2. aggregate.ts に境界リプレイと写像を追加（既存ロジック温存）＋単体テスト。
3. renderMarkdown.ts に節追加（TZ 固定テスト）。
4. 既存テスト非回帰を確認。
5. ブランチ `feat/progress-post-completion-log` で PR 化。
