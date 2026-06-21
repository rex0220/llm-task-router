# 生成AI 編集レビューの自動化 仕様案

> ステータス: 採用（第1段＋第2段 実装済み・第3段 WS8 クローズ。Codex レビュー12巡反映） / 対象: llm-task-router 記事パイプライン / 作成: 2026-06-20・更新: 2026-06-20
> 関連: [update-article-spec.md](update-article-spec.md) / [qiita-article-howto.md](qiita-article-howto.md)

## 1. 目的

手動で行っている「**読者・編集視点の外部レビュー（ChatGPT）→ 指摘を反映して改稿**」を、パイプライン内の自動工程として再現する。これにより、本文生成(OpenAI)→ 技術審査(Claude judge)→ **編集レビュー(別モデル)** → 事実検証(Web factcheck / 実機 build-verify)→ 改稿、という多角な「AI編集部」を成立させる。

あわせて、API はステートレスである点を踏まえ、**前回レビューを踏まえた継続再レビュー**を明示的に設計する（チャットの“勝手に踏まえる”を、制御可能な形で再現する）。

## 2. 背景（現行資産）

編集レビューの部品はすでに大半が存在する。

- **LLM-as-judge**: `final_review` タスクが既にある（[createQiitaArticle.ts: runFinalEvaluation](../src/workflows/createQiitaArticle.ts) / [ReviewResultSchema](../src/schemas/ReviewResultSchema.ts)）。`evaluate → revise → refine` のループで回る。ただし観点は「技術レビュー」寄り。
- **別系統の検証**: factchecker / build-verifier は Claude Code サブエージェントで、事実・実機を担う（本文 = OpenAI と別系統）。
- **差分集中**: `article:update-diff` が `update-diff.md` / `changed-sections.json` を生成（[updateDiff.ts](../src/cli/updateDiff.ts)）。
- **rubric**: `config/criteria/default.md` に評価観点＋「審査側の断定禁止」ガード。
- **正規化と適用**: 指摘は `revise-instruction.md` に整形され `article:revise --instruction-file` で本文へ戻る。

手動の ChatGPT レビューは「**軸別スコア＋強み＋弱み（重大度つき）＋好みレベルの指摘**」という**編集講評**で、`final_review` の `issues[]`（技術指摘の配列）より“エッセイ＋採点”寄り。

→ 不足しているのは **(a) 編集視点の独立レビュー工程** と **(b) 前回を踏まえた継続再レビュー** の2点。本仕様はこの2点を、既存プリミティブの上に定型化する。

## 3. 現行実装との整合（確認済み事実）

| # | 事実 | 含意 |
|---|---|---|
| E1 | `ModelRouter` はタスク → provider/model を `config/models.yaml` で解決する。 | 新タスク `editorial_review` の追加が自然。レビュアーのモデルは**設定で差し替え可能**。 |
| E2 | **API はステートレス**。1コールは入力に入れたものだけが文脈。 | 「前回レビューを踏まえる」は自動では起きない。**入力へ明示同梱**が必須（§5.5）。 |
| E3 | `refine` は毎ラウンド `final.md` を**素読み**する（前回レビューを渡していない）。 | 既定は「独立モード」。継続にするには reviewer 入力に前回＋差分を足すだけ。 |
| E4 | `evaluate` は `ReviewResult(issues[])` を `revise-instruction.md` に整形して `revise` へ渡す。 | 編集レビューは整形に**専用 formatter** を使うが（§5.4）、**`instruction.md → article:revise` の適用経路は同じ**で再利用できる。 |

## 4. スコープ

### やること
- `editorial_review` タスク（読者・編集視点の講評）を追加し、**書き手と別モデル**で回す。
- **独立レビュー / 継続レビュー**の2モードを定義し、継続では前回レビュー＋差分を同梱する。
- rubric（編集観点）を criteria で固定し、断定ガードを適用する。
- 出力（スコアカード＋弱み）を機械フィルタで `editorial-instruction.candidates.md` に出し、**編集長が採否トリアージして `editorial-instruction.md` に確定**したものを `article:revise` で適用する（§5.4/§5.6）。

### やらないこと
- **事実検証の置換**（factchecker / build-verifier は維持。編集レビューは正確性ゲートではない）。
- `final.md` の直接編集（修正は必ず `article:revise` 経由）。
- 自走での公開・更新（公開相当はユーザー承認後）。
- **書き手と同一モデルでの「独立レビュー」主張**（自己採点は独立性が低い、§10）。

## 5. 設計

### 5.1 レビュアーは書き手と別モデル（独立性）— 設定だけでなく実機で保証する
本文を OpenAI が書く構成では、レビューも OpenAI にすると**同一モデルの自己採点**になり盲点を共有する。`editorial_review` は **candidate set を両 provider にまたがせ（primary は通常の `finalAuthorModel` と別 provider を優先）、実行時に `finalAuthorModel` の provider を除外して選ぶ**（詳細は下記の各則＋§13）。「ChatGPT のレビューを再現」したい場合でも、独立性のために**用途を文章・構成・読みやすさ・専門概念の網羅に限定**し、事実判断は factcheck に委ねる。

ただし「タスク別に別モデルを設定した」だけでは独立性は保証されない（実際に使われたモデルが一致し得る／fallback で同系統へ落ち得る）。次を満たす:

