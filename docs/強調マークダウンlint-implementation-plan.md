# 実装計画：強調 `**…**` レンダリング不備の機械 lint

検討メモ [docs/課題-対策-実装計画-強調マークダウンレンダリング.md](課題-対策-実装計画-強調マークダウンレンダリング.md) を実装に落とす計画。原因・効果・リスクの議論はメモ側に委ね、本書は **「何を・どのファイルに・どの順で・どのテストで」** に絞る。

## 採用方針（メモの未決事項の確定）

実装はメモの推奨方向で確定する。異論が出たらメモの未決事項に戻して再合意する。

| 論点 | 採用 |
|---|---|
| 判定エンジン | **A 案（無依存の文字列 lint）**。既存 `src/utils/text.ts` の正規表現/文字列処理の流儀に合わせ、マークダウンパーサ依存を増やさない |
| 対象記法 | **`**`（strong）の約物内端ケースのみ**。開き側（left-flanking 不成立）と閉じ側（right-flanking 不成立）の両方。`*`・`__`・`***`・入れ子は対象外 |
| 強制レベル | **warning から開始 → コーパス誤検知ゼロ＋golden test 通過で `error` 格上げ**（段階導入） |
| export 強制 | **強調 lint 単体**を export 直前に実行（full `verifyArtifacts` は使わない）。(i) 実行ゲート＋(ii) 監査スタンプを**併用** |
| 自動修正 | **本計画では作らない**（強調範囲の意図を変え得るため後追い） |

## 触る対象（実コード）

- [src/utils/text.ts](../src/utils/text.ts) … lint コア関数を追加（`detectWrapText` と同居）
- [tests/utils/text.test.ts](../tests/utils/text.test.ts) … コアのユニットテスト
- [src/cli/verifyArtifacts.ts](../src/cli/verifyArtifacts.ts) … 公開前ゲートに warning/error を接続（`VerifyArtifactsResult` に積む）
- [tests/cli/verifyArtifacts.test.ts](../tests/cli/verifyArtifacts.test.ts)
- [src/workflows/createQiitaArticle.ts](../src/workflows/createQiitaArticle.ts) … 生成/refine 時にも warning 表示（`detectWrapText` と同じ箇所: L123 / L753）
- [src/cli/export.ts](../src/cli/export.ts) / [src/index.ts](../src/index.ts)（`article:export` L323-341） … export 直前ゲート＋スタンプ（Phase 3）
- [src/utils/hash.ts](../src/utils/hash.ts) … `sha256` を鮮度スタンプに流用
- プロンプト（第1層・予防）… `createQiitaArticle.ts` の create/refine 指示文に記述規約を追記

---

## Phase 0: 生成時ルール（予防・第1層）

**目的**: 発生率そのものを下げる。lint より先に入れて損がない軽い変更。

- create / refine のプロンプトに記述規約を1行追記:
  > 強調 `**…**` の内端（開き直後・閉じ直前）に約物（`」` `）` `”` `、` 等）を置かない。括弧・引用符・読点は `**` の外に出す。
- 受け入れ: 既存スナップショット/プロンプトテストがあれば更新。挙動テストは不要（確率的なので保証はしない）。

---

## Phase 1: lint コア（無依存・検出のみ）

**目的**: `final.md` 本文から「開けない/閉じられない `**`」を行番号付きで返す純関数を作る。副作用なし・I/O なし。

### 1-1. API（[src/utils/text.ts](../src/utils/text.ts) に追加）

```ts
export type EmphasisLintIssue = {
  line: number;        // 1-based
  column: number;      // 1-based（`**` の開始位置）
  kind: "unopened" | "unclosed"; // left-flanking 不成立 / right-flanking 不成立
  excerpt: string;     // 該当行（前後を ** 含めて抜粋）
};

// `**` の約物内端ケースに限定して開閉不能なデリミタを返す。
// コードフェンス / インラインコード / エスケープ `\*` は除外。`*`・`__`・`***`・入れ子は対象外。
export function detectBrokenStrongEmphasis(markdown: string): EmphasisLintIssue[];
```

