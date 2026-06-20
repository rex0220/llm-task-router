# Claude Code 編集長モデル 改善 実行計画書

- 仕様: [claude-editor-improvement-spec.md](claude-editor-improvement-spec.md)
- 起案・所見: [claude-editor-improvement-proposal.md](claude-editor-improvement-proposal.md)
- 本書の位置づけ: 仕様書（What）を、着手順・PR 単位・着手判断・検証手順・見積りに落とした進行計画（How / When）。

## 進め方の方針

- **1 フェーズ = 1 PR**。各フェーズは独立にレビュー・マージでき、後段ほど前段の成果物に依存する。
- **証跡系（エージェント出力規約）を先、検証系（CLI）を後**に置く。検証する側は検証対象が標準化されてから着手する。
- **#3 は実装前に設計メモを別 PR で確定**してから着手する（本計画の最大リスク。後述のゲート参照）。
- ドキュメント／エージェント手順の変更はテスト対象外、CLI 実装（#5）は vitest を追加する。
- ブランチは `main` 直push せず、フェーズごとに作業ブランチ → PR。

## 全体ロードマップ

| Phase | 対象（spec #） | 種別 | 依存 | 規模 | テスト |
| --- | --- | --- | --- | --- | --- |
| P1 | #1 publication-check.md | エージェント手順 | なし | XS | 不要 |
| P2 | #2 README 章 | ドキュメント | なし | S | 不要 |
| P3a | #3 設計メモ（先行ゲート） | ドキュメント | なし | S | 不要 |
| P3b | #3 claims/sources idless raw 出力規約 | エージェント手順 | P3a | M | 不要 |
| P4 | #4 build-verify-report.json | エージェント手順 | なし | S | 不要 |
| P5 | #5 claims-normalize ＋ verify-artifacts | CLI（採番＋検証） | P1・P3b・P4 | M〜L | 必要 |
| P6 | #6 claim 差分再検証 | 運用＋CLI連携 | P3b 安定後 | L | 必要 |

> P1・P2・P3a・P4 は相互に依存しないため並行・任意順で着手できる。クリティカルパスは **P3a → P3b → P5 → P6**。

---

## Phase 1 — `publication-check.md` 標準化

- **狙い**: GO/NO-GO 判断とゲート状況を run の証跡として残す。最小コストで本丸価値（運用証跡）が出る。
- **変更**:
  - `.claude/agents/article-editor-in-chief.md` の進行手順 6 に「ゲート実施チェックリストを `runs/<id>/publication-check.md` に書き出してから GO/NO-GO を推奨」を追記。
  - テンプレートは spec #1 の項目に合わせる。
- **検証**: 1 記事を通し、`runs/<runId>/publication-check.md` が GO/NO-GO とゲート状況込みで残ることを目視確認。
- **完了条件 (DoD)**: 編集長フローで silent に GO せず、必ずファイル証跡が残る。

## Phase 2 — README「Claude Code を編集長として使う」章

- **狙い**: 既存の役割分担を初見ユーザーへ入口で伝える。新規実装なし。
- **変更**:
  - `README.md` / `README.ja.md` に章を追加。`docs/qiita-article-howto.md` 末尾の「工程 ↔ 担当AI ↔ CLIコマンド」対応表を要約転記。
  - 必須記述: 「本文を直接編集しない」「修正は `article:revise` 経由」「export はユーザー承認後」「`init` が `.claude/` と `CLAUDE.md` を配布＝主要価値」。
- **検証**: README から各工程の slash command / agent / CLI 対応が一読で追えること。
- **DoD**: 2 ファイル（en/ja）が同期。

## Phase 3a — claims スキーマ設計メモ（先行ゲート・必須）

> **このフェーズを飛ばして P3b に進まない。** #3 のコストはスキーマではなく運用の安定化にある。

- **狙い**: claims 台帳の運用方針を実装前に固定し、後戻りを防ぐ。
- **成果物**: `docs/claims-schema-notes.md`（作成済み）。
- **決定済み事項**（全文は [claims-schema-notes.md](claims-schema-notes.md)）:
  1. **id 安定性**: `CNNN-<hash8>`、hash 対象は claim 文のみ（`anchorHash` と同一値）。`claims-ledger.json` で所有。`weaknessHash`/`mergeFound` を参照モデルに。
  2. **location**: `{ heading, anchorHash }`。再同定は anchorHash 主・heading 補助（heading は hash に含めない）。
  3. **二軸状態と blocking**: `status`（検証）と `lifecycle`（present/removed）を分離。blocking（ゲート fail）= `present` かつ `severity∈{critical,major}` かつ `status∈{unverified,needs-source,incorrect}`。
  4. **source ID**: 安定主キーは正規化 URL hash（raw `key` ではない）。raw `sourceRefs` → normalize で `SNNN`/`sourceIds`。
  5. **lifecycle 入力**: 今回の `claims.raw.json`（current observed set）と台帳の比較。`removed` 判定は全文 factcheck 時のみ。
  6. **検証責任の分界**: JSON 生成 = factchecker / 採番・台帳・zod 検証 = CLI（#5）。「取得は持たない／検証は持つ」。
- **DoD**: 上記が文書で確定し、P3b / P5 / P6 がこの定義を参照できる。 ✅

## Phase 3b — `claims.raw.json` / `sources.raw.json`（idless raw）出力規約

