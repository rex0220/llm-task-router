# 課題・対策・実装計画: 空振り revise が done メンバーを updating に戻す

## 現象

公開（export）まで完了したシリーズメンバーが、**本文を一切変えない revise（空振り）を 1 回流しただけで `done` → `updating` に巻き戻り**、`series/<slug>/README.md` が「✏️ 更新中」のまま残る。

### e2e で確認した事実

`series/nenkin`（#2 = `nenkin-seido-hokenryo` / run `2026-06-26-nenkin-seido-hokenryo`）:

```
| 時刻      | 工程   | 状態 |
|-----------|--------|------|
| 11:13:51  | export | done |  ← markMemberDone で #2 を done に
| 11:13:55  | revise | start|
| 11:14:17  | revise | done |  ← markMemberUpdating が done→updating に戻す
```

- `runs/.../final.md` は export 済み `export/nenkin-02-nenkin-seido-hokenryo-note.md` と**バイト一致**（未公開の変更なし）。
- `final.md` == `final.bak.md`（revise 直前の退避）。つまり**最後の revise は LLM が同一テキストを返した空振りで、本文は何も変わっていない**。
- それでも `series.json` の #2 は `status: "updating"`、README は「✏️ 更新中」表示になった。

### 二次的な影響

`series:status --fix` は `updating` を保持する仕様（[src/cli/series.ts:75-77](../src/cli/series.ts)・downgrade も格上げもしない）。
`done` の正規シグナルは「export 工程 done」だけ（[src/index.ts:703](../src/index.ts)）なので、
**空振り revise で巻き戻った updating は、再 export しない限り自動では done に戻らない**。
中身は公開版と同一なので再 export は本来不要であり、運用上は `series.json` を手で直すしかない（今回はそれで応急修復済み）。

---

## 原因

`article:revise` コマンドは revise 後、**final.md に実差分があるかを見ずに**無条件で `updating` を立てている。

[src/index.ts:557-562](../src/index.ts):

```ts
const meta = await store.readMeta(result.runId).catch(() => null);
if (meta?.series?.seriesId) {
  await markSeriesMember(meta.series.seriesId, result.runId, "updating"); // ← 無条件
  await refreshSeriesReadme(meta.series.seriesId);
}
```

`markMemberUpdating`（[src/cli/series.ts:444-447](../src/cli/series.ts)）は
`current === "done"` のメンバーだけ更新するガードは持つが、
**「本文が実際に変わったか」は判定しない**。LLM が同一テキストを返した空振り revise でも `done` を `updating` に落とす。

一方、差分の有無は判定できる材料が既に揃っている。`reviseQiitaFinal`
（[src/workflows/createQiitaArticle.ts:97-162](../src/workflows/createQiitaArticle.ts)）は
revise 前の `current` を `final.bak.md` に退避してから新テキスト `text` を書くため、
**`current` と `text` の両方を同一スコープに持っている**。今は戻り値に差分有無を含めていないだけ。

---

## 対策

**revise が実際に本文を変えたときだけ `updating` に戻す**（空振りなら `done` を据え置く）。

差分判定は `current`/`text` を持つ revise 側（workflow）で行い、結果をフラグで返して
CLI が `updating` を立てるかを分岐する。

### 1. `ReviseResult` に `changed` を足す

[src/workflows/createQiitaArticle.ts](../src/workflows/createQiitaArticle.ts):

```ts
export type ReviseResult = {
  // ...既存フィールド
  changed: boolean; // 追加: final.md が revise 前から変わったか
};
```

> `ReviseResult` は exported type。repo 内の利用箇所はいずれも返り値を**読む**だけなので
> 必須フィールド追加で壊れないが、外部やテストで `ReviseResult` オブジェクトを
> **明示的に組み立てている**コードがあると、必須 `changed: boolean` の追加は TypeScript 的に
> ソース互換ではない。公開 API 互換を重視するなら `changed?: boolean`（任意）にし、
> CLI 側は `result.changed === true`（厳密 true）で分岐する選択肢もある。
> 本 repo 内では明示生成箇所は無く、必須で問題ない。

`reviseQiitaFinal` 内（`text` 確定後）:

