# シリーズ横断の用語・表記一貫性チェック 対策案

> ステータス: ドラフト（v3 / Claude 起案・Codex レビュー2巡反映） / 対象: llm-task-router series 機能
> 最終更新: 2026-06-25
> 関連: [series-spec.md](series-spec.md) 課題 C4（voice 逸脱の検出）, [editorial-review-spec.md](editorial-review-spec.md)

> **本書の対象範囲（今回）**: **層B（構造的対策＝再発防止）に絞る**。層A（既存4本の即時修正）は**今回は対象外**（別タスクとして後送り）。以下、層A の節は参考として残すが、本書の実装スコープには含めない。

## 0. きっかけ（Claude による縄文シリーズのレビュー）

公開済みの縄文時代シリーズ4本を Claude がレビューしたところ、**1記事だけ見れば問題ないが、シリーズで並べると破綻する**横断の表記揺れが複数見つかった。

- 第1回（概説）: https://qiita.com/rex0220/items/dd1cca50b3a91062162e
- 第2回（縄文人とは誰か）: https://qiita.com/rex0220/items/611f32aee3ccb5beb7a3
- 第3回（縄文海進＋鬼界アカホヤ）: https://qiita.com/rex0220/items/db7a0c540edd684bf7b7
- メタ記事（series 機能）: https://qiita.com/rex0220/items/71b3a20054c12d74da66

事実面は各記事の factcheck がよく効いており大きな穴は無い。**残る品質課題は実質「横断の一貫性ならし」**で、これはちょうど開発中の series 機能が担うべき守備範囲（spec 目的の「文体・用語・世界観を共有」のうち**用語**が未実装）。本書はこの揺れへの対策を、①即時の手当てと②構造的対策（再発防止）の二層で定義する。

## 1. 検出された揺れ（実例＝回帰テストのフィクスチャ）

レビューが挙げた具体例。いずれも「同一シリーズ内で精度・用語・形式がブレている」もの。

| # | 種別 | 揺れ | 第1回 | 第2回 | 第3回 | 望ましい正 |
|---|---|---|---|---|---|---|
| G1 | 用語 | 竪穴建物 / 竪穴住居 | **竪穴建物** | 竪穴住居 | 竪穴住居 | 要決定（後述） |
| G2 | 固有名詞・所在地 | 三内丸山遺跡の所在地 | 青森**市** | 青森**県** | — | 青森市 |
| G3 | 数値（時期区分） | 縄文中期の終端年代 | 〜約4200年前 | 〜約4000年前 | — | glossary で一元化 |
| G4 | 形式 | Q&A の体裁 | `###` 疑問形見出し＋地の文 | `**Q.**`/`A.` インライン | `**Q.**`/`A.` インライン | 要決定（後述） |
| G5 | 命名（メタ記事/運用） | member-slug のプレフィックス | `jomon-1〜4` | — | — | `jomon-` で統一 |

補足:
- **G1（竪穴建物/竪穴住居）**: 近年の考古学では「住居とは限らない」を理由に**竪穴建物**が標準化しつつある。つまり第1回の用語選択のほうが新しい。揺れの解消は「第1回に寄せる（竪穴建物を正とし初出で別称を併記）」が妥当。
- **G2（青森県/青森市）**: 県でも誤りではないが精度が落ちる。固有名詞は最も機械判定しやすい（完全一致）ので glossary の第一候補。
- **G3（中期の終端）**: 草創期〜晩期の境界年代は記事ごとに端数がブレやすい。時期区分は glossary.yaml で境界を一括定義するのが最有力。
- **G4（Q&A 形式）**: 第1回だけ構造が違う。voice.md の「小見出しは疑問形で統一」とも絡むため、**Q&A を見出し方式に寄せるか Q/A インラインに寄せるか**を決めて voice 側に固定する。
- **G5（slug プレフィックス）**: メタ記事内で `crafts`/`ritual` と `jomon-crafts.txt`（topic-file）が割れている。**これは本文（`final.md`）の表記揺れではなく `members[].slug` / topic-file / export 名の命名規約の揺れ**なので、`final.md` を走査する `series:check` では拾えない。**検出は `series:status`／`series:validate` 側の責務**に分ける（§4.1）。実データ側を `jomon-crafts`/`jomon-ritual` に揃える。