### 1-2. 判定ロジック（CommonMark フランキングの該当サブセット）

1. **走査前処理**: 行単位で扱いつつ、コードフェンス（バッククォート3連 / チルダ3連 `~~~`）内をスキップ、インラインコード（バッククォート囲み）スパンを除外、`\*` を非デリミタ化（マスク）。
2. **`**` 連を抽出**: 連続する `*` を数え、ちょうど 2（`**`）の境界だけ対象（`***` 以上・単独 `*` は対象外）。
3. **前後文字の分類**: 直前・直後の1文字を `whitespace` / `punctuation` / `other` に分類。`punctuation` は ASCII 句読点＋Unicode 句読点カテゴリ（`\p{P}`、CJK の `」` `）` `”` `、` 等を含む）。行頭/行末は whitespace 扱い。
4. **flanking 判定**:
   - left-flanking = 直後が非空白 かつ（直後が非約物 または 直前が空白/約物）
   - right-flanking = 直前が非空白 かつ（直前が非約物 または 直後が空白/約物）
5. **検出（スタックに依存しないヒューリスティック）**: 単純スタックだけだと開き側崩れを取りこぼす。例 `これは**「太陽系」**の` の最初の `**` は left-flanking 不成立だが right-flanking には成り得るため、素朴なスタックでは「閉じ」と誤分類され、本来 `unopened` のものを空スタックの閉じとして扱ってしまう。そこで**対象ケースを限定したヒューリスティックを明文化**する:
   - **内端が約物の `**` だけを候補にする**（直前または直後が `punctuation`）。これが今回拾いたいクラス。
   - 候補ごとに「その `**` が**開きの役割なら left-flanking が必要**・**閉じの役割なら right-flanking が必要**」を判定。役割は周囲の文脈（直前が空白/行頭寄りなら開き候補、直後が空白/行末寄りなら閉じ候補。判別不能なら両側評価）で推定。
   - **開き候補で left-flanking 不成立 → `unopened`／閉じ候補で right-flanking 不成立 → `unclosed`**。
   - 純粋な数の不一致（約物無関係）は対象外＝報告しない（将来拡張）。
   - 実装の指針: 完全なスタック照合より「内端が約物 × 期待 flanking 不成立」の局所判定を優先する。golden test（1-3）が両方向の正解を固定するので、ロジックはテストで縛る。

> 注: 完全な CommonMark 実装は目指さない。**「内端が約物で開閉できない `**`」** を決定的に拾うことに範囲を固定する（メモのリスク欄＝実装精度依存を踏襲）。

### 1-3. テスト（[tests/utils/text.test.ts](../tests/utils/text.test.ts)）— golden set

| ケース | 入力例 | 期待 |
|---|---|---|
| 閉じ側崩れ×5（実データ） | `**「太陽系の化石」**の` 他4例 | 各 `unclosed` 検出 |
| 開き側崩れ | `これは**「太陽系」**の` | `unopened` 検出 |
| 正常（文字内端） | `**初代はやぶさ**を` | 検出なし |
| 正常（約物だが外側） | `「**太陽系の化石**」の` / `**約5.4g**（…）と` | 検出なし |
| コードフェンス内 | ```` ```\n**「x」**の\n``` ```` | 検出なし |
| インラインコード内 | `` `**「x」**` `` | 検出なし |
| エスケープ | `\*\*強調しない\*\*` | 検出なし |
| 数式風 | `a*b*c` / `*ptr` | 検出なし（`**` 連でない） |

**受け入れ基準（Phase 1）**: 上記すべて green。これが以降の golden test の正本。

---

## Phase 2: verify-artifacts に warning 接続（第2層・非ブロック）

**目的**: 公開前ゲートで検出を可視化する。まだ FAIL させない。

