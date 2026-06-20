# claims / sources スキーマ設計メモ（P3a・先行ゲート）

- 位置づけ: [claude-editor-improvement-plan.md](claude-editor-improvement-plan.md) Phase 3a の成果物。**P3b（factchecker 出力規約）／ P5（verify-artifacts）／ P6（差分再検証）はこの定義を参照する**。
- 目的: `claims.json` / `sources.json` を「後から運用が崩れない」粒度で固定する。スキーマ案そのものは [claude-editor-improvement-spec.md](claude-editor-improvement-spec.md) #3、本メモは **id 安定性・location・status 遷移・検証責任の所在** の4点の運用判断を確定する。
- 参照実装: editorial-review の weakness 台帳（`src/workflows/editorialReview.ts` の `weaknessHash` / `EditorialLedger` / `mergeFound`）。claims はこれを踏襲する。

## 決定サマリ

| 論点 | 決定 |
| --- | --- |
| id 安定性 | `CNNN-<hash8>` を `claims-ledger.json` で所有（editorial-ledger 方式の踏襲） |
| hash の対象 | **claim 文のみ**（`hash = anchorHash = sha256(normalize(claim))[:8]`）。type/heading/severity/status/note は可変メタ＝hash に含めない |
| hash の採番者 | **コード**が採番（agent は id を付けない idless raw を出す） |
| location | `heading` は補助スナップショット、`anchorHash`（=claim hash）が再同定の主キー。**heading は hash に含めない** |
| 二軸の状態 | `status`（検証: unverified/verified/needs-source/incorrect）と `lifecycle`（在否: present/removed）を**分離** |
| blocking（ゲート fail） | `lifecycle=present` かつ `severity∈{critical,major}` かつ `status∈{unverified,needs-source,incorrect}`。`removed` と `verified`/minor 以下は数えない |
| source 参照 | raw は `sourceRefs`（URL/一時キー）、normalize が `sources.json` の `SNNN` に変換して `sourceIds` を生成。**SNNN の主キーは正規化 URL の hash**（raw `key` ではない） |
| 検証責任 | 生成=factchecker / 採番・台帳・zod検証=コード / Web取得=agentのみ（CLIは持たない） |

---

## 1. id 安定性 — `CNNN-<hash8>` を台帳で所有

editorial-review と同じ二層構造にする。

- **安定アンカーは claim 文の内容 hash のみ**。`hash = anchorHash = sha256(normalize(claim))[:8]`。`normalize` は editorial と同様 `\s+→" "` で潰し `trim`。**hash の対象は `claim`（主張文）だけ**にする。`type`・`heading`・`severity`・`status`・`note`・`sourceIds` は可変メタで、変わっても同一 claim とみなす（type 再分類や見出し移動で別 claim になってはならない）。
  - → finding 反映: 以前は `[type, location.heading, claim]` を hash 対象としていたが、それだと**見出し変更だけで別 claim**になり anchorHash の目的（見出しズレに強い追跡）と矛盾する。claim 文のみに修正。
- **表示 id は `CNNN-<hash8>`**。`claims-ledger.json` が `lastSeq` と `claims[]` を所有し、同一 hash の再出現は既存 id を再利用、新規だけ採番（`mergeFound` 相当）。**台帳から物理削除はしない**が、**今回の `claims.raw.json`（＝current observed set）に対応 hash が無い** claim は `lifecycle: "removed"` に落とす（`closeMissing` 相当。§3 参照）。`status` は最後の値を保持しつつ、`removed` は blocking から外れる。

```jsonc
// claims-ledger.json（run 内・コードが所有。claims と sources を1ファイルで持つ）
{ "round": 0, "lastSeq": 0, "lastSourceSeq": 0,
  "claims": [ { "id": "C001-a1b2c3d4", "hash": "a1b2c3d4", "lifecycle": "present",
    "firstRound": 1, "lastRound": 1, /* ...claim本体（status/severity/sourceIds/location...）... */ } ],
  "sources": [ { "id": "S001", "urlHash": "e5f6a7b8", "url": "https://...", /* title/retrievedAt/sourceType/summary */ } ] }
```

### 重要な含意 — 採番は「コード」が持つ（agent は idless raw を出す）

editorial-review の id は **パイプライン（CLI）が normalize 時に採番**しており、モデル生出力には id が無い（`EditorialReviewSchema` 参照）。理由は明快で、**LLM/agent に sha256 を決定的に計算させるのは不安定**だから。claims も同じ制約を受ける。

したがって採番の所在を次のように分ける:

- **P3b（agent 出力規約）**: factchecker は **id 無しの raw**（`claims.raw.json` / `sources.raw.json`）を出す。
  - raw claim: `claim`（主張文）, `location.heading`, `type`, `status`, **`sourceRefs`（URL か `sources.raw.json` 内の一時キー）**, `severity`, `note`。hash・id・`anchorHash`・`sourceIds` は付けない。
  - raw source: `key`（**その raw 内だけの結合ラベル**。raw claim の `sourceRefs` が参照する）, `url`, `title`, `retrievedAt`, `sourceType`, `summary`。`id`（SNNN）は付けない。
  - → finding 反映: raw は idless なので、raw claim が正規化後の `S001` を参照できない。raw では URL/一時キー（`sourceRefs`）で繋ぎ、normalize が `SNNN` を採番して `sourceIds` に変換する。