> G1〜G4 は「単記事では正常／並べると破綻」という、本文を走査する `series:check` の典型例で、**この4本はそのまま `series:check` の回帰テスト用フィクスチャになる**。G5 は本文の外（命名規約）なので守備範囲が別（§4.1）。

## 2. 対策の二層

### 層A: 即時の手当て（既存シリーズの揺れを直す）｜**今回は対象外（後送り）**

> ⚠ **本書のスコープ外**。層A は別タスクとして後で行う。以下は将来着手時の手順の覚書として残す（実装スコープには含めない）。

機能実装を待たず、現行のパイプラインで今すぐ直せる。**`final.md` を直接編集しない**（CLAUDE.md 原則）。各記事を `article:revise --instruction-file` で戻す。

1. **正の決定（編集長＝人が決める）**:
   - G1: 「竪穴建物」を正とする（初出のみ「竪穴住居とも呼ばれる」を併記）。
   - G2: 「青森市」に統一。
   - G3: 中期の終端を一つの数値に決める（例: 約4200年前。境界の根拠ソースを factcheck で確認）。
   - G4: Q&A を一方式に統一（voice.md の疑問形方針に合わせるなら第2/3回を見出し方式へ、簡潔さを採るなら第1回を Q/A インラインへ）。
2. **revise で反映**: 揺れている記事だけに修正指示を出す（差分集中）。
3. **本文を変えたら必ず factcheck-scope を回す**（CLAUDE.md 原則。手動 skip で証跡を飛ばさない）。
   - **stamp の順序を取り違えない**（CLAUDE.md: `factcheck-stamp --accepted-after factcheck` は factcheck **後** の baseline 受理用＝信頼状態を変えるので factcheck 前に打たない）。
   - 用語の言い換え・所在地の精緻化は**事実の変更を伴う**ため、差分が非事実とは限らない。**G2/G3 は `factcheck-scope` の判定（`full|diff`）に従って factcheck を実施し、その後に `factcheck-stamp --accepted-after factcheck` で再受理する**（先に stamp しない）。
   - G1/G4 のうち純粋な体裁・別称併記に留まる差分（事実不変）は `--accepted-after non-factual-diff` で stamp する（カテゴリを取り違えない）。
4. **editorial で揺れの解消を確認**: 編集レビューで横断の一貫性観点を確認し、`editorial-resolve` で台帳に閉じる。
5. **再 export ＋ record-publication**: 公開済みなので `/update-article` 経路（import 起点・差分集中）で、ユーザー承認後に同一 URL を更新する。

> 即時修正（層A）だけでは**再発する**（次のシリーズで同じ種類の揺れが起きる）。再発防止の本丸が層B＝本書の対象。

### 層B: 構造的対策（再発防止＝series-aware チェック）

シリーズ単位で**用語・固有名詞・数値・形式の正**を1か所に固定し、各メンバーの本文を機械照合する。spec 課題 C4（voice 逸脱の検出）の具体化で、対象を「文体」から「用語・表記」に絞った最小実装。

- **正本**: `series/<slug>/glossary.yaml`（シリーズ container 配下。`voice.md` と同じ層）。
- **照合（本文）**: `llm-task-router series:check <slug>`（各メンバーの `final.md` を glossary に照合し、本文内の用語・数値・形式の揺れを列挙）。
- **照合（命名規約）**: `members[].slug` / topic-file / export 名のプレフィックス整合（G5）は `final.md` の外なので **`series:status`／`series:validate` の責務**に分ける（§4.1）。本文系と命名系をひとつのコマンドに混ぜない。
- **位置づけ**: canonical 9 段には**含めない**（`series:*` はシリーズ管理であって記事生成工程ではない＝spec §6 と同じ判断）。正確性ゲートでもない（factcheck が事実、glossary は用語・表記の一貫性）。

## 3. `glossary.yaml` スキーマ案

`voice.md`（蒸留した文体）と役割を分離する。voice は「どう書くか（トーン・人称・語彙の癖）」、glossary は「**この語をこう書く／この数値で揃える**」の固定辞書。