- **基準は「最終 author」（`finalAuthorModel`）**: 独立性の比較対象は「本文生成時のモデル」ではなく「**現在の `final.md` を最後に生成・改稿したモデル**」。`final.md` は create の final step・`article:revise`・refine 内 revise で繰り返し書き換わる（[createQiitaArticle.ts](../src/workflows/createQiitaArticle.ts)）。よって **`final.md` を更新する全経路で `RunMeta.finalAuthorModel`（= 直近 rewrite の `{provider, model}`、実応答ベース）を更新**する。import run は外部/人間由来なので **import 直後は `finalAuthorModel = "external"`（unknown）**。`editorial_review` 実行時は実応答した reviewer を `RunMeta.reviewerModel` に記録。
- **独立性ポリシーは「別 provider 必須」に統一**: 既定で **reviewer の provider が `finalAuthorModel` の provider と異なる**ことを必須とする（同 provider は訓練・傾向を共有しうるため、model 違いでも独立とみなさない）。一致したら**失敗**。override は段階的に明示: `--allow-same-provider`（同 provider 別 model を許可）/ `--allow-same-model`（完全同一まで許可）。**包含関係**: `--allow-same-model` は same-provider を**含む**（完全同一は当然 same-provider なので、`--allow-same-provider` の上位互換。両方を渡す必要はない）。`finalAuthorModel = "external"` のときは独立性チェックを**免除**（人間/外部由来）。
- **独立性は実行時の provider 選択で担保する（静的 config だけに頼らない）**: `finalAuthorModel` は**実行時に変わる**（例: 通常 `rewrite=openai` だが fallback で anthropic になり得る。すると静的に `editorial_review=anthropic` と書いていても独立性違反）。よって `editorial_review` を呼ぶ**前に**、primary＋fallback の candidate から **`finalAuthorModel.provider` と同 provider を除外**し、残った別 provider の candidate を順に試す。これで「使える別 provider fallback があるのに事後 fail で到達できない」状態を避ける。
- **失敗条件と安全網**: 別 provider candidate が**1つも無いときだけ失敗**（override で緩和可）。加えて、**実応答後に再チェック**（実際に応答した provider/model が許可範囲か）を安全網として残す。
- **override × candidate filter の挙動（実装分岐を一意に）**:
  - 既定（override 無し）: `finalAuthorModel.provider` と**同 provider の candidate を除外**。残らなければ失敗。
  - `--allow-same-provider`: provider 除外を**解除**（同 provider 別 model を許可）。ただし `finalAuthorModel` と**完全同一 model の candidate は依然除外/拒否**。
  - `--allow-same-model`: 上位互換。**完全同一 model も許可**（除外なし）。
  - **実応答後の再チェックも同じ override レベルの条件で判定**する（事前 filter と recheck の基準を一致させる）。
- **実装境界**: 除外は `ModelRouter` の候補組み立てに効かせる。手段は **(a) `ModelRequest` に `excludeProviders?` / `candidatePolicy` を足し、`ModelRouter.run()` が候補を組む際に適用**するか、**(b) `editorial_review` 専用の wrapper/helper で provider を事前解決**して呼ぶ、のいずれか（§13）。`OpenAIProvider`/`AnthropicProvider` の HTTP request 形は変えない。

### 5.2 `editorial_review` タスクと出力スキーマ（新規 `EditorialReview`）
手動 ChatGPT レビューの体裁に合わせ、`issues[]` だけでなく**スコアカード**を持つ schema を**新設**する。現行 `ReviewResultSchema` の severity は `critical|major|minor|suggestion` で、本仕様の `preference` を含まないため**そのままでは互換しない**。専用スキーマと `SchemaName` を追加する。

**raw（モデル出力）と normalized（保存後）を分ける**。モデルは **id を作らない**＝raw に id を含めず、**パイプラインが id を採番して normalized に出す**。`SchemaName` に2つ追加（[router/types.ts](../src/router/types.ts)）、[src/schemas/](../src/schemas/) に新規。

**Raw（独立モード）= `EditorialReview`**（モデル出力。id なし）:

```jsonc
{
  "verdict": "publication-candidate | needs-revision | rework",
  "scores": [ { "axis": "科学的正確性", "score": 9.0 }, { "axis": "構成", "score": 9.5 } ],
  "strengths": ["一本の因果線を維持している"],
  "weaknesses": [
    { "severity": "major|minor|preference", "location": "補論/Q値", "problem": "...", "recommendation": "..." }
  ],
  "summary": "..."
}
```

**Raw（継続モード）= `EditorialReviewContinuation`**（モデル出力。前回 id は**入力で渡された既知 id を参照するだけ**、新規には id を付けない）:

```jsonc
{
  "verdict": "...", "scores": [...], "strengths": [...],
  "trackedWeaknesses": [ { "id": "<入力で渡した既知id>", "status": "resolved|open|partial", "evidence": "..." } ],
  "newWeaknesses": [ { "severity": "major|minor|preference", "location": "...", "problem": "...", "recommendation": "..." } ],
  "summary": "..."
}
```

**Normalized（保存後 `editorial-review.json`）**: パイプラインが新規 weakness に **id を付与（連番＋内容ハッシュ）**し、tracked と統合した `weaknesses[]`（`id` 付き・`status` 付き）として保存する。`severity` は **`major|minor|preference` の3値**。**新規 weakness（独立 raw の全 `weaknesses` ／ 継続 raw の `newWeaknesses`）は normalized 時に `status: "open"` で起票**する（→ §5.4 の `open|partial` フィルタに直結）。継続の status 台帳もここで更新する（モデルが前回 id を返し忘れても open のまま残す、§5.5）。

### 5.3 rubric（編集 criteria）＋断定ガード — 専用キーで固定し brushup に上書きされない
`config/criteria/editorial.md`（新規）にレビュー観点を固定する: 軸（正確性/構成/教育的価値/専門性/読みやすさ/媒体適性）、**辛口度の指示**（「強みの追認で終わらせず、具体的な弱みと重大度を出す」「専門記事なら期待される具体概念の不足を名指しする」）、および**断定ガード**（「API・バージョン・専門値を裏付けなく断定しない／本文の慎重な保留を反転させない」）。

