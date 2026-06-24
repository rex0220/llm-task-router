# シリーズ記事の候補名（planned タイトル）記録 実装案

> ステータス: 実装済み（v2 / Claude 起案・Claude レビュー1巡反映） / 対象: llm-task-router series 機能
> 最終更新: 2026-06-24
> 実装: `feat/series-candidate-titles`（seriesMeta/series/index ＋ tests・hook/settings に series:plan 追加・docs 反映）

## 目的

シリーズ作成時に**記事候補名（ラインナップ）を記録**し、未作成の段階から束の全体像を README に出す。
記事を作成・見直したら**実タイトルへ自動で反映**する。

ねらい:
1. 作成前から「この束はどんな回で構成するか」を一覧で見えるようにする（planned 枠に候補名を持たせる）。
2. **候補名の正本を正しい場所に置く**。README.md は派生ビューで再生成のたびに上書きされるため、候補名の
   保存先にはできない（手書きが消える）。正本は `series.json`、README は描画に徹する。

## 現状

### 候補名を持てない（planned 枠は「（未作成）」固定）

[`SeriesMember`（seriesMeta.ts:31-36）](../src/storage/seriesMeta.ts#L31-L36) に**タイトル欄が無い**:

```ts
export type SeriesMember = {
  order: number;
  slug: string;
  runId: string | null; // 未作成枠は null
  status: SeriesMemberStatus;
};
```

README のタイトルは**作成後の run の `meta.articleTitle` からしか拾えない**（[series.ts:476-486](../src/cli/series.ts#L476-L486)）。
planned 枠（`runId:null`）は一律「（未作成）」（[series.ts:504](../src/cli/series.ts#L504)）。

### README は派生ビュー（記録先にできない）

README は `series:status --write` / `article:create --series`（作成開始）/ `article:export`・`article:revise`
（既存 README のある束）のたびに**機械再生成**される（[index.ts refreshSeriesReadme](../src/index.ts)）。
手書きの候補名は次の工程で消える。**候補名の正本は `series.json` に置くしかない**。

### 位置づけ

これは仕様の **`series:plan`（第2段予定・[series-spec.md:184](docs/series-spec.md#L184)）** の最小実装に相当する
（未作成記事枠に候補を割り付ける）。本案はそのうち「候補名の保持＋README 表示＋見直し反映」だけを先行する。

## 変更内容

### 1. `series.json` の member に候補タイトルを追加（`src/storage/seriesMeta.ts`）

```ts
export type SeriesMember = {
  order: number;
  slug: string;
  runId: string | null;
  status: SeriesMemberStatus;
  title?: string; // 候補名（計画時の planned タイトル）。作成後は run の meta.articleTitle が表示優先（任意）
};
```

`validateMembers` で `title` を任意文字列として受理（空文字は undefined 扱い・トリム）。

> **⚠ 着地順（前回と同型・silent drop 防止）**: validator が `title` を**保持**する変更（実装ステップ1）は、
> `title` を書き込む経路（series:plan / upsertMember・同3,4）より**必ず先**に着地させる。逆順だと書いた
> `title` が次回読み込みで黙って落ちる。

### 2. `upsertMember` に `title` を通す（`src/cli/series.ts`）

> **silent drop の主経路は `upsertMember` ではなく `validateMembers`**。`validateMembers` は member を
> `{order, slug, runId, status}` で作り直す（[seriesMeta.ts:138](../src/storage/seriesMeta.ts#L138)）ので、
> `title` を足さない限り**読み込みのたびに毎回落ちる**（だからステップ1で validator を最優先にする）。
> 一方 `upsertMember` の既存スロット更新パスは `slot.x = ...` のフィールド単位代入で、`{...m}` コピー済みの
> `title` は触らなければ自動的に残る＝**update パスは title を消さない**。

したがって `upsertMember` に明示の `title` 処理が要る理由は次の2点に限られる（mutation パスが危険なのではない）:

1. **新規スロット（push branch）が title を運ぶ**: `next.push({ order, slug, runId, status })` に title が無いと、
   series:plan で作る新規 planned 枠に候補名が乗らない。
2. **series:plan が既存スロットの title を更新できる**: `slot.title = entry.title ?? slot.title`
   （entry.title 未指定なら既存保持。create/reconcile はこの経路で title を渡さず＝既存値を保つ）。

```ts
export function upsertMember(
  members: SeriesMember[],
  entry: { order?: number; slug: string; runId: string | null; status: SeriesMemberStatus; title?: string }
): SeriesMember[] {
  // 既存スロット: slot.title = entry.title ?? slot.title（未指定なら保持）
  // 新規スロット: next.push({ order, slug, runId, status, title: entry.title })  // title を運ぶ
}
```

> 注: 現在 `upsertMember` の `runId` は `string` だが、planned 枠（`runId:null`）を series:plan で
> upsert できるよう `string | null` に広げる（create 経路は従来どおり実 runId を渡す）。

### 3. README の title 解決を優先順位化（`src/cli/series.ts` `renderSeriesReadme`）

実タイトル（作成後）＞ 候補タイトル ＞ プレースホルダ、の順:

```ts
const title =
  (m.runId && titleByRunId.get(m.runId)) || // 作成済み＝実 meta.articleTitle が最優先（見直し反映）
  m.title ||                                 // 未作成/未取得＝候補名
  (m.runId ? "（タイトル未取得）" : "（未作成）");
```

これで「作成・見直し後は実タイトルへ自動反映」「未作成は候補名表示」が両立する。
状態列（`⬜ 予定`）で planned と分かるので、候補名はそのまま出す（必要なら `（候補）` 注記は将来検討）。

### 4. 候補名を記録する入口 `series:plan`（最小実装・`src/index.ts` ＋ `src/cli/series.ts`）

planned 枠を upsert する最小コマンド。`withLock` 内で series.json を read-modify-write（既存の並行安全に相乗り）。

```
llm-task-router series:plan --slug <s> --title "<候補名>" [--order N] [--member-slug <slug>]
```

- `--order` 省略時は末尾に自動採番（`resolveOrder`・新規スロット＝安全）。明示時はその枠を upsert。
- `--member-slug` 省略時は `--title` から kebab-case 導出（planned 枠も slug を持つため）。
- 作る member は `{order, slug, runId:null, status:"planned", title}`。
- 実行後 README を再生成（`create:true` 同様、無ければ作る＝計画段階で一覧を出す）。
- バッチ（`--plan-file <path>`：1行1候補 `slug: title` または `title` のみ）は**任意・将来拡張**。

> **🔴 作成済みスロットの巻き戻しを禁止する（guard 必須）**: `series:plan --order N` の N に**既に run が
> 紐づくスロット（`runId != null`）がある場合、upsertMember にそのまま渡すと runId が null・status が planned に
> 巻き戻る**（[series.ts:45-48](../src/cli/series.ts#L45-L48) の slot 更新が runId/status を上書きするため）。
> 候補名は付くが run linkage が series.json から消える footgun。決定3「downgrade しない」を **series:plan 自身にも
> 適用**し、対象 order（または member）が `runId != null` なら**拒否**する:
> `Error: order N already has a created run <runId>; series:plan fills planned slots only`。
> （`--order` 自動採番は新規スロットなので安全。明示 `--order` が作成済みに当たったときだけの問題。）
> series:plan は **planned 枠の新設／planned 枠の title 更新だけ**を行い、作成済みスロットには触れない。

### 5. 見直し時の反映（挙動・新コード最小）

- **作成/改稿後**: `article:create --series` / `article:revise` 後に README を再生成すると、§3 の優先順位で
  **実 `meta.articleTitle` が候補名を置き換える**（既存の自動再生成経路に乗るだけ・新コード不要）。
- **再計画**: ラインナップを見直すときは `series:plan` を再実行して planned 枠の `title` を更新。
- **`--fix` は候補名を保持**: `reconcileMembers` は §2 の upsert 経由で planned 枠の `title` を残す
  （run が無い枠を「（未作成）」に戻さない＝機械復元できない人手情報を downgrade しない・前回の `updating` と同方針）。

## 影響範囲・互換性

- **既存 series.json**: `title` 無しの member はそのまま有効（任意フィールド）。表示は従来どおり。
- **`upsertMember` の呼び出し元**: create（recordMember）/ reconcile / inheritSeriesMembership は `title` 未指定で
  呼ぶ＝既存挙動不変（title を保持するだけ）。`runId: string | null` への拡張で型は緩むが既存呼び出しは実 runId。
- **verify-artifacts / completion-report**: member を一切参照しない（grep 済み・影響なし＝確定）。
- **README 描画**: 候補名が出るだけ。作成済み行は従来どおり実タイトル。

## 決定事項（提案）

1. **候補名の正本は `series.json` の `members[].title`**。README.md は派生ビュー＝描画のみ（手書き禁止）。
2. **表示優先順位**: 実 `meta.articleTitle` ＞ 候補 `title` ＞ プレースホルダ（作成・見直し後は実タイトルが勝つ）。
3. **作成済みスロットを巻き戻さない（downgrade しない）**を `--fix`/reconcile **と** `series:plan` の両方に適用。
   - reconcile: planned 枠の候補 `title` を保持（run が無い枠を「（未作成）」に戻さない）。
   - series:plan: `runId != null` のスロットへの `--order` は拒否（planned 枠の新設／title 更新のみ）。
4. 入口は **`series:plan`（最小・planned 枠 upsert）**。バッチ/`outline→自動割り付け`は将来拡張。
5. **member を参照するのは `series.ts` と `import.ts` のみ**（grep 済み）。`verify-artifacts` / `completion-report`
   は member を一切参照しないので、`title` 追加の影響なし（確定・「要確認」から格上げ）。

## 残る確認事項

レビューでいずれも所見が出たため既定を確定（異論があれば変更）:

1. **候補名の表示注記**: `（候補）` は**付けない**（状態列 `⬜ 予定`＋run 列 `（planned）` で区別十分・README は簡潔に）。
2. **`series:plan` の slug 衝突**: reconcile 衝突3は `status==="planned"` のときだけ warning（作成後は鳴らない）。
   `--member-slug` を実 slug 規約に寄せる運用で実害小＝**許容**。
3. **scope**: **最小（planned 枠 upsert）に留める**。outline 連携は spec どおり第2段、`--plan-file` バッチも将来。

## 実装ステップ（承認後）

> **⚠ 着地順**: ステップ1（validator が title を保持）を、title を書くステップ3/4 より**必ず先**に。

1. **`seriesMeta.ts`（最初）**: `SeriesMember.title?` 追加、`validateMembers` で任意文字列として受理（トリム・空→undefined）。
2. `series.ts`: `upsertMember` に `title?` ＋ `runId:string|null`、既存 title 保持ロジック。`renderSeriesReadme` の
   title 解決を優先順位化（実＞候補＞プレースホルダ）。`reconcileMembers` は title を渡さず保持に任せる。
3. `series.ts` ＋ `index.ts`: `series:plan`（planned 枠 upsert＋README 再生成）コマンド追加。
4. テスト:
   - validator: title 往復（保持・空→undefined）。
   - `upsertMember`: 新規スロット（push）が title を運ぶ／update パスは title 未指定でも保持／series:plan（title 指定）で設定。
   - `renderSeriesReadme`: 実＞候補＞プレースホルダの優先順位。**runId あり・実タイトル未取得・候補あり → 候補名を表示**
     （従来「（タイトル未取得）」からの挙動変化をテストで固定）。runId 無し・候補あり → 候補名。候補も無し → 「（未作成）」。
   - `series:plan`: planned 枠が title 付きで作られ README に出る／`--order` 自動採番／**`runId != null` の order 明示は拒否**
     （作成済み巻き戻し guard・🔴）。
   - `--fix`: planned 枠の title が保持される（writing/done への昇格時も候補は残るが実タイトルが表示優先）。
5. ドキュメント: CLAUDE.md の series 節、[docs/series-spec.md](series-spec.md)（§ series:plan / candidate）、
   [docs/qiita-article-howto.md](qiita-article-howto.md) のシリーズ節に「候補名は series.json が正本・README は派生」を明記。