```yaml
# series/<slug>/glossary.yaml
schemaVersion: 1                # ファイル形式の版（互換判定用・内容が変わっても増えない）
revision: 3                     # 内容の版（編集のたびに +1。凍結時は freeze 印と対応）。任意
seriesId: jomon-2026

# 用語の正規化（preferred を正とし、variants を揺れ側として検出）
terms:
  - preferred: 竪穴建物
    variants: [竪穴住居]        # 検出したら preferred への寄せを提案
    note: 初出のみ「竪穴住居とも呼ばれる」を併記してよい
    firstUseAlias: per-article   # 別称併記の許容範囲（許容条件は §3.1）

# 固有名詞（canonical だけでは検出できない。variants＋context で「非推奨の出現」を拾う）
nouns:
  - canonical: 三内丸山遺跡
    attributes:
      location:
        preferred: 青森市
        variants: [青森県]                       # 非推奨側＝揺れ側（検出対象。誤りとは判定しない＝§5）
        contextPatterns: [三内丸山遺跡, 所在地, ある, 位置する]  # 同一段落にこのいずれか＋variant で検出（§3.1）
  - canonical: 鬼界カルデラ       # 地形
    note: 噴火事象は「鬼界アカホヤ噴火」と書き分ける（混同検出）

# 数値（時期区分の境界などを一元定義）
# ※ 本文の数値出現を機械照合するには「どの出現が key の値か」を絞る必要があるため、
#   value だけでなく variants（揺れ表記）と context（近傍語）を早めに持たせる（第3段で正規化と併用）。
numbers:
  - key: 縄文中期
    value: { from: 約5000年前, to: 約4200年前 }
    variants: [約4000年前]                       # 終端の揺れ側（検出対象）
    context: [縄文中期, 中期, 終わり, ごろ]         # 同一段落にこのいずれか＋variant で検出（§3.1）
    note: 終端は約4200年前で統一（4000年前と揺れていた）
  - key: 三内丸山の存続
    value: { from: 約5900年前, to: 約4200年前 }
    context: [三内丸山, 前期, 中期, 存続]

# 形式（章構成・見出しの体裁）
format:
  qa: heading-question            # heading-question | inline-qa のいずれかに統一
  # heading-question: ### 疑問形見出し＋地の文（voice の疑問形方針と整合）
```

設計上の固定点（spec の流儀に合わせる）:

- **版は2軸に分ける（P1）**: `schemaVersion`（ファイル形式の版・互換判定用）と `revision`（内容の版）を別フィールドにする。`revision` は任意で、凍結しないシリーズでは省略可。レポートに焼くのは**常に算出できる `contentHash`（保存後 UTF-8 の sha256）を主**とし、`revision`/`schemaVersion` は併記（あれば）。これで「凍結が任意＝内容版が無いケース」でも監査キー（hash）が必ず付く。
- **glossary も first-write-wins で凍結**できる（`series:freeze-voice` と同様に `frozen`/`revision`/`contentHash`/`history[]` を持つ）。ただし用語は文体ほど不変ではないため、**既定は「未凍結＝追記更新可、凍結は任意」**とする（voice より緩い）。`contentHash` の算出は voice.md と同じ helper（保存後 UTF-8 の sha256）を流用。
- **`runs/` の外**（`series/<slug>/glossary.yaml`）に置く（spec F2＝run ディレクトリと独立）。
- **YAML スキーマは安全文字種ガード＋プロトタイプ汚染対策**を `series.json` と同様に通す（spec 課題 C1 に相乗り）。

### 3.1 照合判定の最小仕様（context / firstUseAlias）

実装者が迷わないよう、第1段の判定を**段落単位**に固定する（文字数の「近傍」や AND/OR の解釈を実装依存にしない）。

- **段落の定義**: Markdown の空行区切りブロック（見出し・リスト項目・表セル・コードブロックは別段落扱い。**コードブロック内は照合対象外**）。
- **nouns / numbers の検出（context は OR）**: 「**同一段落内**に `canonical` または `contextPatterns`/`context` の**いずれか1つ以上**（OR）があり、**かつ同一段落内**に `variants` のいずれかが出現したら検出」。context を AND にしない（取りこぼし防止／最小実装の確度優先）。
- **terms の検出と `firstUseAlias` の例外（P2-4）**: `variants` の出現は原則すべて検出対象。ただし `firstUseAlias` が `per-article` のとき、**各記事で最初の1回だけ**、次のいずれかを満たす出現は **warning を出さない**（正しい初出併記とみなす）:
  - `preferred` と**同一文内**に併記されている（句点「。」区切りで同一文）、または
  - **括弧内**（`（）`/`()`）に置かれている（例: 「竪穴建物（竪穴住居）」）。
  - 2回目以降の `variants` 出現、および上記条件を満たさない初出は検出する。`series-wide` は「シリーズ全体で最初の1記事の初出1回」に絞る（将来）。`false` は例外なし。