**解決順の衝突に注意**: 現行 `evaluate` の criteria 解決は「明示指定 > run の `brushup-criteria.md` > profile の `criteria_file` > なし」で、**`brushup-criteria.md` が profile より優先**される（[index.ts: resolveEvaluationCriteria](../src/index.ts)）。編集レビューの**固定 rubric がブラッシュアップ条件に上書きされる**と観点がブレるため、混ぜない:

- profile に**専用キー `editorial_criteria_file`** を追加（`criteria_file` とは別系統。既定 `config/criteria/editorial.md`）。
- 編集レビューの入力は「**固定 rubric（`editorial_criteria_file`、上書き不可）** ＋ **追加コンテキスト（`brushup-criteria.md` 等があれば“補足観点”として末尾に連結）**」の**合成**にする。固定 rubric が常に主舵で、brushup は追加情報に留める。

### 5.4 出力の正規化 — 専用 formatter（既存の `buildRevisionInstruction` は流用しない）
既存の `buildRevisionInstruction` は `critical|major|minor|suggestion` 前提なので、`EditorialReview` の3値には**専用 formatter** を用意する。さらに「**機械が出した候補**」と「**編集長が確定した適用指示**」を**別ファイルに分けて自動適用を防ぐ**。

- **②候補（機械フィルタ）**: formatter は **`severity ∈ {major, minor}` かつ `status ∈ {open, partial}`** の `weaknesses` だけを `editorial-instruction.candidates.md` に整形する（`preference` と **`resolved`** は除外。継続で解決済みを再指示しない）。これは**候補であり、まだ適用しない**。
- **③確定（編集長）**: `article-editor-in-chief` が候補を取捨し、採用分を **`editorial-instruction.md`（確定版）** として書く（§5.6③）。`article:revise`（④）が読むのは**この確定版のみ**。**候補ファイルを直接 revise に渡さない**（自動適用事故の防止）。
- `preference` は `editorial-review.md` に「好みレベル（任意適用）」として別掲し、編集長/筆者が選別（§5.6）。
- 既存 `revise` 経路（`ReviewResult` の severity 重みや refine スコア）と**混線させない**。確定版は `article:revise --instruction-file` で適用するテキストで、`final_review` の採点スコアには加算しない。

`runs/<id>/` に保存:
- `editorial-review.json`（**normalized スコアカード**＝weakness に id/status 付与済み。§5.2。モデルの raw 出力そのままではない）
- `editorial-review.md`（人が読む講評＝軸別スコア・強み・弱み・verdict・preference 別掲）
- `editorial-instruction.candidates.md`（**②機械フィルタ後の候補**。major\|minor ＋ open\|partial。preference・resolved 除外。**まだ適用しない**）
- `editorial-instruction.md`（**③編集長が確定した適用指示**。④ `revise` が読む**唯一**のファイル）

### 5.5 継続レビュー vs 独立レビュー（API ステートレス対応）
E2 のとおり、API は前回を覚えない。再レビューの**文脈構成**を明示的に選ぶ。

- **独立モード（既定の素読み）**: `final.md`（または差分）だけを渡す。偏りのない新鮮な眼。`refine` の現挙動と同じ。
- **継続モード**: 入力に **(1) 前回レビューの未解決 `weaknesses`（ID つき） (2) 前回レビュー時点 → 現在の差分** を同梱し、「前回指摘が差分で解消されたか判定し、**変更起因の新規問題だけ**追加せよ」と指示する。

> **差分の基準に注意（重要）**: 現行 `update-diff.md` は `update-base.md → final.md` の**累積差分**（import 時点が起点。[updateDiff.ts](../src/cli/updateDiff.ts)）であり、**前回レビュー時点からの差分ではない**。これをそのまま継続レビューに渡すと「直ったか／変更起因の新規問題だけか」を判定できない。継続レビューには**ラウンド境界の差分**が必要:
>
> - **ラウンド別成果物**: `editorial-r<N>-review.{json,md}` を残す（refine の `refine-r<N>-*` と同方針）。
> - **レビュー時点スナップショット**: 各レビュー実行時の本文を `editorial-r<N>-before.md` として固定する（これが since-last 差分の正本）。前回 `final.md` の同一性は本文スナップショットそのもので担保するため、`meta` への hash 記録は行わない。
> - **since-last 差分**: 継続モードは `editorial-r<N-1>-before.md`（前回レビュー時点）→ 現 `final.md` の差分を生成して渡す（`update-base.md` 起点の `update-diff` ではなく、**前回レビュー起点**）。
> - **weakness 解決追跡（所有者＝パイプライン）**: `weakness.id` は**パイプラインが採番・台帳化**する。継続レビューでは前回の**未解決 weakness を id 付きで入力に渡し**、モデルには各 id について `trackedWeaknesses: [{ id, status: resolved|open|partial, evidence }]` と、**新規 `newWeaknesses[]`（id 無し）** を返させる。新規分の id はパイプラインが採番（連番＋内容ハッシュ）。closed 判定はモデルの `status` を編集長/パイプラインが受けて台帳更新する。**モデルが前回 issue を出し忘れても open のまま残る**（黙って消えない）ので、追跡が LLM 任せにならない。

- **推奨ハイブリッド**: 各ラウンドは**継続（since-last 差分集中）**、数ラウンドに一度または最終に**独立フル読み**を挟む（アンカリングを定期リセットし見落としを拾う）。

> 継続モードは「直ったか追跡」に強い一方、毎回前回を食わせると**自分の前回結論を追認しがち（アンカリング）**になる。独立モードを定期的に挟むことで、継続の利便と独立の鋭さを両取りする。

### 5.6 採否の判断ポイントと主体（誰が・どこで「反映するか」を決めるか）

**原則: 外部レビュー（ChatGPT）は「指摘を出す」だけで、採否は決めない**。反映するか否かは、レビュアーとは別の主体が、定義された地点で判断する（レビュアー＝決定者にしない）。判断は次の5地点に分かれる。