- **依存**: P3a 完了。
- **設計判断（P3a 由来）**: 安定 id（`CNNN-<hash8>`）の採番は **コード**が持つ（LLM に sha256 を決定的計算させない、editorial-ledger と同型）。よって P3b で factchecker が出すのは **id 無しの raw**。台帳化・採番・`claims.json` 生成は P5 の `claims-normalize`（コード）が担う。詳細は [claims-schema-notes.md](claims-schema-notes.md)。
- **変更**:
  - `.claude/agents/article-factchecker.md` の出力規約に `claims.raw.json` / `sources.raw.json`（idless）を追加（`factcheck-instruction.md` は併存）。
  - raw は素直な配列2ファイル（`claims.raw.json` / `sources.raw.json`）。観測範囲は normalize の `--scope full|diff` フラグで渡す（full のみ removed 判定。agent にメタ欄を持たせない）。
  - raw claim は `claim` / `location.heading` / `type` / `status` / **`sourceRefs`（URL か raw source の一時 key）** / `severity` / `note`。hash・id・anchorHash・sourceIds は付けない。raw source は `key` / `url` / `title` / `retrievedAt` / `sourceType` / `summary`（id なし）。`severity` は `critical|major|minor|suggestion`。
- **検証**: factchecker 実行後、P3a の定義に適合した idless raw 2 ファイルが残る（P5 の normalize→検証を通る前提）。
- **DoD**: raw が安定して生成され、フォーマット揺れがない。

## Phase 4 — `build-verify-report.json` 出力規約

- **依存**: なし（P5 の検証対象なので P5 より前）。
- **変更**:
  - `.claude/agents/article-build-verifier.md` の出力規約に `build-verify-report.json` を追加（`build-verify-instruction.md` は併存）。
  - スキーマは spec #4 準拠。
- **検証**: コードを含む記事の検証後、実行環境とブロック別結果を含む report が残る。
- **DoD**: report が証跡として残り、P5 のスキーマ検証を通る。

## Phase 5 — `article:claims-normalize` ＋ `article:verify-artifacts`（CLI・検証のみ）

- **依存**: P1（publication-check）・P3b（idless raw）・P4（build-verify-report）。
- **狙い**: (1) idless raw → 安定 id 付き `claims.json` の正規化、(2) 公開前に必要な成果物の揃い／スキーマを機械的にチェック。いずれも外部通信なし＝安全方針と無衝突。
- **変更**:
  - `src/cli/claimsNormalize.ts`（P3a 由来）: `claims.raw.json` → `claims-ledger.json` 反映 → `claims.json`（`CNNN-<hash8>`）。hash 採番・台帳マージは editorial-review の `weaknessHash`/`mergeFound` と同型で実装。`sources.raw.json` → `sources.json` も同様。
  - `src/cli/verifyArtifacts.ts`: チェック項目は spec #5（normalize 済み `claims.json` 前提）。終了コードで合否、欠落・スキーマ違反・未解決 critical/major を列挙。
  - `src/schemas/` に claims / sources / build-verify-report の zod を追加（claims-schema-notes.md「zod 固定方針」）。`build-verify-report.json` の `skipReason` 条件付き必須もここで固定。
  - `src/index.ts` に `article:claims-normalize` / `article:verify-artifacts` を登録（各 `--run <runId>`）。
- **テスト**: vitest で normalize（同一 hash の id 再利用 / 新規採番 / 改稿で消えた claim の status 保持）と verify（揃った run→pass、欠落/スキーマ違反/未解決 major→fail と理由列挙）を網羅。fixture run を用意。
- **DoD**: テスト緑、外部通信ゼロ、編集長フローの公開前ゲートとして使える。

## Phase 6 — 公開済み記事更新での claim 差分再検証

- **依存**: P3b の claims 運用が安定してから。
- **狙い**: 更新リライト時に全文再検証せず、変更 claim だけ重点再検証。
- **変更**:
  - `article:update-diff` の `changed-sections.json` と `claims.json` を突き合わせ、変更セクションに属する claim を抽出する連携。
  - 価格・API・モデルID・バージョンなど陳腐化しやすい `type` を優先。
- **テスト**: 変更セクションに属する claim のみ抽出されることを fixture で検証。
- **DoD**: 更新 run で対象 claim が正しく絞り込まれ、`record-publication` フローと整合。

---

## リスクと対応

| リスク | 影響 | 対応 |
| --- | --- | --- |
| #3 の id / location 運用が後から崩れる | P5・P6 が手戻り | P3a を必須ゲート化。実装前に文書確定 |
| エージェント生成 JSON のフォーマット揺れ | 台帳が信用できない | スキーマ検証を P5 の CLI に集約。生成は規約で縛る |
| CLI に検証以上の責務が混入 | 薄い実行レイヤー思想が崩れる | 「取得は持たない／検証は持つ」を全フェーズの不変条件にする |
| ドキュメント間の参照ズレ | 計画の不整合 | proposal / spec / plan の実施順を変更時に三者同期 |

## マージ順の推奨

1. P1（XS・即効） → 2. P2（独立） → 3. P4（独立） → 4. P3a（ゲート） → 5. P3b → 6. P5 → 7. P6

P1・P2・P4 は依存がないため先行マージしてよい。P3a は P3b 着手前までに必ず確定する。

## 進捗管理

- 各フェーズは PR の本文に DoD チェックリストを貼り、満たした項目をチェックする。
- proposal / spec / 本計画の実施順は常に一致させる（変更時は三者同時更新）。
