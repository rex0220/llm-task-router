# シリーズ README の作成中ステータス自動表示 実装案

> ステータス: 実装済み（v2 / Claude 起案・Claude レビュー2巡反映） / 対象: llm-task-router series 機能
> 最終更新: 2026-06-24
> 実装: `feat/series-writing-status`（seriesMeta/series/index/import ＋ tests・CLAUDE.md/howto/update-article-plan 反映）

## 目的

シリーズのメンバー記事を **作成開始した時点で** `series/<slug>/README.md` を自動生成・更新し、
その記事を「作成中」ステータスで一覧表示する。完成（公開）したら「done」に切り替える。

ねらいは3つ:

1. **README をオプトインから外す**（作成開始で自動的に束の一覧ができる）。現状は初回 `series:status --write` を
   手で打たないと README ができず、束の状態が一覧で見えない。
2. **記事のライフサイクルを可視化する**。現状は `planned`（未作成枠）｜`done`（run あり）の2値で、
   「作成に着手したがまだ公開していない」状態が `done` に潰れている。
3. **完成後の変更も反映する**。done になった記事に手を入れ始めたら「更新中」に戻し、再公開で done に戻す（§6）。

## 現状

### ステータスは2値で、create 時に即 done

[`src/storage/seriesMeta.ts`](../src/storage/seriesMeta.ts) の定義:

```ts
export type SeriesMemberStatus = "planned" | "done";
```