| # | 判断ポイント | 決める主体 | 既定ルール | エスカレーション |
|---|---|---|---|---|
| ① | レビューを回すか・モード・独立性 | パイプライン（自動） | `finalAuthorModel` と**別 provider 必須**（§5.1） | 同 provider は人間が `--allow-*` で明示 |
| ② | 指摘の一次選別（機械フィルタ）→ **候補** `editorial-instruction.candidates.md` | パイプライン formatter（§5.4） | `severity∈{major,minor}` かつ `status∈{open,partial}` を候補に。**preference・resolved 除外**。**まだ適用しない** | — |
| ③ | **採否トリアージ → 確定** `editorial-instruction.md` を書く | **`article-editor-in-chief`（編集長エージェント）** | 候補から採用分を確定版に書き出す。major/minor は原則採用。**事実に関わる指摘は編集レビュー単独で確定せず factcheck/build へ回す** | **preference・既存方針との衝突・大きな構成変更は筆者（人間）へ** |
| ④ | 改稿の適用 | パイプライン（`article:revise`） | **③の確定版 `editorial-instruction.md` のみ**を適用（候補ファイルは渡さない／**本文は手書きしない**） | — |
| ⑤ | **最終確認・公開 GO** | **筆者（人間）** | 公開相当はユーザー承認後（CLAUDE.md） | — |

- **Claude Code（進行・統括）はオーケストレーション役**: ①②④ を実行し、③を編集長へ委譲、③のエスカレーションと⑤を人間に上げる。**Claude Code 自身は編集採否（③）も公開（⑤）も決めない**（CLAUDE.md: 品質判断＝編集長、公開＝ユーザー承認）。
- **preference は既定で自動適用しない**（②で instruction から除外済み）。採るかは編集長の提案＋筆者の判断。
- 手動運用での A/B 選別は実体として**筆者が③を担った**ケース。自動運用では**③の既定を編集長に委譲し、preference・衝突・最終可否を筆者に残す**のが既定。

> **開示文（記事冒頭 note）にも主体を書く**。「外部レビュー: ChatGPT」だけでなく、**誰が反映を決めたか**まで明示する。例: 「外部レビュー: ChatGPT（指摘の**採否は編集長 Claude が判断**、preference と**最終可否は筆者**）」。手動で筆者が選別した記事では「採否は筆者が判断」と事実どおりに書く。

## 6. 中核フロー

```
final.md（または update-diff）
  → editorial_review（別モデル・rubric固定・継続/独立モード）
  → editorial-review.{json,md} / editorial-instruction.candidates.md を生成（②機械フィルタ・候補）
  → 採否トリアージ（§5.6: ③編集長が候補を取捨し editorial-instruction.md を確定 / preference・衝突・最終可否は筆者）
  → article:revise --instruction-file editorial-instruction.md（④確定版のみ適用）
  → （必要なら）factcheck / build-verify で正確性ゲート
  → 次ラウンド: 継続モードで「前回未解決（id付き）＋ since-last 差分」を再レビュー
  → 収束（verdict=publication-candidate 等）or ラウンド上限
  → ⑤ 筆者が最終確認・公開 GO
```

技術審査(`final_review`)・事実検証(factcheck/build)・**編集レビュー(`editorial_review`)** は**別系統の3レンズ**として併存する。

## 7. 生成・参照される成果物

| ファイル | 役割 | 区分 |
|---|---|---|
| `config/criteria/editorial.md` | 編集レビューの固定 rubric＋断定ガード（`editorial_criteria_file`、§5.3） | 新規 |
| `runs/<id>/editorial-review.json` / `.md` | 最新ラウンドのスコアカード／人が読む講評（preference 別掲） | 新規 |
| `runs/<id>/editorial-instruction.candidates.md` | **②候補**（severity major\|minor ＋ status open\|partial。preference・resolved 除外。まだ適用しない） | 新規 |
| `runs/<id>/editorial-instruction.md` | **③編集長が確定した適用指示**（④ revise が読む唯一のファイル） | 新規 |
| `runs/<id>/editorial-r<N>-review.{json,md}` | ラウンド別レビュー（継続の解決追跡用） | 新規 |
| `runs/<id>/editorial-r<N>-before.md` | レビュー時点の本文スナップショット（since-last 差分の起点、§5.5） | 新規 |
| `runs/<id>/meta.json` | `finalAuthorModel` / `reviewerModel`（§5.1） | 既存＋拡張 |
| `runs/<id>/update-diff.md` / `changed-sections.json` | 参考（**累積差分**。継続は since-last 差分を別途使う、§5.5） | 既存 |

## 8. CLI 案

```sh
# 編集レビュー（独立 or 継続）→ editorial-review.{json,md} ＋ editorial-instruction.candidates.md（②候補）
llm-task-router article:review-editorial --run <id> \
  --mode independent|continuation \
  [--allow-same-provider]  # finalAuthor と同一 provider の別 model を許す
  [--allow-same-model]     # 完全同一モデルまで許す（same-provider を含む上位互換。既定はどちらも拒否、§5.1）

# ③編集長が候補を取捨して editorial-instruction.md（確定版）を書く → ④それだけを適用
# （候補 .candidates.md を直接 revise に渡さない）
llm-task-router article:revise --run <id> \
  --instruction-file runs/<id>/editorial-instruction.md
```

- `--mode continuation` は **前回ラウンドのレビュー（未解決 weakness を id 付きで）＋ since-last 差分**（`editorial-r<N-1>-before.md` → 現 `final.md`）を入力に組む（§5.5）。累積 `update-diff.md` は使わない。
- reviewer の実応答 provider が `finalAuthorModel` と**同一なら既定で失敗**（`--allow-same-provider` / `--allow-same-model` で段階的に明示許可。`finalAuthorModel = external` は免除）。
- `refine` への組み込みも可能だが、まずは**独立コマンド**として出し、編集長が呼ぶ運用にする（過剰自動適用を避ける）。