- **観測範囲 `scope` は normalize の CLI フラグで渡す**（agent にメタ欄を覚えさせない）。`claims-normalize --scope full|diff`（既定 full）。呼び手の編集長が全文 factcheck か P6 差分集中かを知っているので、raw 自体はラッパ不要の素直な配列（`claims.raw.json` / `sources.raw.json`）のまま。`scope=full` のときだけ normalize が `closeMissing`（→`removed`）を走らせ、`diff` では観測外の claim を removed にしない。
- **source の安定主キーは正規化 URL の hash**（raw の `key` ではない）。`urlHash = sha256(canonicalUrl)[:8]`。`canonicalUrl` は scheme 小文字化・既定ポート除去・トラッキングクエリ（utm_* 等）除去・末尾スラッシュ正規化・fragment 除去まで施した形。`SNNN` はこの `urlHash` を主キーに `claims-ledger.json` の `sources[]` が所有し、同一 URL の再出現は既存 `SNNN` を再利用する（agent が `key` を毎回揺らしても ID は安定）。`key` は **claim↔source の raw 内結合にしか使わない**（安定 ID の素材にしない）。
- **採番・台帳化（コード）**: idless raw → `claims-ledger.json` 反映 → `claims.json` / `sources.json`（id 付き公開ビュー）を生成する小さな**正規化ステップ**。これは editorial の `finalize`/`mergeFound` と同型。同時に (a) source の正規化URL hash→`SNNN` 採番、(b) claim の `sourceRefs`→`sourceIds` 変換、(c) `anchorHash` 算出、(d) 今回 raw を current observed set として `lifecycle` 更新、を行う。

> **プランへの含意（要確認）**: 「stable id ＝ コード採番」を採ると、claims の id 安定化は **コードが要る** = P5（CLI）の射程に入る。P3b 単独（agent 規約だけ）では idless raw までしか固められない。
> 対応案A（推奨）: P3b は idless raw の規約までを担当し、`claims-normalize`（raw→ledger→claims.json）を **P5 verify-artifacts と同じ CLI 追加**に含める（verify は normalize 後の claims.json を検証）。
> 対応案B: agent に簡易連番（C001..）だけ振らせ、安定 hash は後付け。→ P6 の差分追跡が弱くなるため非推奨。
> このメモは A を前提に P3b / P5 を記述する。

## 2. location — 見出しスナップショット ＋ `anchorHash`

改稿で見出しがズレる前提に立ち、location を二重に持つ。

```jsonc
"location": {
  "heading": "## 設計方針",     // 検証時点のスナップショット（人間可読・補助）
  "anchorHash": "a1b2c3d4"      // claim 文（正規化）の hash。再同定の主キー
}
```

- **再同定は `anchorHash` 主**。改稿後に見出しが変わっても、claim 文が実質同一なら hash 一致で追跡できる。`heading` は人が読むための補助で、ズレても致命傷にしない。
- P6（差分再検証）では `changed-sections.json` の見出しを地図に使うが、claim の所属判定は heading 文字列一致に依存せず、まず anchorHash、補助的に heading で寄せる。
- claim 文が実質改稿された（hash が変わった）場合は **別 claim** として新規採番されるのが正しい（主張が変わった＝再検証対象）。

## 3. 二軸の状態（status × lifecycle）と blocking の定義

検証の進み具合（`status`）と、その claim が今も本文に在るか（`lifecycle`）は**別軸**にする。両者を混ぜると「本文修正で消した誤り claim が `incorrect` のまま公開ゲートを永久に塞ぐ」事故が起きる（finding 反映）。

**status（検証）** — normalize/factchecker が更新:
```
unverified（初期）
  ├─ verified       … 一次/二次情報で裏取りOK（sourceIds 必須）
  ├─ needs-source   … 真偽は不明だが要出典。出典が付けば verified へ
  └─ incorrect      … 誤り。revise で本文修正して再検証 → verified、または本文から削除 → lifecycle:removed
```

**lifecycle（在否）** — normalize が **今回の `claims.raw.json` を current observed set として台帳と突き合わせて**機械更新（`final.md` を直接走査して anchorHash を探すのではない。hash の素材＝claim 文は raw にしか無い）:
```
present（今回の raw に同一 anchorHash の claim が在る） / removed（台帳にはあるが今回の raw に無い＝本文から消えた。台帳には残すが blocking から外す）
```
- **`removed` 判定は全文 factcheck（独立フル観測）でのみ行う**。差分集中の再検証（P6, update-diff 起点）は観測範囲が部分的なので、raw に無いことを以て `removed` にしてはならない（editorial の `closeMissing` が独立フル読み時だけ走るのと同型）。この区別は `claims-normalize --scope full|diff`（既定 full）で normalize に伝える。

