# 参考リンクの並び順を id 昇順にする実装案

## 目的

参考章（`## 参考`）のリンクの並び順を、現行の「primary→secondary、その中で id 昇順」から
**id（source 番号）昇順の一本**に変更する。読者から見て番号が前後しない、素直な番号順にする。

## 現状

参考章は [`src/cli/references.ts`](../src/cli/references.ts) の `selectReferenceSources` で並べている。
比較関数は第1キーが `sourceType`（primary→secondary）、第2キーが `id` 昇順:

```ts
const SOURCE_TYPE_ORDER: Record<Source["sourceType"], number> = { primary: 0, secondary: 1 };

return picked.sort(
  (a, b) => SOURCE_TYPE_ORDER[a.sourceType] - SOURCE_TYPE_ORDER[b.sourceType] || a.id.localeCompare(b.id)
);
```

このため出力は primary 群（S002, S003, S004 …）→ secondary 群（S001 …）の順になり、
グループ間で番号が前後する。

## 変更内容

### 1. 比較関数を id 一本にする（`src/cli/references.ts`）

```ts
// present かつ verified な claim が参照する source だけを、id 昇順で返す（重複排除）。
// 防御として reachable:"dead" は参考章に出さない（死リンクを焼かない。台帳不整合の検出は verify-artifacts）。
export function selectReferenceSources(claims: Claim[], sources: Source[]): Source[] {
  const citedIds = collectCitedSourceIds(claims);
  const byId = new Map(sources.map((s) => [s.id, s] as const));
  const picked: Source[] = [];
  const seen = new Set<string>();
  for (const id of citedIds) {
    const s = byId.get(id);
    if (s && !seen.has(s.id) && s.reachable !== "dead") {
      seen.add(s.id);
      picked.push(s);
    }
  }
  return picked.sort((a, b) => a.id.localeCompare(b.id));
}
```

### 2. 未使用になる `SOURCE_TYPE_ORDER` を削除

`src/cli/references.ts` の定義（`const SOURCE_TYPE_ORDER ...`）を削除する。
他に参照が無いことを確認した上で消す。

### 3. テストを番号順前提に更新（`tests/cli/references.test.ts`）

現行の「orders primary before secondary, then by id, and dedups」テストは
primary→secondary 順を期待しているので、id 昇順前提に書き換える:

```ts
it("orders by id and dedups", () => {
  const claims = [
    claim({ id: "C001-aaaaaaaa", status: "verified", lifecycle: "present", sourceIds: ["S002", "S001", "S002"] }),
  ];
  const sources = [
    source("S001", { sourceType: "secondary" }),
    source("S002", { sourceType: "primary" }),
  ];
  expect(selectReferenceSources(claims, sources).map((s) => s.id)).toEqual(["S001", "S002"]);
});
```

テスト名（`it(...)` の説明）も「primary before secondary」表現を外す。

## 影響範囲

- `verify-artifacts` は参考ブロックの**台帳一致のみ**を検査し、並び順は強制していない。
  → 公開前ゲートへの影響なし。
- 既存 run への反映は `llm-task-router article:references --run <id>` を再実行するだけ。
  本文の参考ブロック（`<!-- sources:begin -->` 〜 `<!-- sources:end -->`）が id 昇順で再生成される。

### docs の文言更新（必須）

現行仕様を `primary→secondary・id 昇順` と説明している箇所が残っているので、
**「id 昇順」に揃えて更新する**（漏れると仕様とドキュメントが食い違う）。対象は以下の3箇所:

- [docs/qiita-article-howto.md:375](qiita-article-howto.md#L375) — 「primary→secondary・id 順」
- [docs/課題-対策-実装計画-参考リンク.md:36](課題-対策-実装計画-参考リンク.md#L36) — `selectReferenceSources` の説明「primary→secondary・id 昇順で返す」
- [docs/課題-対策-実装計画-インライン出典.md:92](課題-対策-実装計画-インライン出典.md#L92) — `groupCitedSourcesByHeading`（未実装の計画）が `selectReferenceSources` と同じ並びに揃えると記載。コードは未着手だが、揃える先が id 昇順になるので文言も更新する。

## トレードオフ（変更で失われるもの）

- **一次資料を上に出す（primary→secondary）設計意図は失われる。** 信頼度順での提示をやめ、番号順を優先する。
- **「番号順」＝ source 登録順であり、本文中の出現順とは一致しない。**
  S001.. は sources.json への登録順に振られた id なので、読者が本文で出会う順とは限らない。
  「本文出現順」が狙いなら別実装（claims の location でソート）が必要。

## 作業手順

1. `src/cli/references.ts` の比較関数を id 一本に変更し、`SOURCE_TYPE_ORDER` を削除。
2. `tests/cli/references.test.ts` の該当テストを id 昇順前提に更新。
3. `npm test`（vitest）で references / verifyArtifacts のテストが緑であることを確認。
4. docs の文言を「id 昇順」に更新（必須）— `qiita-article-howto.md:375` / `課題-対策-実装計画-参考リンク.md:36` / `課題-対策-実装計画-インライン出典.md:92`。
5. 既存 run は `article:references --run <id>` で再生成。

## 補足: id の文字列ソートで番号順になる根拠

source id は `SOURCE_ID_RE`（`^S\d{3}$`）で3桁ゼロ詰め固定なので、`a.id.localeCompare(b.id)` の
文字列ソートでそのまま番号順（S001 < S002 < … < S010 …）になる。桁あふれ（S999 超）が起きない限り問題ない。