## 9. 想定される効果と差（自動化の評価指標）

自動化の差は「**ばらつき（ノイズ）**」と「**系統的な偏り（方向性）**」に分かれる。

| 軸 | 自動化での差 | 緩和 |
|---|---|---|
| 構成・読みやすさ・体裁 | ほぼ同等に再現可（rubric で安定） | — |
| 定量・標準概念の不足指摘 | 明示プロンプトで再現可。素だと浅い | rubric で「期待概念の不足を名指し」を要求 |
| 事実・技術の誤り検出 | 同一モデルだと甘い（独立性低下） | 別モデル化＋factcheck 併用 |
| 好み／読者層／トレードオフ判断 | 最も再現しにくい | 編集長/人間のトリアージを残す |
| スコア再現性 | 単発は±数点ぶれる | 温度低め（現行設定で可）。**seed は provider API 側が非対応**（OpenAI Responses API / Anthropic messages）＝固定不可。安定化は複数サンプル中央値だが将来枠（§11 第3段はクローズ） |

**効果（得られるもの）**: オンデマンドな反復（毎改訂・多記事）、rubric 固定による**比較可能なスコア**、早期フィードバック、工程の**透明性・ログ化**（「AI編集部」主旨に合致）。
**限界（得られないもの）**: 正確性の保証（factcheck の代替不可）、鋭い専門指摘の“当たり”は確率的、同一モデルだと同質化。

**評価の取り方（任意）**: 手動レビューと自動レビューで、(a) 総合スコア差、(b) major 指摘の一致率、(c) 自動適用後に factcheck が捕える誤りの件数、を実測して有効性を検証する。

## 10. リスクと緩和

- **自己レビュー偏り**: 書き手と同一モデルは盲点共有 → **別モデル必須**（§5.1）。
- **ハルシネーション/過剰断定**: 編集レビューも誤指示を出しうる（実例: refine 審査が正しい記述を「直せ」と誤指示）。→ 断定ガード（§5.3）＋ **factcheck/build-verify を正確性ゲートとして維持**。自動適用だけで確定しない。
- **アンカリング（継続モード）**: 前回追認で新鮮さ低下 → **独立フル読みを定期的に挟む**（§5.5）。
- **過剰自動適用**: preference まで自動で当てると記事が好ましくない方向へドリフト → 編集長/人間トリアージ（§5.6）。
- **変動**: 単発は不安定 → rubric 固定・低温度（現行可）。seed は provider API 非対応で固定できない。複数サンプル中央値が安定化レバーだが将来枠（§11 第3段）。

## 11. 段階的導入

1. **第1段（独立レビュー）**:
   - **`EditorialReview`（独立モード）schema** ＋ `SchemaName` に `"EditorialReview"` 追加（§5.2）、専用 formatter（§5.4）。継続用 `EditorialReviewContinuation` は第2段で追加。
   - `editorial_review` タスク（**`ModelTask` enum/型 ＋ `models.yaml` の両方**）＋ `editorial_criteria_file`（§5.3）。
   - **`finalAuthorModel`（final.md 更新経路で更新・import は external）/ `reviewerModel` の記録、独立性＝実行時に `finalAuthorModel.provider` と同 provider candidate を除外して選択（別 provider が無ければ失敗・override フラグ）＋実応答後の再チェック**（§5.1）。**実装は `ModelRequest.excludeProviders`（or `candidatePolicy`）を `ModelRouter` で適用、または専用 wrapper**（§13。provider 実装の HTTP request 形は不変）。
   - `article:review-editorial --mode independent`（素読み）と出力正規化。
   - **運用接続（Claude Code 側の設定。詳細 §12）**: `.claude/agents/article-editor-in-chief.md` に編集レビュー工程＋③トリアージ責務を追記、`/review-editorial` command 新設、`.claude/settings.json` allowlist 追加、CLAUDE.md に原則1行（templates と repo 両方）。
2. **第2段（継続レビュー）**: `--mode continuation`。**`EditorialReviewContinuation` schema ＋ `SchemaName` 追加**、**ラウンド別成果物**（`editorial-r<N>-review`/`editorial-r<N>-before.md`）、**weakness ID による解決追跡**、**since-last 差分**（§5.5）。編集長トリアージのスキル連携。
3. **第3段（安定化・評価）— クローズ**（決定 2026-06-20。実装計画 [editorial-review-plan.md](editorial-review-plan.md) WS8）:
   - **ハイブリッド運用（継続＋定期独立フル読み）は実装済み**（独立の `closeMissing` ＋継続の status 追跡）。
   - **seed は現スタックで N/A**（OpenAI Responses API / Anthropic messages とも非対応）＝追加しても dead code。実装しない。
   - **複数サンプル中央値・評価ハーネスは将来枠**（seed 不可ゆえの理屈上の安定化レバーだが、安定化対象は informational なスコアカードで価値中程度／ハーネスはオフライン研究ツール）。

## 12. Claude Code（進行・統括）側の設定変更

**結論: 必要**。ただし肝は「**編集レビュアー自体は Claude Code のサブエージェントではなく、パイプラインのモデルタスク（`editorial_review`）**」という切り分け。Claude Code 側で要るのは**進行・トリアージ・許可**の接続だけ。