- `severity`: `critical | major | minor | suggestion`（editorial や build-verify と統一）。
- **blocking の定義（verify-artifacts / publication-check が参照する公開前ゲート条件）**:
  `lifecycle = present` **かつ** `severity ∈ {critical, major}` **かつ** `status ∈ {unverified, needs-source, incorrect}`。
  - これが1件でも残る run は `verify-artifacts` で **fail**（warning ではない。公開前ゲートで未検証/未解決の重大 claim を通さない）。
  - `unverified`（未着手）も critical/major なら fail に含める＝「検証していない重大主張」を公開させない（finding 反映: warning か fail かを fail に固定）。
  - `verified` / `minor` 以下 / `lifecycle = removed` は blocking に数えない。
- `removed` claim は監査のため台帳に残すが、公開判断には影響しない。誤って removed 判定されても、本文に戻れば次回 normalize で `present` に復帰する（anchorHash 一致で id も復活）。

## 4. 検証責任の分界 — 「取得は持たない／検証は持つ／採番もコード」

| 行為 | 担当 | 備考 |
| --- | --- | --- |
| Web 取得・真偽判断・出典収集 | **article-factchecker（agent のみ）** | CLI は Web fetch を一切持たない（安全方針） |
| idless raw（claims/sources）の生成 | article-factchecker | hash/id/anchorHash/sourceIds は付けない。source は `sourceRefs`（URL/key）で繋ぐ |
| `SNNN`（主キー=正規化URL hash）/`CNNN-<hash8>` 採番・`sourceRefs→sourceIds` 変換・`anchorHash` 算出・`lifecycle` 更新・`claims-ledger.json` 維持 | **コード（CLI normalize ステップ）** | 決定的処理は LLM に渡さない |
| zod スキーマ検証 | **コード（verify-artifacts, #5）** | 下記の zod 固定方針 |

### zod 固定方針（P5 実装の要所）

`src/schemas/` の流儀（editorial 系と同じ）で固定する:

- `claims.json`: `id` は `/^C\d{3}-[0-9a-f]{8}$/`、`type` enum、`status` enum（unverified/verified/needs-source/incorrect）、`lifecycle` enum（present/removed）、`severity` enum、`sourceIds: string[]`（`/^S\d{3}$/` の sources id 参照）。`location` は `{ heading: string; anchorHash: string }`。
- `claims.raw.json`（factchecker 出力）: 上記から `id`・`anchorHash`・`lifecycle`・`sourceIds` を除き、代わりに `sourceRefs: string[]`（URL か raw source の `key`）を持つ idless 形。
- `sources.json`: `id`（`/^S\d{3}$/`）、`url` は `z.string().url()`、`retrievedAt` は日付、`sourceType` enum。台帳側は `urlHash`（正規化 URL hash＝SNNN の安定主キー）も持つ。`sources.raw.json` は `id` の代わりに `key`（raw 内結合ラベル）。
- **build-verify-report.json も同時に zod 固定**（前回レビューの残リスク反映）: `skipReason` は `status:"skipped"` のとき非空を `.refine()`／`discriminatedUnion` で条件付き必須、`checkedBlocks[].result` enum、`unverified` の形を固定。verify-artifacts はこの zod を検証器として使う。

## 未決事項（P5 設計時に潰す）

- `claims-normalize` を独立コマンドにするか、`verify-artifacts` の前段に内包するか。→ 暫定: verify-artifacts は normalize 済み `claims.json` を要求し、normalize は別の軽量コマンド（`article:claims-normalize`）に切る方が責務が綺麗。P5 設計時に確定。
- **`canonicalUrl` 正規化の細部は P5 で fixture テストに固定する**（後で揺れないように）。最低限カバー: `utm_*`／トラッキングクエリ除去、fragment 除去、末尾スラッシュ、既定ポート（:80/:443）除去、**クエリパラメータ順序の正規化**（ソート）、scheme/host 小文字化。これらが `urlHash` の安定性（＝`SNNN` 再利用）を左右する。

## 決定済み（参考）

- claim→source の参照: **raw は `sourceRefs`（URL/一時 key）、normalize 後の公開ビューは `sourceIds`（`SNNN`）**。spec #3 の `sourceIds` は normalize 後の形を指す。
- `SNNN` の安定主キーは **正規化 URL の hash**（`urlHash`）。raw の `key` は raw 内結合専用で安定 ID の素材にしない。
- `lifecycle` の入力は **今回の `claims.raw.json`（current observed set）**。`final.md` 直接走査ではない。`removed` 判定は `claims-normalize --scope full` 時のみ。
- hash 対象は **claim 文のみ**（`anchorHash` と id の hash8 は同一値）。heading/type/severity/status は hash に含めない。
- 二軸: `status`（検証）と `lifecycle`（present/removed）。blocking は present かつ critical/major かつ status∈{unverified,needs-source,incorrect} で **fail**。