- [src/cli/verifyArtifacts.ts](../src/cli/verifyArtifacts.ts) の `verifyArtifacts` 内、`final.md` 読み込み後に `detectBrokenStrongEmphasis` を呼び、issue があれば **`warnings` に行番号付きで push**（`errors` には積まない）。
- 文言例: `強調が壊れている可能性: L34 「太陽系の化石」**の（閉じられない **）。約物を ** の外へ。`
- 生成時にも気づけるよう [src/workflows/createQiitaArticle.ts](../src/workflows/createQiitaArticle.ts) L123/L753 の `detectWrapText` と同じ箇所で warning に合流（任意・同 PR か次 PR）。

**テスト（[tests/cli/verifyArtifacts.test.ts](../tests/cli/verifyArtifacts.test.ts)）**: 崩れを含む `final.md` で `warnings` に該当行が出る／`ok` は崩れ単体では false にならない（warning 段階）こと。

**受け入れ基準（Phase 2）**: warning 表示が出る。既存ゲートの挙動（`ok`/`errors`）は不変。

---

## Phase 3: error 格上げ＋export 強制（第2層・保証）

**前提（ゲート）**: 次の2条件を満たして初めて着手:
- **false positive 0**: `export/`・`runs/*/final.md`・`docs/` の一括走査＋コード多め記事・数式風・エスケープ・Qiita 想定記事数本で誤検知ゼロ。
- **golden test 通過**: Phase 1 のテーブルが green（5例＋開き側を必ず検出／正常例を誤検出しない）。

### 3-1. error 格上げ

- verify-artifacts で issue を **`errors`** に積む（`ok=false`）。`detectWrapText` 系の prose warning とは別扱い（強調崩れは決定的なので error 相当）。
- 移行配慮: 既存 run の再 export で過去の崩れが顕在化し得る。`error` 化と同 PR で実データを修正するか、初期は新規 run のみ対象にするフラグを検討（メモ「既存記事への遡及」）。

### 3-2. export 直前ゲート（i）＋監査スタンプ（ii・併用）

**ゲートは関数層 `exportFinalArticle` に置く（CLI 層ではない）。** `article:export` CLI だけに置くと、[src/cli/export.ts](../src/cli/export.ts) の `exportFinalArticle` を直接呼ぶ経路（テスト・将来の別コマンド）が素通りする。受け入れ基準「コード上 export できない」を満たすには関数層で強制する。

- [src/cli/export.ts](../src/cli/export.ts) の `exportFinalArticle` 内で lint を実行。**lint 対象は front-matter 生成前の raw `final.md`**（`store.read(runId, "final.md")` の直後）。現行実装は `frontMatter` 指定時に `content` を `withFrontMatter` で front-matter 付き本文へ変換するため、変換後の `content` を lint すると YAML front-matter 内の `**`・タイトル文字列に影響される。**`withFrontMatter` 適用前の本文を lint** し、issue があれば **書き出さず throw**。`options` に **`allowBrokenMarkdown?: boolean`（既定 false）** を追加してのみオーバーライド可。full `verifyArtifacts` は呼ばない（blast radius を強調に限定）。
- **`--force` と意味を分離する**。現行 `--force` は「出力先ファイルの上書き許可」であり、これを lint 回避に流用すると上書き目的の `--force` が壊れた Markdown の公開許可も兼ねてしまう。**専用フラグ `--allow-broken-markdown`**（`article:export` に追加 → `allowBrokenMarkdown` へ配線）を用意する。
- **note 必須の責務分担**: 関数層 `exportFinalArticle` は `--note`（CLI 引数）を見られない。**理由の必須化は CLI 層（`article:export`）で検証**する（`--allow-broken-markdown` 指定時に `--note` 未指定ならエラー）。関数層は `allowBrokenMarkdown: boolean` のみ担当し、bypass 事実の記録用に **`allowBrokenMarkdownReason?: string` を関数オプションに持たせて**スタンプ/戻り値へ反映する。＝**「必須チェックは CLI・記録は関数」**で分離。