### 12.1 どこがパイプラインで、どこが Claude Code か
- **編集レビュアー = パイプライン**（`editorial_review` タスク／別モデル）。Web も実行も要らない純 LLM 呼び出しなので、factchecker/build-verifier のような**サブエージェントにはしない**（`config/models.yaml` に置く）。→ **新規レビュアー subagent は作らない**。
- **進行・統括 = Claude Code**: `article:review-editorial` を回し、候補を編集長へ渡し、エスカレーションと公開を人間へ上げる。**採否（③）も公開（⑤）も決めない**（§5.6）。
- **採否トリアージ = `article-editor-in-chief`（既存サブエージェント）**: ③で候補→確定版 `editorial-instruction.md` を書く。

### 12.2 必要な設定変更（`.claude/` ＋ CLAUDE.md。templates と repo 両方）
1. **`.claude/agents/article-editor-in-chief.md`**: 編集レビュー工程と③トリアージ責務を追記 — `editorial-instruction.candidates.md` ＋ `editorial-review.md` を読み、採用分を `editorial-instruction.md` に**確定**、`preference`・方針衝突・大改変は**筆者へエスカレーション**、事実系は**factcheck へ回す**、**確定版だけ**を `article:revise` に渡す。
2. **`.claude/commands/review-editorial.md`（新規）**: `/review-editorial <run>` で編集レビューを起動（独立/継続、別 provider チェック）。出力は `editorial-instruction.candidates.md`。
3. **`.claude/settings.json` allowlist**: **標準運用 / 厳格運用の選択制**（§12.3）。既定（標準）は既存 pipeline allowlist と**同形**で `Bash(llm-task-router article:review-editorial:*)` を追加（evaluate/refine と同列の安全な読み/LLM 工程）。`article:revise` は既存で許可済み。
   - 形式の注意: templates の既存エントリはすべて `Bash(llm-task-router article:<sub>:*)`（例 `article:create:*`）。末尾 `:*` は **Claude Code の prefix glob** で、`article:review-editorial --run <id>` の**スペース引数にも一致**する（既存 `article:create:*` が `article:create --topic-file ...` に一致するのと同じ）。インラインの ` *`（スペース）形に変えると既存エントリと不整合になるため**同形を維持**する。repo 側 `.claude/settings.json` は別途 `Bash(npm run *)` 等の開発用エントリを持つが、配布正本は templates 側。
4. **CLAUDE.md（root＋templates）**: 原則に1行 — 「編集レビューは別モデルの読者・編集批評。**採否は編集長、preference と最終可否は筆者、事実は factcheck 優先**」。
5. **（任意）`/write-article`・`/update-article` スキル**: 編集レビューを“もう一つのレンズ”として呼べる旨を追記。

### 12.3 allowlist 方針（標準運用 / 厳格運用の選択制）
編集レビューの allowlist は次の2運用から**選ぶ**（§12.2 #3 の既定は「標準運用」）。前提: `article:review-editorial:*` を allowlist すると override フラグ（`--allow-same-provider` / `--allow-same-model`、**独立性を緩める**。公開相当ではない）も無確認で通る。

- **標準運用（既定・推奨）**: allowlist に `Bash(llm-task-router article:review-editorial:*)` を**追加**する。反復レビューを承認なしで回せる。override も通るが、**独立性は CLI 側（§5.1: 既定で失敗）で担保**されるので安全側。
- **厳格運用**: `article:review-editorial` を **allowlist に入れない**。毎回プロンプトが出て、override フラグ付き呼び出しも**必ず人間が目視**できる。
  - 「基本形だけ許可し override は弾く」を狙うなら、allowlist 追加＋ `permissions.deny` で override を弾く案もある:

    ```jsonc
    "deny": [
      "Bash(llm-task-router article:review-editorial:* --allow-same-provider:*)",
      "Bash(llm-task-router article:review-editorial:* --allow-same-model:*)"
    ]
    ```

    ただし deny の**中間フラグ一致・引数順依存**で `--run X --allow-same-model` の並びを取りこぼし得る。採用前に**実機確認**。確実さを優先するなら「allowlist に入れない」を採る。

なお公開相当（`export` / `record-publication`）は **v0.2.31 で allowlist 化**され、コマンド実行プロンプトは出ない（公開可否は編集長 GO/NO-GO ＋ユーザー承認で担保。本節執筆時点の「allowlist に入れない」は失効）。

## 13. API 呼び出し設定（models.yaml / .env）への影響

**結論: 既存の API 呼び出し方法は変えない。** 影響は `config/models.yaml` への**追加**が中心で、`.env`/キーや provider 実装は原則そのまま。

| 設定 | 影響 | 内容 |
|---|---|---|
| `config/models.yaml`（タスク → provider/model） | **追加（必須）** | `editorial_review` タスクを1つ追加。**candidate set は「実行時に `finalAuthorModel.provider` を除外しても別 provider が残る」よう両 provider をまたぐ**構成にする。現行 `rewrite` は OpenAI primary / Anthropic fallback ＝writer はどちらの provider にもなり得るので、reviewer も両 provider を含める（例: primary=Anthropic / fallback=OpenAI）。**writer 常用 provider を reviewer の fallback に含めるのは runtime filter があるので独立性違反ではない**（§5.1） |
| `config/models.yaml`（`prices`） | 追加（推奨） | reviewer モデルの単価を未登録なら追加（ローカルのコスト概算用） |
| `config/models.yaml`（temperature 等のタスク設定） | 任意 | §9: reviewer は低温度が望ましい。per-task で設定できる範囲で低めに |
| `.env` / `api_key_env` | **原則変更なし** | reviewer は既存 provider を使うので既存キー（`OPENAI_API_KEY_ARTICLE` / `ANTHROPIC_API_KEY_ARTICLE`）を再利用。コスト/quota を分離したい場合のみ専用 `api_key_env` を任意で |
| provider 実装（HTTP request 形） | **変更なし** | `OpenAIProvider`/`AnthropicProvider` の request 組み立ては不変。`editorial_review` も同じ呼び方 |
| router の候補選択 | **小拡張（第1段）** | 独立性のため `finalAuthorModel.provider` を除外して候補を選ぶ機構が要る: **(a) `ModelRequest` に `excludeProviders?`/`candidatePolicy` を足し `ModelRouter.run()` が適用** or **(b) `editorial_review` 専用 wrapper で provider 事前解決**（§5.1）。前述「provider 実装は不変」と矛盾しない（HTTP 層ではなく候補選択層の追加） |
| `TaskConfig` / provider request（seed） | **変更なし（N/A）** | OpenAI Responses API / Anthropic messages とも **seed 非対応**のため追加しない（足しても dead code）。複数サンプル中央値は将来枠（§11 第3段クローズ） |

