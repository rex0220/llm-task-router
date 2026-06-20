# Claude Code 編集長モデル 改善 仕様書

- 起案: [claude-editor-improvement-proposal.md](claude-editor-improvement-proposal.md)
- レビュー所見: 同提案書末尾「レビュー所見（2026-06-20）」
- 本書の位置づけ: 採用が確定した改善案を、実装可能な粒度の仕様に落とす。各項目は独立に着手でき、後段ほど前段の成果物に依存する。

## 設計原則（全項目に共通）

- **薄い実行レイヤーを保つ**: CLI 本体は Web 取得・任意 URL アクセス・出典解釈を持たない。Web 裏取りは `article-factchecker`、実機検証は `article-build-verifier` に委譲する既存方針を崩さない。
- **取得は持たない／検証は持つ**: 機械可読台帳（JSON）の**生成はエージェント**が担い、**スキーマ検証は CLI**（`article:verify-artifacts`）が担う。両者を混同しない。
- **証跡は run に集約**: 公開判断の根拠は会話ではなく `runs/<runId>/` のファイルに残す。`final.md` は直接編集せず修正は `article:revise` 経由（既存原則の踏襲）。
- **silent skip 禁止**: 各ゲート（factcheck / build-verify / editorial-review）は実施または「スキップ理由明記」のいずれかを必ず証跡化する。

## 実施順サマリ

| # | 項目 | 種別 | 依存 | 主担当 |
| --- | --- | --- | --- | --- |
| 1 | `publication-check.md` 標準化 | エージェント手順 | なし | editor-in-chief |
| 2 | README「編集長として使う」章 | ドキュメント | なし | — |
| 3 | `claims.json` / `sources.json` | エージェント出力規約＋設計メモ | 設計メモ先行 | factchecker |
| 4 | `build-verify-report.json` | エージェント出力規約 | なし | build-verifier |
| 5 | `article:verify-artifacts` | CLI（検証のみ） | 1・3・4 | CLI |
| 6 | claim 差分再検証 | 運用＋CLI連携 | 3 安定後 | factchecker |

---

## 1. `publication-check.md` の標準化

### 目的
編集長の GO/NO-GO 判断とゲート実施状況を、会話だけでなく run の証跡として残す。

### 仕様
- 保存先: `runs/<runId>/publication-check.md`
- 生成主体: `article-editor-in-chief`（CLI コマンド化はしない）。
- 生成タイミング: GO/NO-GO を推奨する**前**に作成する。既存手順の「ゲート実施チェックリスト提示」をファイル出力に置き換える。

### テンプレート
```md
# Publication Check

- runId:
- profile:
- final:
- refine stopped reason:
- final-review:
- factcheck: done / skipped
- factcheck summary:
- build-verify: done / skipped
- build-verify summary:
- editorial-review: done / skipped
- editorial-review summary:
- unresolved risks:
- GO/NO-GO:
- reason:
- user approval required: yes
```

### 変更箇所
- `.claude/agents/article-editor-in-chief.md` の進行手順 6 に「ゲート実施チェックリストを `runs/<id>/publication-check.md` に書き出してから GO/NO-GO を推奨する」を追記。

### 完了条件
- 1 記事を通したとき `runs/<runId>/publication-check.md` が GO/NO-GO とゲート状況込みで残る。

---

## 2. README「Claude Code を編集長として使う」章

### 目的
既存の `.claude/agents` / slash command / CLI の役割分担を、初見ユーザーに入口で伝える。実体は既にあるため新規実装はしない。

### 仕様
- 対象: `README.md` および `README.ja.md`。
- 内容の核: `docs/qiita-article-howto.md` 末尾の「工程 ↔ 担当AI ↔ CLIコマンド」対応表を要約転記する。コマンド単体の羅列ではなく、Claude Code 側操作と対応 CLI を並置する。
- 必須記述: 「本文を直接編集しない」「修正は `article:revise` 経由」「export はユーザー承認後」「`init` が `.claude/` と `CLAUDE.md` を配布することは主要価値」。

### 完了条件
- README から、どの slash command / agent / CLI コマンドがどの工程を担うかが一読で追える。

---

## 3. `claims.json` / `sources.json`（factchecker 標準出力）

> **着手前提**: 実装より先に「id 安定化戦略」と「検証責任の所在」を設計メモ（`docs/claims-schema-notes.md` 等）で固める。これが本項目の最大コストであり、未確定のまま走らせない。

### 目的
事実確認・出典管理・再検証の基盤となる機械可読台帳を持つ。`factcheck-instruction.md`（人間向け修正指示）は併存させる。

### 保存先
```
runs/<runId>/claims.json
runs/<runId>/sources.json
```

### claims.json スキーマ
```json
[
  {
    "id": "C001",
    "location": "該当見出しまたは本文位置",
    "claim": "検証すべき主張",
    "type": "api|price|version|technical|general",
    "status": "verified|needs-source|incorrect|unverified",
    "sourceIds": ["S001"],
    "severity": "critical|major|minor|suggestion",
    "note": "修正指示または判断メモ"
  }
]
```