```ts
const changed = text !== current;   // 既に両方スコープにある
// ...
return { runId, finalText: text, changed, /* ...既存 */ };
```

> 比較は厳密一致（`text !== current`）で十分。空白だけの差を空振り扱いしたいなら
> `text.trim() !== current.trim()` でもよいが、過剰最適化はしない（既定は厳密一致）。

### 2. CLI は `changed` のときだけ updating を立てる

[src/index.ts:557-562](../src/index.ts):

```ts
const meta = await store.readMeta(result.runId).catch(() => null);
if (meta?.series?.seriesId && result.changed) {   // ← changed ガードを追加
  await markSeriesMember(meta.series.seriesId, result.runId, "updating");
  await refreshSeriesReadme(meta.series.seriesId);
}
```

- `changed === false`（空振り）: status 据え置き（`done` のまま）。README 再生成も不要なので skip。
- `changed === true`: 従来どおり `done` メンバーを `updating` に戻し、README を更新。
- writing 中・planned のメンバーは `markMemberUpdating` の guard により従来どおり影響なし。

---

## 影響範囲 / 互換性

- `ReviseResult` への**追加フィールド**のみ。repo 内の既存の戻り値利用箇所はいずれも値を読むだけなので無改修で動く。
  （`ReviseResult` は exported type のため、外部で同オブジェクトを明示生成しているコードがあると
  必須フィールド追加は厳密にはソース互換でない点は §対策のとおり。公開 API 互換を重視するなら `changed?: boolean`。）
- refine 経由の内部 revise 呼び出し（[createQiitaArticle.ts:546](../src/workflows/createQiitaArticle.ts)・`backupTo: null`）は
  `markSeriesMember` を呼んでいないため無関係。
- 既に正しく `updating`（実差分あり）になっているメンバーには影響しない。
- progress.events.jsonl への revise イベント記録自体は従来どおり（空振りでも実行記録は残す）。
  変えるのは **series メンバー状態の格下げ条件だけ**。

---

## 代替案（不採用）

- **A: `markMemberUpdating` 側で `final.md` と `final.bak.md` を比較する。**
  `final.bak.md` は revise 専用ではなく他工程の退避でも使われ得るため、
  「revise 前後の差分」を厳密には表さない。差分の責務は `current`/`text` を持つ revise 側が自然。却下。
- **B: 運用で手修復（今回の応急対応）。** 空振り revise のたびに再発するため恒久対策にならない。

---

## テスト

バグ本体は `reviseQiitaFinal` ではなく **CLI（[src/index.ts:557](../src/index.ts)）が `markSeriesMember(..., "updating")` を無条件に呼ぶ**点なので、
workflow の `changed` 単体だけでなく、**CLI 分岐の回帰を E2E/結合で守る**ことを必須とする。

### CLI / E2E（必須・本バグの回帰防止）

- `article:revise` 実行後、revise が**同一テキストを返した（空振り）**ケースで、
  `series.json` の対象メンバーが **`done` のまま**残る（`updating` に巻き戻らない）。
- `article:revise` 実行後、revise が**実差分を返した**ケースで、`done` → `updating` に戻る（既存挙動の維持）。
- いずれのケースでも README（派生ビュー）が series.json と整合する
  （空振り時は「✅ 完成」表示のまま、実差分時は「✏️ 更新中」）。
- LLM 呼び出しはスタブ/固定応答で差分有無を制御する（router をモックし、空振り＝入力 final.md と同一テキストを返す応答を注入）。

### workflow 単体

- `ReviseResult.changed` が `text !== current` を正しく反映する（空振り=false / 実差分=true）。

### 既存挙動の維持

- `writing` 中のメンバーは revise の差分有無に関わらず退行しない（`markMemberUpdating` guard の維持）。

---

## 既知の限界 / 補足

- 空白・改行だけの差は既定（厳密一致）では `changed=true`。意味的な無変更まで吸収はしない（許容）。
- 本対策は **series メンバー状態の正確性**が目的で、factcheck/export などの工程順・ゲートは不変。
- 今回の `series/nenkin` #2 は `series.json` を `done` に直し `series:status --write` で README 再生成済み（応急修復）。本対策は同種の再発を防ぐためのもの。
