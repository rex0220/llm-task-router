# 実装計画：シリーズ用語・表記一貫性チェック 第1段（series:check / glossary）

> ステータス: **実装済み**（`feat/series-glossary-check`）。`glossaryMeta` / `SeriesStore.readGlossary`・`glossaryHash`・`writeGlossaryReport` / `seriesCheck`（純関数＋`runSeriesCheck`）/ `series:check` CLI ＋ tests（glossaryMeta・seriesCheck・bin.e2e）＋ auto-approve allowlist。

対象: [docs/series-glossary-consistency-proposal.md](series-glossary-consistency-proposal.md)（v3・Codex レビュー2巡反映）の **層B 第1段**。

この文書は実装計画のみ（コードは含まない）。提案書 §3 / §3.1 / §4 で確定した設計を、既存の series 実装（[SeriesStore](../src/storage/SeriesStore.ts) / [seriesMeta](../src/storage/seriesMeta.ts) / [series CLI](../src/cli/series.ts)）の上に最小スコープで載せる。

---

## スコープ（この段で作るもの / 作らないもの）

### 作る（第1段）
- `series/<slug>/glossary.yaml` の **読み込み・検証**（`terms` / `nouns` のみ）。
- `terms`（用語の preferred/variants）・`nouns`（固有名詞の attributes.location 等）の **段落単位の機械照合**（§3.1）。
- 各メンバーの `final.md` を走査し、**`series/<slug>/series-check-report.json` に検出結果を出力**。
- 最小 CLI: `llm-task-router series:check --slug <slug>`（read-only＋レポート出力。`--no-report` / `--json`）。
- **回帰フィクスチャ**（縄文4本相当の最小 final.md ＋ glossary.yaml）。
- ユニットテスト（validator / 段落分割 / matcher / レポート形）＋ 最小 e2e。

### 作らない（後続の段に送る・提案書 §6 のとおり）
- `numbers`（時期区分の数値照合・正規化）＝第3段。
- `format`（Q&A 体裁）＝第3段。
- 命名規約（G5・slug/topic-file/export 名）＝第2段（`series:status`／`series:validate` 側）。
- `--strict` の**公開前ゲート併記**（completion-report / verify-artifacts への接続）＝第4段。
  - ※ `--strict` 自体（揺れがあれば非ゼロ終了）は第1段に入れてよい（CI で使える最小）。ゲート機構への組み込みだけ後送り。
- LLM 補助（未知の揺れ検出）＝第2段以降。
- glossary 凍結（first-write-wins・`freeze` コマンド）＝任意・後送り。第1段は**未凍結 YAML を読むだけ**。
- `--fix-suggest`（revise 指示の雛形生成）＝第2段（第1段は検出とレポートに集中）。

---

## 設計の確定事項（実装中に揺らさない）

提案書 v3 で決めた点を実装語彙で再掲する。