- **判定は機械照合（正規表現）のみ**（第1段）。形態素解析は使わない（依存を増やさない）。曖昧な近接（段落をまたぐ照応など）は取りこぼしてよい＝**false negative 許容・false positive 最小**の方針（誤検出で正しい本文に毎回引っかかる方が運用コストが高いため）。

## 4. `series:check` の挙動案

```
llm-task-router series:check <slug> [--fix-suggest] [--strict] [--no-report]
```

- **既定は read-only（本文・`series.json` を変更しない）＋レポート出力**。各メンバーの `final.md` を走査し、glossary の各カテゴリに対して揺れを列挙する。
  - ここでの "dry-run" は **`series:status` の dry-run（既定では何も書かない）とは流儀が違う**点を明記する（混同回避＝P2）。`series:check` の既定は「**入力（本文・series.json）は不変だがレポートは書く**」。レポートは検出の成果物そのものなので既定で出す。レポートも書きたくない場合は **`--no-report`** で抑止する（CI で標準出力だけ使う用途）。
- 出力は「どの記事の・どの語が・正は何か」を**証跡として残す**（silent skip 禁止の原則。揺れゼロでも「checked」を記録）。**保存先は `series/<slug>/series-check-report.json`（最新を上書き）**を最小とし、履歴を残すなら `series/<slug>/checks/<runId or 連番>.json` に追記する（series は canonical 9 段外なので run の `progress.events.jsonl` には混ぜない）。レポートには対象メンバー・検出件数・各揺れの所在に加え、**照合に使った glossary の `contentHash`（主）＋ `revision`/`schemaVersion`（あれば）を記録**（§3 の版2軸。`--strict` を CI に入れた段階の監査用）。
- **`--fix-suggest`**: 検出箇所に対する revise 指示の雛形を出す（自動で本文は変えない＝`final.md` 直接編集禁止に従い、revise 経由を促すだけ）。
- **`--strict`**: 揺れが残っていたら非ゼロ終了（CI / 公開前ゲートに組み込む用途）。

検出方法の段階:

| 段 | 手段 | 守備範囲 | 確度 |
|---|---|---|---|
| 1 | 機械照合（文字列・正規表現） | 固有名詞（G2＝variants＋context）・既知 variants（G1）・数値キー（G3＝variants＋context）・形式マーカー（G4） | 高（既知パターン） |
| 2 | LLM 補助（任意） | 言い換え・表記の揺れの「未知の」検出（glossary に無い揺れの発見） | 中（要レビュー） |

第1段は**機械照合のみ**で十分カバーできる（レビューの G1〜G4 はすべて既知パターン）。LLM 補助は glossary に無い揺れを掘る第2段の拡張。

### 4.1 命名規約の検出（G5）は別コマンドに分ける

`series:check` は **`final.md` の本文だけ**を見る。`members[].slug` / topic-file 名 / export 名のプレフィックス整合（G5）は本文の外なので、**`series:status`（または専用の `series:validate`）の責務**に分離する。

- 対象: `series.json` の `members[].slug`、`topics/<...>.txt` の命名、export 名（`<seriesId>-<NN>-<slug>`）が**同一プレフィックス規約**で揃っているか。
- 規約は glossary ではなく `series.json`（または別の `naming` 設定）側に持つ。本文照合（glossary）と命名照合（series.json）で正本を分ける。
- 本文系（series:check）と命名系（series:status/validate）を**ひとつのコマンドに混ぜない**（責務と正本が違うため）。

## 5. 既存資産・ゲートとの接続

- **voice.md との分離**: 形式（G4）は voice の「疑問形見出し」方針と重なる。**voice = 書き方の癖、glossary.format = 体裁の固定値**として、矛盾しないよう glossary は voice の方針を参照する（例: `qa: heading-question` は voice の疑問形方針と整合）。voice を凍結しているシリーズでは glossary.format が voice に従属する。
- **factcheck との分離（重要）**: G2（青森市）・G3（年代）は**事実でもある**。`series:check` は「シリーズ内で揃っているか」だけを見て、**どの値が事実として正しいかは判定しない**（それは factcheck の責務）。揺れを直す revise（層A・本書では対象外）の後は必ず `factcheck-scope` を回す前提を `series:check` は仮定しない（series:check は事実の正誤に踏み込まない）。
- **editorial-review との関係**: 横断一貫性は編集観点に足せるが、`series:check` は機械ゲート、editorial は人の批評。**機械で拾える揺れ（G1〜G4）は `series:check` に寄せ**、editorial は機械で拾えない一貫性（語り口・構成の流れ）に集中させる（責務の重複回避）。
- **completion-report / verify-artifacts**: 第1段では `series:check` を公開前ゲートに**必須化しない**（warning 止まり）。運用が固まったら `--strict` を completion-report の machine gate に併記する（editorial-ledger gate と同じ昇格パス）。