- **router の task enum/型 追加は必須**: `editorial_review` を `models.yaml` に足す**だけでは止まる**。`ModelTask` union と `modelTaskSchema` の enum（[router/types.ts](../src/router/types.ts) 等）に `editorial_review` を追加する（§11 第1段に含む）。`SchemaName` への `EditorialReview` 追加（§5.2）も同様にコード側の変更。
- **既存タスク（create/refine/evaluate/revise/draft/final_review/rewrite）の設定は不変**。純粋に追加。
- **独立性は routing「＋実行時 provider 選択」で担保**: `editorial_review` の candidate set は**両 provider をまたぐ**よう組み（writer が primary/fallback でどちらにもなり得るため）、実行時に `finalAuthorModel.provider` と同 provider を除外しても**必ず別 provider が残る**ようにする。writer 常用 provider を reviewer の fallback に含めること自体は runtime filter があるので違反ではない（§5.1）。逆に reviewer を OpenAI 単独に寄せると writer も OpenAI のとき候補が全落ち → `--allow-same-provider` が要る／用途を文章面に限定。
- **コスト/quota**: reviewer 分の API 呼び出しが（別 provider に）増える。反復レビュー・第3段の複数サンプルはコール増＝コスト増に直結。

---

## 付録: チャット繰り返し vs API 繰り返し（要点）

- チャットは**自動でステートフル**（スレッド全体が文脈）＝“踏まえる”が自動だが、ドリフト・迎合・非再現が付随。
- API は**ステートレス**＝前回は自分で渡す。代わりに**継続/独立を選べ、モデル・温度を固定でき再現的**（seed は provider API 非対応で固定不可＝§11 第3段クローズ。安定化は複数サンプル中央値だが将来枠）。
- よって「前回を踏まえた再レビュー」は API でも完全に可能（前回レビュー＋差分を入力に同梱するだけ）。むしろ**差分集中で蒸し返しを抑えつつ、独立読みで偏りをリセット**できる点が API の利点。

## 付録: Codex レビュー反映ログ（2026-06-20）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| 継続レビューの差分基準不足（`update-diff` は import 起点の累積差分で、前回レビュー起点ではない） | P1 | §5.5 に **since-last 差分**（`editorial-r<N>-before.md` 起点）・ラウンド別成果物・安定 weakness ID を追加。§7/§8/§11 も更新 |
| 「別モデル必須」が設定だけで保証できない（実使用モデル比較なし／fallback で同系統落ち） | P1 | §5.1 に **writer/reviewer 実使用モデルの記録・同一モデル拒否（`--allow-same-model`）・別 provider fallback** を追加 |
| `weaknesses.severity`(major/minor/preference) が `ReviewResultSchema`(critical/major/minor/suggestion) と非互換 | P2 | §5.2 に **`EditorialReviewSchema` 新設＋`SchemaName` 追加**、§5.4 に **専用 formatter（preference 除外・スコア非加算）** |
| editorial rubric が `brushup-criteria.md` に上書きされ得る | P2 | §5.3 に **専用キー `editorial_criteria_file`（上書き不可）＋追加コンテキスト合成順** |
| seed・複数サンプル中央値が現行 router 未対応 | P3 | §9/§10 を現状可能な範囲に修正、§11 第3段で **`TaskConfig`/provider への seed・サンプル数追加** に明記 |
| 運用接続（agent/command/allowlist）が未記載 | 確認 | §11 第1段に **editor-in-chief 追記・`/review-editorial` command・allowlist（templates 同期）** を追加 |

## 付録: Codex レビュー第2巡 反映ログ（2026-06-20）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| `writerModel` の基準が曖昧（final.md は import/create final/revise/refine で何度も書き換わる） | P1 | §5.1 を **`finalAuthorModel`（= 現 final.md を最後に改稿したモデル。final.md 更新の全経路で更新、import 直後は `external`）** に変更。§7/§8/§11 も統一 |
| weakness ID の安定性が LLM 任せ（採番・closed 判定の所有者が未定義） | P2 | §5.2/§5.5 で **id はパイプラインが採番・台帳化**。継続応答は `trackedWeaknesses:[{id,status,evidence}]` ＋ id 無しの `newWeaknesses[]`。出し忘れても open のまま残す |
| 別モデル/別 provider ルールの揺れ（一致条件が provider+model なのに fallback は別 provider） | P2 | **「別 provider 必須」に統一**（§5.1）。override は `--allow-same-provider` / `--allow-same-model` の段階。fallback も別 provider |
| 付録に seed 対応済みのような表現 | P3 | 付録を「seed 対応を足せば（現行未対応・§11 第3段）」に修正 |

## 付録: Codex レビュー第3巡 反映ログ（2026-06-20）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| raw schema に `id` があるのに「ID はパイプライン採番」と衝突 | P2 | §5.2 を **raw（モデル出力・id なし）/ normalized（保存後・id 付与済み）** に分離。継続 raw は `trackedWeaknesses[]`（既知 id 参照のみ）＋ `newWeaknesses[]`（id なし）。`EditorialReview` / `EditorialReviewContinuation` の2スキーマ |
| override フラグの包含関係が未定義 | P3 | §5.1/§8 に **`--allow-same-model` は same-provider を含む上位互換**（両方渡す必要なし）と明記 |