`article:create --series` は run 作成成功後に [`recordMember`](../src/cli/series.ts) → `upsertMember` を呼び、
その場で `status: "done"` を記帳する（[series.ts:39-41](../src/cli/series.ts#L39-L41)）。

```ts
// upsertMember（抜粋）
if (slot) {
  slot.slug = entry.slug;
  slot.runId = entry.runId;
  slot.status = "done";
} else {
  next.push({ order, slug: entry.slug, runId: entry.runId, status: "done" });
}
```

つまり「run ができた＝done」。作成パイプライン（create→refine→factcheck→export）の
**入口で done になる**ため、未公開でも一覧上は完成扱いになる。

### README は初回オプトイン（create では作られない）

create/export 後の自動再生成は `onlyIfExists: true` で、**README が既にある束だけ**を更新する
（[index.ts:839-850](../src/index.ts#L839-L850) `refreshSeriesReadme`、[series.ts:325-327](../src/cli/series.ts#L325-L327)）。

```ts
// refreshSeriesReadme（抜粋）
const dir = await writeSeriesReadme(slug, { onlyIfExists: true });
```

初回 README は `series:status --write` を手で打つまで作られない。これが「dinosaur に README が無い」原因。

### 表示は done/それ以外の2分岐

[`renderSeriesReadme`](../src/cli/series.ts#L350-L369):

```ts
const status = m.status === "done" ? "✅ done" : "⬜ planned";
```

## 変更内容

### 1. ステータスに `writing`（作成中）を追加（`src/storage/seriesMeta.ts`）

```ts
export type SeriesMemberStatus = "planned" | "writing" | "done";
```

状態遷移:

| 状態 | 意味 | 遷移トリガ |
|---|---|---|
| `planned` | 未作成枠（runId=null） | `series:plan` 等で枠だけ確保（現行どおり） |
| `writing` | 作成中（run あり・未公開） | `article:create --series`（**新**：従来は done） |
| `done` | 完成（公開相当） | `article:export`（**新**：member を done に更新） |
| `updating` | 更新中（done 後に変更着手・未再公開） | `article:revise` / `update-article` の import（**新**・§6） |

検証（`validateMembers`）も4値を許可するよう更新。

> **⚠ 着地順の制約（最優先・silent downgrade 防止）**
> [seriesMeta.ts:137](../src/storage/seriesMeta.ts#L137) は今こうなっている:
>
> ```ts
> const status = member.status === "done" ? "done" : "planned";
> ```
>
> `done` は無条件で通るので**後方互換（既存 done の温存）は元々安全**。本当の危険は逆向きで、
> この行を4値対応にする**前に** create が `writing` を書き始めると、次回読み込みで `writing`/`updating` が
> **黙って `planned` に落ちる**（runId はあるのに planned という不整合＝silent downgrade）。
> よって **validator の4値化（実装ステップ1）は、create の `writing` 記帳（同3）より必ず先に着地させる**。
> CLAUDE.md の「silent skip 禁止」と同じ理由で、ここは silent downgrade なので特に危険。

### 2. `upsertMember` は status を**必須引数**に（`src/cli/series.ts`）

> **⚠ 共有関数のカップリング**：`upsertMember` は create 経路（[series.ts:249](../src/cli/series.ts#L249)
> `recordMember`）だけでなく、**`series:status --fix` の `reconcileMembers`（[series.ts:91](../src/cli/series.ts#L91)）も
> status 無しで呼ぶ**。ここで既定を `"writing"` にすると、`series:status --fix` を打つたびに公開済みの
> `done` メンバーまで一律 `writing` に格下げされる（今は逆に一律 `done` に格上げしている）。

既定値を持たせず **status を必須引数**にして、呼び出し側に判断を強制する（silent な格上げ/格下げを構造的に防ぐ）。

```ts
export function upsertMember(
  members: SeriesMember[],
  entry: { order?: number; slug: string; runId: string; status: SeriesMemberStatus } // status 必須
): SeriesMember[] {
  // slot あり/なしとも entry.status を使う
}
```

- `recordMember`（create 経路）：`status: "writing"` を渡す。
- `reconcileMembers`（--fix 経路）：run メタから status を導出して明示的に渡す（規則は「影響範囲・互換性」§ --fix の status 導出）。

### 3. create で README を必ず生成（`src/index.ts`）

`article:create --series` 成功後の `refreshSeriesReadme` を、**README が無くても書く**経路にする。

案A（推奨）: create 専用に `onlyIfExists: false` で呼ぶ。

```ts
// create 後（--series 指定時）。作成開始で束の一覧を必ず作る。
await writeSeriesReadme(options.series, { /* onlyIfExists 省略 = 常に書く */ });
```

export など他経路の `refreshSeriesReadme(onlyIfExists:true)` は現状維持（オプトイン尊重）。
create だけが「初回 README を作る」起点になる。

> 補足: 「README はオプトイン」という従来方針を create に限って緩める。export/その他での自動生成は
> 引き続き「一度作られた束だけ」を更新する（無用な README 量産を避ける）。

### 4. export で member を `done` に更新（`src/index.ts` export 経路）

`article:export` 成功後、対象 run が series メンバーなら `series.json` の該当 member を
`status:"done"` に更新し、README を再生成する。run の `meta.series`（seriesId/order）から対象を特定する。

```ts
// export 成功後（meta.series があれば）
if (meta.series?.seriesId) {
  await markMemberDone(meta.series.seriesId, runId); // withLock 内で series.json 更新
  await refreshSeriesReadme(meta.series.seriesId);   // 既にある README を更新
}
```

`markMemberDone` は `SeriesStore.withLock` 内で read-modify-write（既存の並行安全に相乗り）。
対象 member が無ければ no-op（best-effort、本処理は止めない）。

### 5. 表示を4値に＋日本語へ統一（`src/cli/series.ts` `renderSeriesReadme`）

> **言語の混在を解消**：現状案の `⬜ planned` / `✅ done`（英語）と `🚧 作成中`（日本語）が混ざっていた。
> README は**人が読む日本語の派生ビュー**なので、ラベルは**日本語に統一**する。

```ts
const STATUS_LABEL: Record<SeriesMemberStatus, string> = {
  planned: "⬜ 予定",
  writing: "🚧 作成中",
  updating: "✏️ 更新中",
  done: "✅ 完成",
};
const status = STATUS_LABEL[m.status] ?? "⬜ 予定";
```

`STATUS_LABEL` は **README 専用**。`series:status` のコンソール表示（[index.ts:286](../src/index.ts#L286)）は
生の status 文字列（`writing`/`updating`/`done`/`planned`）をそのまま出す**技術ビュー**なので英語キーのままで問題なく、
ラベル化は**しない**（README＝日本語の人間ビュー／コンソール＝英語キーの技術ビュー、と役割で分ける）。
ただし現在 `m.status.padEnd(7)` で、`"updating"` は8文字＝padEnd(7) に収まらず（padEnd は切り詰めない）
列が1桁ずれるので、**`padEnd(8)` に幅だけ上げる**調整に留める。

> `done` のラベルは「完成」とする。トリガは export（公開相当の書き出し）だが、`record-publication`（公開台帳）とは
> 別工程なので「公開済み」と書くと record-publication 前でも公開済みに見えて誤解を招く。「完成」が安全。

## 6. 完成後に変更を開始した場合（done → updating）

> 要望：「記事完成後に、変更開始した場合も反映したい」。done のメンバーに手を入れ始めたら
> 一覧で「更新中」に戻し、再 export で `done` に戻す。

変更の入口は2系統あり、扱いが分かれる。

### 6.1 同一 run の手直し（`article:revise`）— 単純

`/review-editorial` の反映や軽微修正は `article:revise --run <runId>` で**同じ run** を直す。
この run が series メンバー（`meta.series` あり）かつ現状態が `done` なら、`updating` に戻す。

```ts
// revise 成功後（meta.series があり、現 member が done のとき）
if (meta.series?.seriesId) {
  await markMemberStatus(meta.series.seriesId, runId, "updating"); // done のときだけ更新
  await refreshSeriesReadme(meta.series.seriesId); // 既にある README を更新
}
```

`markMemberStatus` は `withLock` 内で read-modify-write。**現状態が `done` のときだけ** `updating` にする
（`writing` 中の revise は作成途中なので `writing` のまま＝状態を退行させない）。再 export で `done` に戻る（§4）。

### 6.2 公開済み記事の更新（`/update-article` ＝ `article:import --supersedes`）— 新 run

`/update-article` は import 起点で**新しい runId** を作り、旧 run を `meta.lineage.supersedesRunId` で指す
（書き込みは `importArticle` 内部・[src/cli/import.ts:139-146](../src/cli/import.ts#L139-L146)）。ここで2つ問題がある:

1. **新 run に series membership が引き継がれない**：`article:import` には `--series` が無く、
   新 run の `meta.series` は空。series.json のメンバーは**旧 runId のまま**を指している。
2. その結果、新 run を export しても §4 の `markMemberDone` が対象を見つけられない。

**決定：案A（runId 付け替え）を採る。**

`article:import` に `--series <slug>` を許可し、**supersedes 先が series メンバーなら自動継承**する。
import 時に series.json の該当 member の `runId` を新 run に**付け替え**、`status:"updating"` にする。
旧 runId は lineage（縦）に残るので情報は失われない。member は常に「現行版の run」を指す（横の束＝最新版）。

> **なぜ案A一択か**：案B（runId 据え置き・status のみ updating）だと、新 run を export しても
> `markMemberDone` が `meta.series` を見つけられず（新 run に membership が無い）、member が `updating` のまま閉じない。
> 結局 export 時に runId 付け替えが要るので、案B でもやることは案A とほぼ同じ。ライフサイクルを閉じるには
> 付け替えが不可避＝案A が必須。

> `/update-article` のフロー（CLAUDE.md・[docs/update-article-plan.md](update-article-plan.md)）に
> 「series メンバーなら import に `--series` を付ける」手順追記が必要。

## 影響範囲・互換性

- **既存 series.json**：旧 create で `done` になっているメンバーはそのまま `done` 表示（遡及変更しない）。
  今回の dinosaur-intro も既に `done`。手で `writing` に戻したい場合のみ後述の運用で。
- **`series:status --fix` の status 導出（決定・信号は export 工程）**：[seriesMeta.ts:137](../src/storage/seriesMeta.ts#L137) の
  正規化と `reconcileMembers` を4値対応にする。reconcile は run 側を正にするので、各メンバーの status を
  **run の進捗（export 工程の done）から次のように導出**して `upsertMember` に明示的に渡す:

  | run の状態 | 導出 status |
  |---|---|
  | progress で **export 工程が done**（[aggregate](../src/progress/aggregate.ts#L32) / `readSnapshot`） | `done` |
  | run あり・export 未 done | `writing` |
  | 既存 member が `updating` | **そのまま保持**（progress から復元不能なので上書きしない） |

  > **⚠ done 信号を `meta.published` にしない理由（決定#1 とのトリガ整合）**
  > 当初 `meta.published` を done 信号にしていたが、これは決定#1（§4：export で done を書く）と**別の工程の信号**で食い違う。
  > 実際 `meta.published` を立てるのは [record-publication.ts:131](../src/cli/record-publication.ts#L131) **だけ**で、
  > `article:export`（[export.ts](../src/cli/export.ts) はコピーのみ・meta 非更新、howto.md 568-570）とは別工程。
  > その結果「**export 済みだが record-publication 前**」のメンバー（§4 で done を書いたのに `meta.published` は無し）に
  > `--fix` を打つと、`meta.published` 基準では「run あり・published なし → writing」と判定し、**done を writing に巻き戻す**
  > （#2 が構造的に潰したはずの silent downgrade が fix 経路で再発）。
  > プロジェクト原則は「**進捗上の完了は export で表す**」（howto.md 570・record-publication は canonical 工程外）。
  > よって**トリガ（§4＝export）と --fix 導出の信号を「export 工程 done」に統一**する。export は
  > [index.ts:552](../src/index.ts#L552) で `recordProgress(step:"export", status:"done")` を打ち progress.events.jsonl（正本）に
  > 残るので、`--fix` はそれを `aggregate`/`readSnapshot` で読む（`meta.steps.export` は **export が markDone を呼ばないため空**＝使えない）。

  `updating` は progress に痕跡が残らないため、reconcile は再現せず**保持に徹する**（fix で `done`/`writing` に巻き戻さない）。

  > 実装注記：現 `reconcileMembers(data.members, runs)` は `RunMeta[]` しか受けない（[series.ts:51](../src/cli/series.ts#L51)）。
  > export 工程 done を読むには、呼び出し元 `seriesStatus`（[series.ts:274](../src/cli/series.ts#L274)・既に `runStore` を持つ）で
  > 各 run の progress snapshot を引き、`Map<runId, exportDone>` を reconcile に渡す（または run ごとに既存 member status を
  > 渡して導出する）形に拡張する。`updating` 保持のため、既存 member status も reconcile に渡すこと。
- **verify-artifacts / completion-report**：series member status は参照していない（はず）。要確認。

## 決定事項（レビュー反映）

レビューで論点から決定に格上げした項目:

1. **done の信号は「export 工程 done」に統一**（§4 トリガと --fix 導出で同一信号）。`article:export` が打つ
   progress イベント（`step:"export", status:"done"`・progress.events.jsonl が正本）を done の単一信号とする。
   `meta.published`（record-publication 由来・canonical 工程外）は**使わない**（別工程で食い違い＝fix で done を
   writing に巻き戻す silent downgrade が再発するため。「影響範囲・互換性」§ --fix 参照）。
2. **`series:status --fix` の status 導出**は export 工程 done で `done`/`writing` を判定し、
   `updating` は保持（progress から復元不能なので上書きしない）。
3. **更新フローの membership 継承は案A**（`article:import --series` で supersedes 先メンバーを新 run に
   付け替え＋`updating`）（§6.2）。ライフサイクルを閉じるには付け替えが不可避なため。
4. **README 自動生成は create 限定**（export/その他は従来どおり `onlyIfExists:true`）。
5. **`upsertMember` の status は必須引数**（既定値を持たせない＝silent な格上げ/格下げを構造的に防ぐ）（§2）。

## 残る確認事項

1. **ラベル文言の最終承認**：README を日本語に統一し `⬜ 予定 / 🚧 作成中 / ✏️ 更新中 / ✅ 完成`（§5）。この文言で良いか。
2. **verify-artifacts / completion-report が series member status を参照していない**こと（影響なし）の最終確認。

## 実装ステップ（承認後）

> **⚠ 着地順の制約**：ステップ1（validator 4値化）はステップ3（create の `writing` 記帳）より**必ず先**に
> 着地させる。逆順だと `writing`/`updating` が次回読み込みで silent に `planned` に落ちる（§1）。
> 同一 PR でも順序を守り、できればステップ1だけ先行マージするのが安全。

1. **`seriesMeta.ts`（最初）**：`SeriesMemberStatus` に `writing`/`updating` 追加、`validateMembers` の
   4値許可（[seriesMeta.ts:137](../src/storage/seriesMeta.ts#L137) の `done`以外→planned 潰しを撤廃）。
2. `series.ts`：`upsertMember` の **status を必須引数化**、`reconcileMembers` が run の進捗から status を導出して
   渡す（**export 工程 done → done** / run のみ → writing / 既存 updating → 保持）、`renderSeriesReadme` を
   4値・日本語ラベル化（§5）、`markMemberDone` / `markMemberStatus`（done のときだけ updating）追加。
3. **`index.ts`（1の後）**：create を `writing` で記帳＋README 常時生成（`onlyIfExists` 省略）、
   export で `done`＋README 更新、revise で done→`updating`（§6.1）、`series:status` コンソールは
   生 status ＋ `padEnd(8)` に幅調整のみ（§5）。
4. `article:import`：`--series` 追加と supersedes 先メンバーの新 run への付け替え＋`updating`（§6.2・案A）。
5. テスト：create→writing→export→done→(revise/import)→updating→export→done の遷移、
   初回 README 生成、旧 done の後方互換、`--fix` の status 導出（updating 保持）、update-article 経由の継承。
   **`reconcileMembers` のシグネチャ拡張（唯一の非自明な拡張）は専用テストを入れる**：`seriesStatus` が各 run の
   progress snapshot を **best-effort** で引き、**読めない run は `writing` にフォールバック**する（snapshot 取得失敗で
   reconcile 全体を落とさない／export 工程 done が読めた run だけ `done`／既存 `updating` は保持）。
6. ドキュメント：CLAUDE.md の series 節、[docs/series-spec.md](series-spec.md)、
   [docs/update-article-plan.md](update-article-plan.md) に状態遷移と手順を追記。