## 6. 段階的導入

> **層A（既存4本の即時修正）は今回は対象外**（別タスクで後送り）。本書のスコープは層B（下記）。

1. **第1段（glossary 最小・層B）**: `glossary.yaml`（terms/nouns）＋ `series:check`（機械照合・dry-run）。**nouns は `variants`＋`contextPatterns` で揺れ側を検出**（canonical だけでは拾えない・P1）。固有名詞と既知 variants だけ先行。縄文4本を回帰フィクスチャに。
2. **第2段（命名規約・G5）**: `series:status`／`series:validate` に slug/topic-file/export 名のプレフィックス整合チェックを足す（§4.1）。本文系と分離。
3. **第3段**: numbers（時期区分・`variants`＋`context`＋正規化）＋ format（Q&A 体裁）の照合。voice.format との従属関係を確定。
4. **第4段**: `--strict`＋公開前ゲート併記（レポートに glossary hash 記録）、LLM 補助による未知の揺れ検出（spec C4 の本丸）、glossary 凍結（first-write-wins）。

> 層A（即時修正）は層B の実装と独立に着手できる。層B が回帰フィクスチャ（縄文4本）を必要とするため、層A で本文を直す前に**現状の揺れを `series:check` の期待値として固定しておく**と回帰テストが作りやすい（順序の利点。ただし本書では層A 自体は扱わない）。

## 7. 課題・未解決論点

| # | 課題 | 重大度 | 現時点の方針 |
|---|---|---|---|
| Q1 | glossary の凍結強度。用語は文体ほど不変でない（途中で正を変えたいことがある）。voice の first-write-wins をそのまま当てると硬すぎる | P2 | 既定は未凍結（追記更新可）。凍結は任意の opt-in（spec C3 と同型の論点） |
| Q2 | 数値（G3）の照合は表記の幅がある（「約4200年前」「4,200年前」「紀元前2200年頃」）。単純一致では取りこぼす | P2 | numbers は正規化（全角/半角・約/およそ・年前/BP/西暦）してから比較。正規化規則は第3段で確定 |
| Q3 | 形式（G4）の検出は Markdown 構造解析が要る（`###` 疑問形 vs `**Q.**`）。文字列一致では脆い | P2 | format は「マーカーの有無」の粗い検出で第3段に着手。厳密な構造解析は将来 |
| Q4 | glossary を**誰が**起こすか。voice.md と同じく手書き必須にするか、既存記事から抽出するか | P2→P3 | 第1段は手書き（最小は nouns 数件）。既存記事からの抽出（`series:extract-glossary`）は将来＝spec C2 と同じ降格 |
| Q5 | factcheck と series:check の責務境界の運用徹底（「揃っているが両方とも事実は誤り」を見逃さない） | P2 | ドキュメントで明記＋（層A 着手時に）factcheck-scope 必須運用で担保 |
| Q6 | 形式（G4）の正本を glossary.format に置くか `series-style` 側に寄せるか。voice.md との従属関係がやや強い | P3 | 現案は glossary.format（voice に従属）で第1段は許容。将来は format を文体側（`series-style`）に移す選択肢を残す |
| Q7 | 公開済みシリーズの一括更新コスト（横断修正は記事数に比例）。※層A の論点 | P3 | `/update-article` の差分集中で1本あたりは軽い。順次実行を推奨（層A 着手時に再掲） |

---

## 付録A: レビュー指摘の対応表

> 本書のスコープは**層B のみ**（層A は今回対象外）。層A 欄は将来着手時の覚書。