**スタンプの主従を明確化（循環の解消）**:
- **スタンプの導入は Phase 3 から**（Phase 2 は warning 接続のみで `markdown-lint-stamp.json` は作らない）。PR 差分上、スタンプ書き込みは PR3 に含める。
- **許可の主判定は「export 直前 lint」**。export 時に lint を実行し、**pass ならその場でスタンプを書いてから書き出す**。初回 export もこれで成立する（既存スタンプの有無に依存しない）。
- **既存スタンプは監査・鮮度表示用**（許可条件の主軸にはしない）。「いつ・どの厳しさ・どのルールで通したか」を残す。

```ts
// runs/<id>/markdown-lint-stamp.json（export 直前 lint の結果を毎回上書き）
{
  finalHash: string;     // sha256(final.md)（hash.ts 流用）
  ruleVersion: string;   // lint ルールセット版（対象パターン定義の変更を追える）
  severityMode: "warning" | "error";
  result: "pass" | "fail";
  verifiedAt: string;    // YYYY-MM-DD（既存粒度に合わせる）
}
```

→ export フロー: `final.md 読込（raw）→ lint 実行 → pass ならスタンプ書込 → （必要なら front-matter 付与）→ 書き出し`。`fail` かつ `allowBrokenMarkdown!==true` なら throw。`allowBrokenMarkdown===true` なら `result:"fail"` のままスタンプ（`allowBrokenMarkdownReason` 付き）を残し書き出す（握り潰した事実を監査に残す）。

**テスト**:
- [tests/cli/export.test.ts](../tests/cli/export.test.ts)（`exportFinalArticle` 関数テスト）: 崩れを含む `final.md` は throw／`allowBrokenMarkdown:true` で書き出し＋`result:"fail"` スタンプ（`allowBrokenMarkdownReason` 反映）／健全な本文は成功＋`result:"pass"` スタンプ／`frontMatter:true` でも raw 本文で lint される（front-matter 内文字列に影響されない）。
- [tests/cli/bin.e2e.test.ts](../tests/cli/bin.e2e.test.ts)（`article:export` CLI を実際に叩く）: 崩れ本文で `--allow-broken-markdown` なしは失敗／**`--allow-broken-markdown` 単独（`--note` なし）は CLI 層で検証エラー**／`--allow-broken-markdown` ＋ `--note` で成功し export progress に note が載る／`--force`（上書き）だけでは lint を回避できない（意味分離の回帰）。

**受け入れ基準（Phase 3）**: 崩れた強調を含む記事は **`exportFinalArticle` 経由でも** export できない（`allowBrokenMarkdown` 明示時のみ・note 必須）。`--force` では回避できない。

---

## Phase 4（任意・後追い）: 自動修正 `--fix`

本計画の範囲外。実装するなら「約物を `**` の外へ動かす」変換を opt-in・確認付きで。**強調範囲の意図を変え得る**ため既定オフ、本文修正は `article:revise` 経由を原則とする（メモ第3層）。

---

## PR 分割と順序

1. **PR1 = Phase 0 + Phase 1**: プロンプト規約＋lint コア＋ユニットテスト（副作用なし・安全）。
2. **PR2 = Phase 2**: verify-artifacts/create に warning 接続（非ブロック）。
3. **（運用期間）**: warning でコーパス走査・誤検知ゼロ確認。実データの既存崩れを revise で修正。
4. **PR3 = Phase 3**: error 格上げ＋export 直前ゲート＋監査スタンプ。
5. **PR4（任意）= Phase 4**: `--fix`。

各 PR は `npm run test`（build + vitest）green を必須。lint コアは I/O を持たないため決定的にテストでき、`detectWrapText` と同じ純関数スタイルで回帰が容易。

## 未確定で実装時に判断する点

- `ruleVersion` の採番方式（手動文字列か package version 連動か）。
- error 化の遡及範囲（全 run か新規 run のみか）。
- 関数層 `exportFinalArticle` でも `allowBrokenMarkdownReason` 空を拒否するか（CLI 層での `--note` 必須検証は 3-2 で確定済み。関数層を直接呼ぶ経路にも理由必須を効かせるかは未確定）。