## 付録: Codex レビュー第4巡 反映ログ（2026-06-20）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| `editorial-review.json` を「生スコアカード」と読める表現（normalized 定義と不整合） | P3 | §5.4 を **「normalized スコアカード＝id/status 付与済み」** に修正 |
| 導入段階の schema 名が単数（`EditorialReviewSchema` のみ） | P3 | §11 第1段を **`EditorialReview`（独立）**、第2段で **`EditorialReviewContinuation` 追加** と段階別に明記 |

## 付録: Codex レビュー第5巡 反映ログ（2026-06-20）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| 継続後の `editorial-instruction.md` に `resolved` が混ざり得る | P2 | §5.4/§7 を **`severity ∈ {major,minor}` かつ `status ∈ {open,partial}`**（preference・resolved 除外）に明記 |
| E4 の「同じ正規化経路」が専用 formatter 設計と不整合 | P3 | E4 を「整形は専用 formatter、**`instruction.md → article:revise` の適用経路が同じ**」に修正 |

## 付録: Codex レビュー第6巡 反映ログ（2026-06-20）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| `editorial-instruction.md` が「②候補」か「③編集長確定」か混在（自動適用事故の懸念） | P2 | **2ファイルに分離**: ②機械 = `editorial-instruction.candidates.md`（候補・未適用）、③編集長確定 = `editorial-instruction.md`（④ revise が読む唯一のファイル）。§5.4/§5.6/§6/§7/§8 を統一 |

## 付録: Codex レビュー第7巡 反映ログ（2026-06-20）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| allowlist パターンがコマンドに一致しない懸念（`:*` vs スペース） | P2 | 既存 templates は全エントリ `article:<sub>:*` 形で、`:*` は Claude Code の prefix glob（スペース引数に一致）。**同形 `article:review-editorial:*` を維持**し、§12.2 に根拠を明記（repo の `npm run *` は開発用・別系統） |
| §12.3 厳格運用の具体例不足 | P3 | §12.3 に **「allowlist に入れない（推奨・確実）」** と **deny 例（override 弾き・中間フラグ一致の注意つき）** を追加 |

## 付録: Codex レビュー第8巡 反映ログ（2026-06-20）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| §12.2/§12.3 で allowlist 方針が二重に読める | P3 | §12.3 を **「標準運用＝allowlist 追加／厳格運用＝allowlist しない」の選択制**に再構成。§12.2 #3 を「選択制・既定は標準」に修正 |

## 付録: Codex レビュー第9巡 反映ログ（2026-06-20）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| `models.yaml` の静的設定だけでは独立性を常に表現できない（`finalAuthorModel` は実行時に変わる＝rewrite が fallback で Anthropic になると `editorial_review=anthropic` が違反） | P1 | §5.1 に **実行時の provider 選択**を追加: `editorial_review` 呼び出し前に `finalAuthorModel.provider` と同 provider candidate を除外して選び、別 provider が無いときだけ失敗（事後 fail だけにしない）。実応答後の再チェックは安全網。§11/§13 も統一 |
| §13 が models.yaml 追加中心で router の enum 変更に触れていない | P2 | §13/§11 に **`ModelTask` union ＋ `modelTaskSchema` enum への `editorial_review` 追加が必須**（models.yaml だけでは config validation/TS で止まる）を明記 |

## 付録: Codex レビュー第10巡 反映ログ（2026-06-20）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| 実行時 provider 除外の実装境界が曖昧（`ModelRouter.run()` は候補を内部で組む。§13「request 形 変更なし」とも衝突し得る） | P2 | §5.1/§11/§13 に **実装手段**を明記: (a) `ModelRequest.excludeProviders`/`candidatePolicy` を `ModelRouter` で適用 or (b) 専用 wrapper。§13 を「provider 実装(HTTP)は不変／**router の候補選択に小拡張**」へ分離 |
| override 時の candidate filter 挙動が未明文 | P3 | §5.1 に **挙動表**: 既定=同 provider 除外／`--allow-same-provider`=provider 除外解除（完全同一 model は依然拒否）／`--allow-same-model`=完全同一も許可。**事後 recheck も同 override レベルで判定** |

## 付録: Codex レビュー第11巡 反映ログ（2026-06-20）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| §13 の models.yaml 推奨が静的 writer 基準（reviewer を Anthropic 単独にすると、writer が fallback で Anthropic 化したとき runtime filter で全候補落ち） | P2 | §13 を「**candidate set は両 provider をまたぐ**（実行時に finalAuthorModel.provider を除外しても別 provider が残る）。例 primary=Anthropic/fallback=OpenAI。**writer 常用 provider を reviewer の fallback に含めるのは runtime filter があるので違反ではない**」に修正 |
| §4 に候補/確定分離前の表現が残存（`editorial-instruction.md` に正規化して revise） | P3 | §4 を「機械フィルタ→`editorial-instruction.candidates.md` → 編集長が `editorial-instruction.md` に確定 → revise」に修正（§5.4/§5.6 と整合） |

## 付録: Codex レビュー第12巡 反映ログ（2026-06-20）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| 新規 weakness の `status` 初期値が未明文 | P3 | §5.2 に「**独立 raw の全 `weaknesses` ／継続 raw の `newWeaknesses` は normalized 時に `status:"open"` で起票**」を追加（§5.4 の open\|partial フィルタに直結） |
| §5.1 冒頭が静的 config 寄りの言い方（「別 provider/model を割り当てる」） | P3 | §5.1 冒頭を「**candidate set を両 provider にまたがせ（primary は finalAuthor と別 provider 優先）、実行時に finalAuthor の provider を除外して選ぶ**」に修正（§13 と整合） |