| レビュー指摘 | 種別 | 層B（本書の対象）＝検出 | 層A（対象外・覚書）＝修正 |
|---|---|---|---|
| 竪穴建物 vs 竪穴住居（第1回だけ別） | 用語 G1 | `terms.variants` で検出（`firstUseAlias: per-article`） | 竪穴建物に統一（初出別称可） |
| 三内丸山＝青森市/青森県 | 固有名詞 G2 | `nouns.attributes.location.variants`＋`contextPatterns` で揺れ側を検出 | 青森市に統一 |
| 縄文中期の終端 4200/4000 年前 | 数値 G3 | `numbers.variants`＋`context`＋正規化で検出 | 一値に決定 |
| Q&A 形式が第1回だけ違う | 形式 G4 | `format.qa`（voice 連携・マーカー検出） | 一方式に統一 |
| member-slug の jomon- プレフィックス不一致 | 命名 G5 | **`series:check` ではなく `series:status`／`series:validate`**（§4.1） | 実データを jomon-crafts/jomon-ritual に統一 |
| メタ記事の冗長な注意書き（0.2.53 時点等が複数箇所） | 構成 | 本書の対象外（editorial 観点で別途） | — |
| 阿蘇4 年代がポピュラー系二次ソース | 出典の質 | 本書の対象外（factcheck/sources の一次寄せ。別タスク） | — |

## 付録B: Codex レビュー反映ログ（2026-06-25・第1巡）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| `nouns.attributes` だけでは G2 を機械検出できない（「青森県」をどう拾うか未定義） | P1 | §3 nouns を `location.{preferred, variants, contextPatterns}` 構造に変更。variants（揺れ側）＋context（近傍語）で検出 |
| G5 が層Bの検出対象から落ちている（`final.md` 走査では拾えない命名規約） | P1 | §1 G5 補足・§2 層B・§4.1 を新設し、命名規約は `series:status`／`series:validate` の責務に分離 |
| `numbers` は正規化以前に「どの出現を比較するか」が未定義 | P2 | §3 numbers に `variants`＋`context` を追加（第3段で正規化と併用）。Q2 に正規化規則を残置 |
| `--accepted-after factcheck` の記述が危ない（先に stamp する誤運用） | P2 | §2 層A-3 を「factcheck-scope の判定に従い factcheck 実施→その後 stamp」に明記（順序固定）。※層A は今回対象外だが覚書として訂正 |
| `checked` 証跡の保存先が未定義（progress か別ファイルか） | P2 | §4 で `series/<slug>/series-check-report.json`（最新）＋ `checks/<id>.json`（履歴）に固定。canonical 9 段外なので progress に混ぜない |
| `firstUseAlias` が記事ごと初出かシリーズ全体初出か未定 | 軽微 | §3 で既定 `per-article`（Qiita は単体流入）。`series-wide`/`false` を値に残す |
| `--strict` を CI に入れる段階で使用 glossary の hash をレポートに残す | 軽微 | §4 レポートに glossary の hash を記録（第2巡で `contentHash` 主に変更） |
| 形式（G4）は将来 `series-style` 側に寄せる選択肢 | 軽微 | §7 Q6 に残置（現案 glossary.format は第1段として許容） |

## 付録C: Codex レビュー反映ログ（2026-06-25・第2巡）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| `version` がスキーマ版か内容版か曖昧（凍結任意だと内容版が無いケースがある） | P1 | §3 で **`schemaVersion`（形式）と `revision`（内容・任意）を分離**。レポートの監査キーは**常に算出できる `contentHash` を主**にし、`revision`/`schemaVersion` は併記（あれば）。§4 レポート記述も更新 |
| 既定 dry-run なのにレポートを上書き保存＝`series:status` の流儀とズレ | P2 | §4 を「既定は read-only（入力不変）＋レポート出力」に再定義し、`series:status` の dry-run と流儀が違う旨を明記。レポート抑止用 `--no-report` を追加 |
| `contextPatterns`/`context` の近傍（文字数/文単位）・OR/AND が実装者依存 | P2 | §3.1 を新設。**同一段落単位・context は OR**（同一段落に canonical/context のいずれか＋variant で検出）に固定。コードブロックは対象外 |
| `firstUseAlias: per-article` と variants 検出の例外条件が未定（正しい初出併記まで引っかかる） | P2 | §3.1 で許容条件を固定（**各記事の初回1回・preferred と同一文内 or 括弧内**は warning なし。2回目以降・条件外は検出） |
| 「誤り側」という語が factcheck との責務分離を濁す（青森県は誤りではない） | P3 | §3 スキーマ・コメントを **「非推奨側／揺れ側」** に統一（series:check は揺れを見る＝誤り判定は factcheck・§5） |
