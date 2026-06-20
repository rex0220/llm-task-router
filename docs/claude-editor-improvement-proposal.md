# Claude Code 編集長モデル 改善提案書

## 目的

`llm-task-router` を「記事生成 CLI」ではなく、Claude Code を編集長として使うための編集制作ラインとして強化する。

現状でも `article:create` / `article:refine` / `article:evaluate` / `article:revise` / `article:export`、`.claude/agents`、`runs/` による履歴保存は揃っている。次に伸ばすべき領域は、文章生成能力そのものではなく、編集長が公開判断できるだけの根拠管理と初見ユーザーへの伝わりやすさである。

## 改善案と有効ポイント

| 改善案 | 有効ポイント | 主な効果 | 実装コスト |
| --- | ---: | --- | --- |
| README に「Claude Code を編集長として使う」章を追加 | 9.5 | 既存の `.claude/agents` / slash command / CLI の役割分担が初見で伝わる | 低 |
| `publication-check.md` を標準成果物にする | 9.2 | GO/NO-GO の根拠、残リスク、各ゲート実施状況が run に残る | 低〜中 |
| `claims.json` / `sources.json` を factchecker の標準出力にする | 9.0 | 事実確認・出典管理・再検証の基盤になる | 中 |
| `build-verify-report.json` を追加 | 8.1 | 技術記事のコード検証結果が証跡として残る | 中 |
| `article:verify-artifacts` で成果物の揃いをチェック | 8.4 | 公開前ゲートの抜け漏れを機械的に検出できる | 中 |
| 公開済み記事更新で claim 差分だけ再検証 | 7.8 | 更新運用で、変わった主張だけを効率よく検証できる | 中〜高 |
| `article:claims` / `article:sources` / `article:fact-check` などを CLI 化 | 6.2 | 方向性は良いが、責務が重くなり安全方針と衝突しやすい | 高 |

## 推奨する実施順

### 1. README に「Claude Code を編集長として使う」章を追加

最も費用対効果が高い。実体はすでにあるため、新規実装より説明の前出しが効く。

追記イメージ:

```md
## Claude Code を編集長として使う

- `/draft-topic`: テーマから `topics/<slug>.txt` を作る
- `/write-article`: `article:create` → `article:refine` → 各種検証 → GO/NO-GO
- `article-editor-in-chief`: 進行管理・品質判断・公開可否の推奨
- `article-factchecker`: Web 裏取り
- `article-build-verifier`: コード実機検証
- `article:review-editorial`: 読者・編集視点の独立レビュー
- 最終公開判断はユーザーが行う
```

ポイント:

- CLI 単体の説明だけでなく、Claude Code 側の操作と対応する CLI コマンドを並べる。
- 「本文を直接編集しない」「修正は `article:revise` 経由」「export はユーザー承認後」を明記する。
- `init` が `.claude/` と `CLAUDE.md` を配布することを、単なる付属物ではなく主要価値として扱う。

### 2. `publication-check.md` を標準成果物にする

編集長の最終判断を、会話の中だけでなく run の証跡として残す。

保存先:

```text
runs/<runId>/publication-check.md
```

テンプレート案:

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

まずは `article-editor-in-chief` の手順に「GO/NO-GO 推奨前に作成する」と追加するだけでよい。CLI コマンド化は後回しでよい。

### 3. `claims.json` / `sources.json` を factchecker の標準出力にする

現在の factcheck は `factcheck-instruction.md` に修正指示をまとめる形だが、根拠管理としては機械可読な台帳が欲しい。

保存先:

```text
runs/<runId>/claims.json
runs/<runId>/sources.json
```

`claims.json` 案:

```json
[
  {
    "id": "C001",
    "location": "該当見出しまたは本文位置",
    "claim": "検証すべき主張",
    "type": "api|price|version|technical|general",
    "status": "verified|needs-source|incorrect|unverified",
    "sourceIds": ["S001"],
    "severity": "major",
    "note": "修正指示または判断メモ"
  }
]
```

`sources.json` 案:

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

ポイント:

- Web 取得や検証判断は引き続き `article-factchecker` が担う。
- CLI 本体は当面、Web fetch を持たない。
- 将来の `article:verify-artifacts` や公開済み記事更新フローの入力にできる。

### 4. `build-verify-report.json` を追加する

`build-verify-instruction.md` は修正指示としては有効だが、検証証跡としては弱い。コードを含む記事では、実行条件と結果を report として残す。`article:verify-artifacts` の検証対象になるため、先に標準化する。

保存先:

```text
runs/<runId>/build-verify-report.json
```

項目案:

```json
{
  "status": "passed|failed|partial|skipped",
  "skipReason": "",
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

> `skipReason` は `status: "skipped"`（`checkedBlocks: []`）で理由が消えないようトップレベルに置く（実装時のレビュー反映）。

### 5. `article:verify-artifacts` を追加する

各検証の中身を再判定するのではなく、公開前に必要な成果物が揃っているかをチェックする軽量コマンド。
検証対象（`publication-check.md` / `claims.json` / `sources.json` / `build-verify-report.json`）が標準化された後に置く。

コマンド案:

```bash
llm-task-router article:verify-artifacts --run <runId>
```

チェック例:

- `final.md` が存在する。
- `final-review.md` が存在する。
- `publication-check.md` が存在し、GO/NO-GO が記載されている。
- `factcheck-instruction.md` または factcheck skip 理由がある。
- `build-verify-report.json` が存在しスキーマ適合（`status: "skipped"` の場合は `skipReason` 非空）。コードを含む記事で `status: "skipped"` は警告。
- `editorial-review.md` または editorial-review skip 理由がある。
- `claims.json` に unresolved な critical / major が残っていない。

このコマンドは外部通信を行わないため、安全方針と相性が良い。

### 6. 公開済み記事更新で claim 差分だけ再検証する

既存の `article:update-diff` は良い基盤である。次の段階では、`changed-sections.json` と `claims.json` を結びつけ、変更された claim だけを重点的に再検証する。

狙い:

- 全文ファクトチェックを毎回やらない。
- 価格、API、モデル名、バージョンなど陳腐化しやすい claim を優先する。
- 同一 URL・同一記事としての更新リライトと相性が良い。

前提:

- `claims.json` の schema と運用が安定してから着手する。

## 後回しにする案

以下の CLI コマンド化は、方向性は良いが現段階では優先度を下げる。

```bash
llm-task-router article:claims
llm-task-router article:sources
llm-task-router article:fact-check
llm-task-router article:citation-check
```

理由:

- CLI 本体に Web 取得や出典解釈を持たせると、現在の「HTTP API を公開せず、任意 URL 取得を行わない」という安全方針と衝突しやすい。
- `llm-task-router` の強みは薄い実行レイヤーであり、重い RAG / crawler / factcheck engine へ寄せすぎると設計がぼやける。
- まずは `.claude/agents` 側の出力規約として `claims.json` / `sources.json` / `publication-check.md` を安定させ、その後 CLI が検証する順番がよい。

## 結論

次に取り組むべきは、文章をさらにうまくする機能ではなく、Claude Code 編集長が公開判断できる根拠を run に残す仕組みである。

推奨順:

1. `publication-check.md` を標準成果物にする。
2. README に Claude Code 編集長章を追加する。
3. `article-factchecker` に `claims.json` / `sources.json` を出させる。
4. 技術記事向けに `build-verify-report.json` を追加する。
5. 成果物が揃っているかを確認する `article:verify-artifacts` を追加する。

この順番なら、既存の薄い ModelRouter 思想を保ったまま、Claude Code 編集長モデルの説得力と運用品質を上げられる。

---

## レビュー所見（2026-06-20）

提案書と現状コードを突き合わせて検討した結果。**採否：採用（実施順を一部修正）**。

### 前提の裏取り

- README に「Claude Code を編集長として使う」章は実在しない（`README.md` / `README.ja.md` を確認）。#2 のギャップは本物。
- CLI コマンド名（`article:create` / `refine` / `evaluate` / `revise` / `export` / `update-diff` / `record-publication` / `review-editorial` 等）、`.claude/agents` 構成（editor-in-chief / factchecker / build-verifier）は提案の記述どおり。
- factchecker は現状 `factcheck-instruction.md`、build-verifier は `build-verify-instruction.md` を出力。機械可読台帳（`claims.json` 等）は未導入。提案の現状認識は正確。

### 方向性の評価

「文章生成能力をこれ以上いじらず、公開判断の"根拠"を run に証跡として残す」という軸は、本リポジトリの思想（薄い ModelRouter ＋ 検証は外側AIに委譲）と一致する。CLI に Web 取得を持たせる案を最後尾へ落とし、安全方針（HTTP API を公開しない／任意 URL を取らない）との衝突を自覚している点も妥当。

### 同意する点

- **#1 publication-check.md**：実質ゼロコスト。editor-in-chief には既にゲート実施チェックリスト提示の手順がある。新規性は「会話に出すだけでなくファイルに残す」点のみ。エージェント手順に「`runs/<id>/publication-check.md` に書き出す」を一行足すだけ。
- **#2 README 章**：実装ですらなく文章なので即着手可。ただし追記イメージは CLI との対応が薄い。`docs/qiita-article-howto.md` 末尾の「工程↔担当AI↔CLIコマンド」対応表を README に要約転記する形が目的に最も効く。
- **#5 verify-artifacts**：外部通信なしのファイル存在チェックで安全方針と相性が良い。ただし #1・#3・#4 が標準化された後でないと検証対象が無く、後段配置は正しい。

### 異論・要注意点

1. **#3 のコスト見積もりが楽観的（最大の地雷）**：実コストはスキーマではなく運用の安定化にある。claim `id` の安定性（改稿後も同一 claim に振り直せるか）、`location`（"該当見出し" は改稿でズレる）、`status` 遷移の定義が固まらないと #6 の入力にならない。editorial-review の weakness id がラウンドをまたいで安定する仕組み（`src/schemas/EditorialReviewContinuationSchema.ts`）を参照すべき。
2. **JSON 台帳を「誰が書き、誰が検証するか」が曖昧**：エージェントに手で JSON 生成させるとフォーマット揺れが必至。「CLI は Web 取得を持たない」は明言されるが「JSON の**検証**は持つのか」が未定。**取得は持たない／検証は持つ**を #3 段階で確定すべき。
3. **publication-check と README の順序入れ替え**：publication-check の方が依存が少なく単独で完結し、運用証跡という本丸価値が即出る。README はいつでも書ける文章タスク。**publication-check を先頭**にする。

### 確定した実施順

1. `publication-check.md` 標準化（エージェント手順に一行追加）
2. README「Claude Code を編集長として使う」章（howto の対応表を転記）
3. `claims.json` / `sources.json` — 着手前に id 安定化戦略と検証責任の所在を設計メモで固める
4. `build-verify-report.json`（`verify-artifacts` の検証対象なので先に標準化）
5. `article:verify-artifacts`（schema 検証込み。検証対象が揃った後に置く）
6. 公開済み記事更新の claim 差分再検証（claims 運用が安定してから）

詳細仕様は [claude-editor-improvement-spec.md](claude-editor-improvement-spec.md) を参照。