### sources.json スキーマ
```json
[
  {
    "id": "S001",
    "url": "https://example.com/source",
    "title": "参照元タイトル",
    "retrievedAt": "2026-06-20",
    "sourceType": "primary|secondary",
    "summary": "根拠の要約"
  }
]
```

### 設計メモで先に決めること（必須）
1. **id 安定性**: `C001` を改稿後も同一 claim に振り直せる運用。`src/schemas/EditorialReviewContinuationSchema.ts` の weakness id 安定化（ラウンドをまたぐ追跡）を参照モデルにする。
2. **location のズレ対策**: 本文改稿で見出しがズレる前提で、location を「検証時点のスナップショット」とするか claim 本文照合で再同定するかを決める。
3. **検証責任**: JSON 生成は factchecker、スキーマ検証は CLI（#5 `verify-artifacts`）。この分界を明記。

### 役割分担
- Web 取得・検証判断は引き続き `article-factchecker`。
- CLI 本体は Web fetch を持たない。スキーマ検証のみ #5 で持つ。

### 変更箇所
- `.claude/agents/article-factchecker.md` の出力規約に `claims.json` / `sources.json` を追加。
- 設計メモ（id・location・status 遷移）を新規作成。

### 完了条件
- factchecker 実行後、スキーマに適合した `claims.json` / `sources.json` が残り、#5 の検証を通る。

---

## 4. `build-verify-report.json`（build-verifier 標準出力）

### 目的
コードを含む記事の実機検証結果を、修正指示（`build-verify-instruction.md`）とは別に機械可読な証跡として残す。`verify-artifacts`（#5）の検証対象になるため、それより前に標準化する。

### 保存先
```
runs/<runId>/build-verify-report.json
```

### スキーマ
```json
{
  "status": "passed|failed|partial|skipped",
  "environment": {
    "node": "v20.x",
    "typescript": "x.y.z"
  },
  "checkedBlocks": [
    {
      "id": "B001",
      "location": "該当見出し",
      "language": "ts",
      "commands": ["npm install", "npm run build"],
      "result": "passed",
      "notes": "掲載どおりに typecheck 通過"
    }
  ],
  "unverified": []
}
```

### 変更箇所
- `.claude/agents/article-build-verifier.md` の出力規約に `build-verify-report.json` を追加。`build-verify-instruction.md` は併存。

### 完了条件
- コードを含む記事の検証後、実行環境とブロック別結果を含む `build-verify-report.json` が残り、#5 の検証を通る。

---

## 5. `article:verify-artifacts`（CLI・検証のみ）

### 目的
各検証の中身を再判定せず、公開前に必要な成果物が揃っているかを機械的にチェックする軽量コマンド。外部通信を行わない。検証対象（#1 publication-check / #3 claims / #4 build-verify-report）が標準化された後に置く。

### コマンド
```bash
llm-task-router article:verify-artifacts --run <runId>
```

### チェック項目
- `final.md` が存在する。
- `final-review.md` が存在する。
- `publication-check.md` が存在し、GO/NO-GO が記載されている。
- `factcheck-instruction.md` または factcheck skip 理由がある。
- コードを含む記事では `build-verify-report.json` または build-verify skip 理由がある。
- `editorial-review.md` または editorial-review skip 理由がある。
- `claims.json` が**スキーマに適合**し、unresolved な critical / major が残っていない。

### 仕様メモ
- スキーマ検証は本コマンドの責務（#3 の「検証は CLI が持つ」を実装する箇所）。
- 終了コードで合否を返し、欠落・スキーマ違反・未解決 critical/major を列挙する。
- 外部通信なし＝安全方針と無衝突。

### 完了条件
- 成果物が揃った run で pass、いずれか欠落・スキーマ違反・未解決 critical/major がある run で fail し、理由を列挙する。

---

## 6. 公開済み記事更新での claim 差分再検証

> **着手前提**: #3 の `claims.json` スキーマと運用が安定してから。

### 目的
更新リライト時に全文ファクトチェックを毎回せず、変更された claim だけを重点再検証する。

### 仕様
- `article:update-diff` が出す `changed-sections.json` と `claims.json` を突き合わせ、変更セクションに属する claim を再検証対象に絞る。
- 価格・API・モデルID・バージョンなど陳腐化しやすい `type` を優先する。
- 同一 URL・同一記事としての更新リライト（`record-publication`）と整合する。

### 完了条件
- 更新 run で、変更セクションに属する claim のみが再検証対象として抽出される。

---

## 後回し（現段階では非採用）

以下の CLI コマンド化は方向性は良いが優先度を下げる。CLI 本体に Web 取得・出典解釈を持たせると安全方針（HTTP API 非公開・任意 URL 非取得）と衝突し、薄い実行レイヤーという強みがぼやけるため。

```bash
llm-task-router article:claims
llm-task-router article:sources
llm-task-router article:fact-check
llm-task-router article:citation-check
```

まず `.claude/agents` 側の出力規約として `claims.json` / `sources.json` / `publication-check.md` を安定させ、その後に CLI が「検証だけ」する順番を維持する。