- **glossary は YAML・正本は `series/<slug>/glossary.yaml`**。パーサは既存依存の `yaml`（[router/config.ts](../src/router/config.ts) / [workflows/profile.ts](../src/workflows/profile.ts) が `import { parse } from "yaml"` 済み）を使う（新規依存なし）。
- **版は2軸**（提案 §3・P1）: `schemaVersion`（形式・必須）と `revision`（内容・任意）。検証は `schemaVersion` を見る。レポートに焼く監査キーは**常に算出できる `glossaryHash`（保存後 UTF-8 の sha256）を主**にし、`revision`/`schemaVersion` は併記。
- **`glossaryHash` は `voiceHash` と同一規則**（[SeriesStore.voiceHash](../src/storage/SeriesStore.ts#L25) ＝ `withTrailingNewline` 後 UTF-8 の sha256 hex）。ただし対象は**読み込んだ生 YAML 文字列**（パース前の原文）にする。パース→再シリアライズの揺れを避け「ファイルそのもの」を監査する（voice.md と同じ「保存後ファイル内容」基準）。
- **照合は read-only**。`series:check` は本文（`final.md`）も `series.json` も**書き換えない**。書くのはレポートだけ（`series:status` の dry-run とは流儀が違う＝提案 §4。既定でレポートを出す。抑止は `--no-report`）。
- **照合対象は「runId があり final.md が読めるメンバー」だけ**。planned（runId=null）や final.md 欠落は**理由付きで skip をレポートに記録**（silent skip 禁止＝CLAUDE.md 原則）。
- **判定は §3.1 の最小仕様に固定**（段落単位・context は OR・コードブロック除外・firstUseAlias 例外）。形態素解析は使わない。**false negative 許容・false positive 最小**。
- **series:check は canonical 9 段に含めない**（`series:*` はシリーズ管理。spec §6 と同じ判断）。run の `progress.events.jsonl` には混ぜず、レポートは `series/<slug>/` に閉じる。
- **事実の正誤は判定しない**（factcheck の責務）。variants は「非推奨側／揺れ側」であって誤りではない（提案 §5）。レポート文言も「揺れ」で統一する。

---

## データモデル（`glossary.yaml`）

`seriesMeta.ts` の validator と同型（破損は空扱いにせず throw・予約キー/安全文字種ガード）。

```yaml
# series/<slug>/glossary.yaml
schemaVersion: 1                # 形式の版（必須）。未知は throw（前方互換を別途設計するまで）
revision: 3                     # 内容の版（任意）
seriesId: jomon-2026            # validateSeriesId（series.json と一致を検証）

terms:
  - preferred: 竪穴建物
    variants: [竪穴住居]
    firstUseAlias: per-article   # per-article（既定）| series-wide | false
    note: 初出のみ別称併記可

nouns:
  - canonical: 三内丸山遺跡
    attributes:
      location:
        preferred: 青森市
        variants: [青森県]
        contextPatterns: [三内丸山遺跡, 所在地, ある, 位置する]
```

> 第1段では `numbers` / `format` キーは**読み飛ばす**（未知キーはエラーにせず無視＝後続段で追加するため前方互換を保つ）。`terms` / `nouns` だけを検証・照合する。

---

## タスク分解

### T1. glossary 型と validator（`src/storage/glossaryMeta.ts`・新規）
- `seriesMeta.ts` を手本に型と検証を置く。
  - 型: `GlossaryData = { schemaVersion: number; revision?: number; seriesId: string; terms: GlossaryTerm[]; nouns: GlossaryNoun[] }`。
    - `GlossaryTerm = { preferred: string; variants: string[]; firstUseAlias: "per-article" | "series-wide" | false; note?: string }`
    - `GlossaryNoun = { canonical: string; attributes: Record<string, GlossaryAttr> }`、`GlossaryAttr = { preferred: string; variants: string[]; contextPatterns: string[] }`
  - `validateGlossaryData(parsed, source)`:
    - 非オブジェクト/配列は throw（`Corrupt glossary.yaml (...)`）。
    - `schemaVersion` 必須・数値。**既知版（=1）以外は throw**（未知の新形式を黙って古いコードで読まない）。
    - `seriesId` は `validateSeriesId`（[seriesMeta.ts:65](../src/storage/seriesMeta.ts#L65)）で**形式だけ**検証する（`series.json` との一致は形を持たない validator では判定できないため T4 で行う・P1）。
    - `terms` / `nouns` は配列（欠落は `[]`）。各要素を検証（`preferred`/`canonical` は非空文字列、`variants`/`contextPatterns` は文字列配列・空可、`firstUseAlias` は既定 `per-article`）。
    - `attributes` のキーは **ASCII の安全キーに固定**（`location` のような `[a-z][a-z0-9_]*` のみ許可。`validateSlug` 相当のガードで `__proto__`/`constructor`/`prototype` を弾く。蓄積は `Object.create(null)` か `Map`）。`所在地` のような非 ASCII キーは**第1段では拒否**する（許すなら別ガードが要る＝将来。軽微指摘）。値は `GlossaryAttr` 検証。
- **完了条件**: 正常 YAML が往復、破損（非配列 terms・未知 schemaVersion・予約キー attribute・非 ASCII attribute キー）が throw、`numbers`/`format` キーは無視されてもエラーにならない。

### T2. glossary の読み込みと hash（`src/storage/SeriesStore.ts` に追加）
- `GLOSSARY_FILE = "glossary.yaml"` を追加（`VOICE_FILE` の隣）。
- `glossaryHash(rawYaml: string)`: `voiceHash` と同一（`createHash("sha256").update(withTrailingNewline(rawYaml), "utf8")`）。**対象はパース前の生 YAML**。
- `readGlossary(slug): Promise<{ data: GlossaryData; hash: string } | null>`:
  - `filePath(slug, GLOSSARY_FILE)` を `readFile`。ENOENT は `null`（glossary 未設定のシリーズ）。
  - 生文字列で hash を取り、`parse`（yaml）→ `validateGlossaryData`。不正 YAML は `Corrupt glossary.yaml (invalid YAML)` で throw（`read()` の JSON 版と同方針・[SeriesStore.ts:78-84](../src/storage/SeriesStore.ts#L78-L84)）。
- `filePath` の既存パスエスケープ検証に乗るので安全性は据え置き。
- **完了条件**: 不在で null、破損で throw、hash が生 YAML に対して安定（末尾改行差で揺れない）。

### T3. 照合エンジン（`src/cli/seriesCheck.ts`・新規・純関数群）
提案 §3.1 を純関数で実装し、I/O から切り離してテストする。

- `splitParagraphs(markdown): Paragraph[]`
  - 空行区切りでブロック化。**見出し行・リスト項目・表セル・コードフェンス内は別段落扱い、コードブロック内は照合対象外**（除外フラグ or そもそも除く）。
  - 既存のコードフェンス判定（[directionCheck の行頭 # 判定](../src/cli/directionCheck.ts) と同じく fenced code block を無視する実装）を参考に、フェンス内を除外。
- `splitSentences(paragraph): string[]`
  - 句点「。」区切り（firstUseAlias の「同一文内」判定用・最小）。
- `matchTerms(paragraphs, terms): TermFinding[]`
  - 各 `variants` の出現を走査。`firstUseAlias` の例外（§3.1）:
    - `per-article`: **その記事で最初の1回だけ**、(a) `preferred` と同一文内に併記、または (b) 括弧内（`（）`/`()`）にある出現は warning なし。
    - 2回目以降・条件外は finding。`series-wide` は呼び出し側で記事順を渡し「シリーズ全体の最初の1記事の初出1回」を許容（第1段はフラグだけ通し、判定は per-article と同経路＋全体カウンタ）。`false` は例外なし。
- `matchNouns(paragraphs, nouns): NounFinding[]`
  - 各 attribute について「**同一段落内に `canonical` または `contextPatterns` のいずれか（OR）**」かつ「**同一段落内に `variants` のいずれか**」が出たら finding。
- finding 共通形: `{ kind: "term" | "noun"; preferred: string; found: string; paragraphIndex: number; snippet: string }`（snippet は前後を切った抜粋。所在の手掛かり）。
- **完了条件**: コードブロック内を拾わない／context OR が効く／firstUseAlias 例外で正しい初出併記が鳴らない／2回目は鳴る。

### T4. メンバー走査とレポート生成（`src/cli/seriesCheck.ts`）
- `runSeriesCheck(slug, { runStore, seriesStore }): Promise<SeriesCheckReport>`
  - `seriesStore.read(slug)`（members）と `seriesStore.readGlossary(slug)` を読む。
  - **glossary 未設定（null）**: `missingGlossary: true` をレポートに立て、members 全 skip（理由 `glossary not configured`）で返す（エラーにはしない＝導入前のシリーズで落とさない）。`--strict` の扱いは T5（missing も exit 1）。
  - **seriesId 一致検証（P1）**: glossary があるとき `glossary.data.seriesId !== series.seriesId` なら **throw**（`glossary.yaml seriesId "<g>" does not match series.json seriesId "<s>"`）。別シリーズの glossary を取り違えて置いた事故を、検出結果がそれっぽく出る前に弾く。T2 の `readGlossary` ではなく `runSeriesCheck` で比較する（series.json を読む文脈がここにあるため）。
  - 各 member:
    - `runId == null`（planned）→ skip（理由 `planned`）。
    - `runStore.read(runId, "final.md")`（[RunStore.read](../src/storage/RunStore.ts#L208)）。ENOENT → skip（理由 `final.md missing`）。
    - 読めたら `splitParagraphs` → `matchTerms`/`matchNouns`。
  - レポート: `{ seriesId, missingGlossary: boolean, glossary?: { hash, schemaVersion, revision? }, checkedAt, members: [{ order, slug, runId, findings, skipped? }], totalFindings }`。
    - `glossary` は未設定時 undefined（`missingGlossary` で判別）。`checkedAt` は ISO 文字列（`new Date().toISOString()`・既存 SeriesStore/RunStore と同じ）。
- `SeriesStore.writeGlossaryReport(slug, report)`（`writeReadme` と同型・`saveText` 利用）→ `series/<slug>/series-check-report.json`（最新を上書き）。**整形は `saveText(slug, REPORT_FILE, JSON.stringify(report, null, 2))` で固定**（2スペース。`series.json` の write と同じ整形で差分を安定させる）。履歴版（`checks/<id>.json`）は将来。
- **完了条件**: planned/欠落が理由付き skip でレポートに残る／findings ゼロでも `checkedAt`＋glossary hash が記録される／**glossary 未設定は `missingGlossary: true`**／**seriesId 不一致で throw**／レポートが `series.json` を書き換えない。

### T5. CLI 配線（`src/index.ts`・`series:status` を手本に）
- `program.command("series:check")`:
  - `--slug <slug>`（必須）、`--no-report`（レポート抑止）、`--json`（stdout に JSON）、`--strict`（findings>0 で exit 1）、`--allow-outside-workspace`（既存と同様）。
  - `assertArticleWorkspace` を通す（[series:status と同じ](../src/index.ts#L313)）。
  - `runSeriesCheck` を呼び、`--no-report` でなければ `writeGlossaryReport`。
  - 既定出力（非 json）: メンバーごとに `[order] slug: N findings (or skipped: reason)` を1行、末尾に合計。glossary 未設定なら `glossary not configured` を明示。`--json` は report をそのまま stdout（修復・補助メッセージは stderr へ＝series:status の流儀・[index.ts:342](../src/index.ts#L342)）。
  - **`--strict` の終了コード（P2）**: `totalFindings > 0` **または `missingGlossary === true`** で `process.exitCode = 1`。「glossary 未設定なのに CI が通る」を防ぐ（導入期に `--strict` を付けなければ従来どおり成功）。missing で落ちたときは stderr に「glossary.yaml を置くか --strict を外す」と理由を出す。
- **完了条件**: read-only（再実行で diff なし・レポート除く）／`--no-report` でファイル不生成／`--strict` は findings>0 と missingGlossary の両方で exit 1。

### T6. 回帰フィクスチャ（`tests/fixtures/series-glossary/`）
`runSeriesCheck` は `seriesStore.read(slug)`＋`runStore.read(runId, "final.md")` を引くので、**final.md と glossary だけでなく `series.json` と run ディレクトリ構成が要る**（P2）。テストは tmp ディレクトリに次の木を組んでから `SeriesStore(seriesRoot)` / `RunStore(runsRoot)` を向ける。

```text
<tmp>/
├─ series/jomon-2026/
│  ├─ series.json        # seriesId: jomon-2026 / members[]（order・runId・status）
│  └─ glossary.yaml      # terms(G1) ＋ nouns(G2)。seriesId は series.json と一致
└─ runs/
   ├─ 2026-06-23-jomon-1/{meta.json, final.md}   # 竪穴建物・青森市（鳴らない正例）
   ├─ 2026-06-23-jomon-2/{meta.json, final.md}   # 竪穴住居・三内丸山遺跡は青森県（鳴る）
   ├─ 2026-06-23-jomon-3/{meta.json, final.md}   # 竪穴住居（うち1つは正しい初出併記＝鳴らない）
   └─ （planned 枠）members に runId:null を1件入れて skip 理由 `planned` を固定
```

- `series.json` は `validateSeriesData` を通る最小（`version`/`seriesId`/`profile`/`voice`/`members`）。`meta.json` は `readMeta`/`RunStore.read` が通る最小（`runId`/`series.seriesId` 等）。
- 本文の対照ケース:
  - G1: jomon-1 `竪穴建物`（preferred のみ＝鳴らない）/ jomon-2・3 `竪穴住居`（鳴る）/ jomon-3 に「竪穴建物（竪穴住居）」の初出併記＝**firstUseAlias 例外で鳴らない**。
  - G2: jomon-1「青森市」/ jomon-2「…三内丸山遺跡は青森県に…」（同一段落に canonical＋variant＝鳴る）。
  - 鳴らない対照: コードブロック内に `竪穴住居`（除外確認）／canonical と variant を別段落に置く（context OR が同一段落限定＝false negative 許容の確認）。
  - **glossary 未設定ケース**: glossary.yaml を置かないシリーズも1つ用意し、`missingGlossary: true`＋`--strict` exit 1 を固定。
  - **seriesId 不一致ケース**: glossary.yaml の seriesId を別値にして throw を固定（P1）。
- 実記事の run は使わず、検出仕様を固定する最小版（提案書「4本を回帰フィクスチャに」の縮約）。

### T7. テスト
- `tests/storage/glossaryMeta.test.ts`: validator 往復・破損・未知 schemaVersion・予約キー・**非 ASCII attribute キー拒否**・`numbers`/`format` 無視。
- `tests/cli/seriesCheck.test.ts`: `splitParagraphs`（コードブロック除外）/ `matchTerms`（firstUseAlias 例外・2回目検出）/ `matchNouns`（context OR）/ `runSeriesCheck`（planned・final 欠落の理由付き skip・**glossary 未設定で `missingGlossary:true`**・**seriesId 不一致で throw**・hash 記録）。
- `tests/cli/bin.e2e.test.ts`（既存に追記）: フィクスチャで `series:check --json` を実行し、findings 件数・skip・exit code を固定（`--strict` は **findings>0 と missingGlossary の両方**で 1）。

---

## 影響範囲・互換性
- **新規追加が中心**（`glossaryMeta.ts` / `seriesCheck.ts` / `series:check` コマンド）。既存の series 工程（create/status/plan/export）には触れない。
- `SeriesStore` への追加は新メソッドのみ（`readGlossary` / `glossaryHash` / `writeGlossaryReport` / `GLOSSARY_FILE`）。既存 read/write・voice 系は不変。
- glossary.yaml が無いシリーズは従来どおり動く（`series:check` は「未設定」を明示して空チェック）。
- canonical 工程数・`article:status`・verify-artifacts・completion-report は**不変**（series:check は canonical 外）。

## 着地順（silent drop / 取り違え防止）
1. **T1（validator）を最初に**。`terms`/`nouns` を保持する検証を、照合（T3/T4）より先に着地させる（seriesMeta の着地順と同型＝validator が落とすと後段が空回りする）。
2. T2（読み込み・hash）→ T3（純関数 matcher）→ T4（走査・レポート）→ T5（CLI）→ T6/T7（フィクスチャ・テスト）。
3. CLI（T5）は最後。配線前に純関数とレポート形をテストで固定しておく。

## 未解決（第1段で決め切る小さな点）
- `splitSentences` の文末記号は「。」のみで足りるか（見出し・箇条書きは別段落なので句点が無い行が多い）。**最小は「。」＋段落末**で開始し、取りこぼしは false negative 許容で受ける。
- `snippet` の長さ（前後何文字か）。レポート可読性の調整のみ＝既定 40〜60 字程度で開始。
- `series:check` を `series:status` に統合するか独立コマンドにするか → **独立**（提案 §4.1 で本文系と命名系を混ぜない方針。status は命名系の将来拡張先）。

---

## 付録: Codex レビュー反映ログ（2026-06-25・実装計画 第1巡）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| glossary の `seriesId` と `series.json.seriesId` の一致検証がタスクに無い（別シリーズの glossary 取り違え事故） | P1 | T1 を「validator は形式のみ」に明記し、**T4 `runSeriesCheck` で `glossary.seriesId !== series.seriesId` を throw**。完了条件・T7・T6 に不一致ケースを追加 |
| glossary 未設定時と `--strict` の関係が未定（未設定でも CI が通る） | P2 | レポートに `missingGlossary: boolean` を追加（T4）。**`--strict` は findings>0 または missingGlossary で exit 1**（T5）。T6/T7 に未設定ケース |
| フィクスチャに `series.json`＋run ディレクトリ構成が必要 | P2 | T6 を tmp ディレクトリ木（`series/<slug>/series.json`＋`runs/<runId>/{meta.json,final.md}`＋planned 枠）に具体化 |
| `attributes` キーを ASCII に固定する方針を明記 | 軽微 | T1 で `[a-z][a-z0-9_]*` のみ許可・非 ASCII（`所在地`）は第1段拒否（許すなら別ガード＝将来） |
| `writeGlossaryReport` の整形 JSON を固定 | 軽微 | T4 で `JSON.stringify(report, null, 2)`（2スペース・series.json と同整形）に固定 |
