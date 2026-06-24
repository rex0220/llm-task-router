# 複数記事のシリーズ作成 仕様案

> ステータス: ドラフト（v7 / Claude 起案・Codex レビュー7巡反映） / 対象: llm-task-router + Claude Code 記事パイプライン
> 最終更新: 2026-06-23

## 1. 目的

現状は **1 run = 1 記事**（`runs/<runId>/`）で完結する。これを拡張し、**1 つの構想（シリーズ）に紐づく複数記事**を、文体・用語・世界観を共有しながら作成・進行・集計できる運用を定義する。

想定する 3 用途:

| 用途 | 特徴 | 必要なもの |
|---|---|---|
| 科学シリーズ | 独立トピックを**同じ文体**で量産 | 文体共有のみ（連続性・計画は不要） |
| 小説 | いくつかの章を**順番に**作成 | 文体共有 ＋ **前章→次章の状態引き継ぎ（連続性）** |
| テーマ分割 | 1 テーマを複数記事に**割り付け** | 文体共有 ＋ **全体構想・章順・非重複（計画）** |

3 用途に共通するのは「文体（voice）の共有」と「メンバー記事の束（横の関係）」。用途固有なのは「連続性」と「計画」。本仕様はこの 4 要素を分離して扱う。

### 背景（既存資産）

シリーズ化の基礎部品は揃っている。新規発明ではなく、既存プリミティブ（meta 軸の分離・profile 注入・progress イベント・first-write-wins 固定）の組み合わせ。

- `RunMeta` はすでに **`published`（公開先）と `lineage`（版系譜）を別軸として分離**している（[RunStore.ts:60-101](../src/storage/RunStore.ts#L60-L101)、コメントに「公開情報とは別軸」と明記）。シリーズ（横の束）を第 3 軸 `series` として足すのは、この既存方針の素直な延長。
- 文体は `style`（profile の作法ブロック）として **draft / final（rewrite）の本文生成プロンプトに注入**される既存経路がある（[qiitaSteps.ts:9-11](../src/workflows/qiitaSteps.ts#L9-L11) の `styleBlock`、draft/final の `buildInput`）。`criteria` は評価系（review）で生成には入らないため、voice はこの `style` 注入点に重ねる。
- 「作成時に値を run 単位で固定し、後続・別セッションで遡及・上書きしない（first-write-wins）」は `--editor-model` ・ `--code-check` で実績がある運用パターン（CLAUDE.md）。これをシリーズ単位の voice 固定に流用する。

## 2. スコープ

### やること
- 1 シリーズに属する複数記事を、共有文体（voice）を注入しながら作成する。
- メンバー記事の束（順序・役割・状態）を、`lineage`（版系譜）と混ぜずに表現する。
- 小説向けに前章の状態を次章へ引き継ぐ。テーマ分割向けに未作成の記事枠と割り付けを保持する。

### やらないこと
- 既存の `lineage`（縦＝版の更新）への相乗り（§3 F1）。横のシリーズ関係は別軸にする。
- シリーズ全体を 1 回の LLM 呼び出しで一括生成すること（メンバーはあくまで 1 run ずつ。既存の品質ゲート・progress を各記事で通す）。
- `final.md` の直接編集・自走公開（CLAUDE.md の原則どおり。シリーズでも各記事はユーザー承認後に export）。

## 3. 現行実装との整合（確認済み事実）

設計の前提となる現行挙動。

| # | 事実 | 根拠 | 設計への含意 |
|---|---|---|---|
| F1 | `RunMeta.lineage` は **縦の版管理**専用（`supersedesRunId` / `rootRunId` / `sourceExportPath`）。`published` とも明示的に「別軸」として分離されている。 | [RunStore.ts:60-101](../src/storage/RunStore.ts#L60-L101) | 横のシリーズ関係を `lineage` に混ぜると責務が濁る。**第 3 軸 `meta.series` を新設**する（§5.1）。 |
| F2 | runId はファイル名から導出（`<date>-<slug>`）。`RunStore` は runId 単位でディレクトリを所有し、パスエスケープを検証する。 | [RunStore.ts:178-202](../src/storage/RunStore.ts#L178-L202) | シリーズ container は `runs/` の外（`series/<slug>/`）に置き、run ディレクトリとは独立させる（§5.2）。 |
| F3 | 現行の品質ゲート（refine / direction / factcheck / build-verify / editorial / claims-normalize / verify-artifacts / export）は **9 段の canonical 工程**として run 単位で完結する。 | [stepOrder.ts](../src/progress/stepOrder.ts) | シリーズはこの 9 段を**置き換えない**。各メンバーは従来どおり 9 段を通す。シリーズは「作成前の文体注入」と「作成後の状態書き戻し」を足すだけ。 |
| F4 | 本文生成（draft / final）に注入されるのは `style`（profile の作法ブロック）のみ。`criteria` は評価系で生成には入らない。記事全文を文体サンプルにする経路は無い。 | [qiitaSteps.ts:9-11](../src/workflows/qiitaSteps.ts#L9-L11)（`styleBlock`）、draft/final の `buildInput` | voice 共有は **蒸留した voice ファイルを `style` 注入点に重ねる**（記事全文ではない＝内容の混入を防ぐ、§5.3 / 課題 C2）。 |

> 本仕様の最重要原則: **`series`（横の束）は `lineage`（縦の版）と別軸**。そして**共有するのは「蒸留された文体」であって「記事本文」ではない**。

## 4. 中核フロー

```
シリーズ構想
  → series:init            … series/<slug>/ を作る（series.json / voice.md の枠）
  → voice 確定             … 模範記事 or 指示から voice.md を蒸留し series 単位で固定（first-write-wins）
  → （テーマ分割/小説）series:plan … outline → メンバー枠を series.json に割り付け
  ┌─ メンバーごとに ───────────────────────────────────┐
  │  → article:create       … profile.style + voice.md を合成して meta.style に焼き込む（+ 連続性は prev の状態を注入）
  │  → 既存 9 段ゲート       … refine 〜 verify-artifacts（run 単位で不変）
  │  → （小説）chapter-state 書き戻し … done の出口で次章へ渡す状態を要約・保存
  │  → 承認後 export        … 各記事は従来どおりユーザー承認後に書き出し
  └────────────────────────────────────────────────┘
  → series:status          … メンバー横断の進捗・コスト・残枠を集計
```

各メンバーは「**1 run ＝従来の 9 段**」を完全に踏襲する。シリーズが足すのは前後の薄い層（voice 注入・状態引き継ぎ・集計）だけ。

## 5. データモデルの拡張（要追加）

### 5.1 `meta.series`（横の束の正本・第 3 軸）

`published` / `lineage` と並列の第 3 軸として `RunMeta` に追加する。**`lineage` には足さない**（F1）。

```ts
// RunMeta（既存の published?/lineage? に並べる）
series?: {
  seriesId: string;                 // シリーズ識別子（series/<slug> に対応）
  role?: "article" | "chapter" | "seed"; // 既定 "article"。小説は "chapter"
  order?: number;                   // 束内の順序（1 始まり）
  prevRunId?: string;               // 連続性の参照元（小説の前章 run）
  voiceVersion: number;             // この run が注入した voice.md の版（series.json.voice.version）
  voiceHash: string;                // 同 voice.md の内容ハッシュ（監査用）
};
```

> **voice の provenance（どこから抽出したか・複数 exemplar・外部ファイル等）は `series.json` 側に集約**し（§5.2）、run 側には「**どの版・どの内容の voice で生成されたか**」だけを `voiceVersion` / `voiceHash` で焼き込む（Codex P2）。これで voice を後から明示更新しても、各記事がどの文体条件で書かれたかを監査できる。記事全文を入れる `--style-from <runId>` 案は内容混入のため不採用（課題 C2）。

> **order は 1 始まりの整数（不変条件・実装済み）**。`series.json.members[].order` は読み込み時に `Number.isInteger && >= 1` を検証し、0-based / 非整数を弾く（`validateMembers`）。`article:create` の `--order` も `>= 1` のみ受け付け、省略時は末尾に自動採番して `meta.series.order` に確定値を焼き込む（create 完了後 `recordMember` が最新 `series.json` を読んで採番）。
> **移行注意（運用）**: この検証は `SeriesStore.read` を通る**全シリーズ操作（`series:status` / `create --series` / `export` / `recordMember`）で読み取り時にハードフェイル**する。そのため **0-based の旧 `series.json` は `series:status` でも中身を開けず読み取りエラーになる**（早期検出が目的）。旧データに当たったら、まず `series.json` の `order` と各 run の `meta.series.order` を手で 1 始まりへ直してから（`series.json` の全 member を `order+1`、各 run meta も対応 order に揃える）CLI を使う。

### 5.2 `series/<slug>/`（シリーズ container・`runs/` の外）

run ディレクトリと独立させる（F2）。最小フェーズでも薄く立てる（voice と未作成枠の置き場が要るため）。

```text
series/<slug>/
├─ series.json     # マニフェスト: シリーズ profile / voice 固定印 / メンバー枠と順序
├─ voice.md        # 蒸留された共有文体（§5.3）。create 時に注入し meta.style へ焼き込む（revise は焼き込み済み meta.style で再現）
└─ outline.md      # 全体構想（テーマ分割・小説のみ。科学シリーズは任意）
```

`series.json`（案・スキーマは課題 C1 で要確定）:

```jsonc
{
  "version": 1,
  "seriesId": "kagaku-2026",
  "profile": "qiita",
  "voice": {
    "frozen": true,                  // first-write-wins（未凍結なら create を拒否、§5.3）
    "version": 2,                    // 現行版。run 側 meta.series.voiceVersion と対応。再 freeze で +1
    "frozenAt": "2026-06-23T...",
    "hash": "...",                   // 現行 voice.md の内容ハッシュ
    // 全版の履歴。旧 version で焼き込まれた run の voiceHash 検証に使う（§6.1）
    "history": [
      { "version": 1, "hash": "...", "file": "voice-v1.md" },
      { "version": 2, "hash": "...", "file": "voice.md" }   // 現行版は voice.md
    ],
    // provenance はここに集約（手書き / 複数 exemplar / 外部ファイルを許容）
    "provenance": [
      { "kind": "exemplar-run", "runId": "2026-06-20-..." },
      { "kind": "handwritten" }
    ]
  },
  "members": [
    { "order": 1, "slug": "...", "runId": "2026-06-23-...", "status": "done" },
    { "order": 2, "slug": "...", "runId": "2026-06-24-...", "status": "writing" },   // 作成中
    { "order": 3, "slug": "...", "runId": "2026-06-24-...", "status": "updating" },  // done 後に更新中
    { "order": 4, "slug": "...", "runId": null, "status": "planned" }               // 未作成枠
  ]
}
```

> **メンバーの状態（4値・実装済み）**: `planned`（未作成枠・runId=null）→ `writing`（作成中・`article:create --series` で記帳）→ `done`（完成・`article:export` 工程 done が信号）→ `updating`（done 後に `article:revise` か `article:import --series` で変更着手）。README は日本語ラベル（`⬜ 予定 / 🚧 作成中 / ✏️ 更新中 / ✅ 完成`）、コンソールは生キー（技術ビュー）。
> - **`done` の信号は「export 工程 done」に統一**（progress.events.jsonl が正本）。`meta.published`（公開台帳＝`record-publication`）は別工程なので使わない。両方を信号にすると「export 済み・公開台帳記録前」のメンバーが `series:status --fix` で `done`→`writing` に巻き戻る（silent downgrade）。トリガ（export）と `--fix` 導出を同一信号にして防ぐ。
> - **`series:status --fix` は downgrade しない**: export 工程 done なら `done`、run はあるが未 export なら `writing` を導出し、既存 `done`/`updating` は保持（`updating` は progress に痕跡が残らず復元不能なので上書きしない）。
> - **README は `article:create --series` で必ず生成**（作成開始で束の一覧を出す）。export 等の自動再生成は従来どおり「一度でも README がある束だけ」。
> - **公開済みメンバーの更新（`/update-article`）は `article:import --series <slug>`**: supersedes 先メンバーの runId を新 run に付け替え `updating` にし、新 run に `meta.series` を焼く（横の束は常に現行版 run を指す。旧 run は `meta.lineage` に残る）。仕様詳細は [series-readme-writing-status-proposal.md](series-readme-writing-status-proposal.md)。

> voice の出所は run だけでなく「手書き指示」「複数 exemplar」「外部ファイル」もあり得るため、単一 `sourceRunId` ではなく `provenance` 配列で持つ（Codex P2）。run 側は出所を持たず `voiceVersion`/`voiceHash`（§5.1）だけを焼き込む。

**profile の整合**: `series.json.profile` はシリーズの文体一貫性の前提なので、`article:create --series` は **series profile を既定**にする。明示 `--profile` が `series.json.profile` と異なる場合は **create を拒否**し、意図的な逸脱は `--allow-profile-mismatch` を必須にする（silent に別 profile で書かない）。

### 5.3 `voice.md`（共有文体の正本・蒸留物）

模範記事または文体指示から**蒸留した voice**（トーン・人称・語彙・禁止表現・構成の癖など）を保存する。**記事本文そのものは入れない**（F4 / 課題 C2）。

- **凍結（freeze）は専用コマンドで行う**。手書き voice.md を `series:freeze-voice <slug> --voice-file <path>` で取り込み、`hash`/`version`/`frozenAt` を確定し `frozen: true` にする（ユーザーが `series.json` を手編集しない）。**first-write-wins でシリーズ単位に固定**し（`--editor-model` と同じ流儀）、後続メンバーや別セッションで遡及・上書きしない。意図的に変えるときは再 `freeze-voice` で `version` を +1。
- **手書きの場所と初回 freeze**: ユーザーは `series:init` が作る `series/<slug>/voice.md` を直接編集してよい。**初回 freeze（version 1）は退避すべき旧版が無いため `--voice-file` の省略＝その場の `voice.md` を凍結する**ことを許す（同一パス許可）。`--voice-file <別パス>` を渡せば外部ファイルから取り込む。
- **再 freeze（version ≧ 2）は `--voice-file` 必須、かつ `series/<slug>/voice.md` 以外**: 既に凍結済み（`frozen === true`）の series に対する freeze は再 freeze とみなし、**`--voice-file` の省略を禁止**する（省略＝現 voice.md の再凍結、という誤読を塞ぐ。同内容の再凍結は no-op として明示拒否）。渡すパスが `series/<slug>/voice.md` 自身の場合も拒否（`voice.draft.md` 等の別ファイルに書いてから渡す）。
- **再 freeze の退避順序を固定する**: 旧版を失わないため **① 現 `voice.md` を `voice-v<currentVersion>.md` に退避 → ② 新 voice を `voice.md` に保存 → ③ `hash`/`version`(+1)/`frozenAt`/`history[]` を更新** の順で行う。先に上書きしてから退避する実装は禁止（先に退避してから書く）。
- **`voiceHash` の算出は固定する**: `series/<slug>/` は run ディレクトリではないため `RunStore.save` は使えない（runs 専用）。**`SeriesStore`（または共通 helper）が `RunStore.save` と同じ末尾改行正規化を行い**（[RunStore.ts:144-147](../src/storage/RunStore.ts#L144-L147) と同等）、その**保存後の UTF-8 バイト列に対する `sha256`**（hex）を `voiceHash` と定義する。読込前の生文字列や末尾改行有無でブレないよう、計算対象は「保存後のファイル内容」に一本化する（テスト可能性）。
- **voice の注入と revise での再現（焼き込み）**: 現行 `article:revise` は **その run の `meta.style` だけ**を読む（[createQiitaArticle.ts:108](../src/workflows/createQiitaArticle.ts#L108)）。そこで `article:create --series` は、作成時に **`meta.style = profile の style ＋ voice.md` を合成して run の meta に保存**する（`style` 注入点 [qiitaSteps.ts:9-11](../src/workflows/qiitaSteps.ts#L9-L11) に乗る）。
  - これにより **revise は既存経路（`meta.style`）でそのまま当時の voice を再現**でき、voice version が後で上がっても**旧 run は自分の `meta.style` で不変**（version drift で旧記事の改稿が壊れない）。
  - `meta.series.voiceVersion` / `voiceHash`（§5.1）は「どの版・どの内容で焼き込んだか」の監査ポインタとして併記する（再現の実体は焼き込んだ `meta.style`、監査は voiceVersion/Hash、という役割分担）。
- **第 1 段では voice.md を手書き必須とする**（抽出工程は未設計＝課題 C2）。`series.json.voice.frozen !== true`、または voice.md が空/欠落のまま `article:create --series` を実行したら **create を拒否**する（silent に文体無しで書き始めない）。voice の自動抽出（`series:extract-voice`）は第 4 段の拡張候補（課題 C2）。

### 5.4 `chapter-state.json` / `chapter-summary.md`（連続性の正本・小説のみ）

`role: "chapter"` のメンバーで、**前章 `final.md` 全文ではなく**、構造化した状態を次章へ引き継ぐ（コスト削減＋伏線・人物状態の扱いやすさ）。

```jsonc
// runs/<chapterRunId>/chapter-state.json（その章の done 出口で生成）
{
  "order": 2,
  "summary": "...",                       // 章のあらすじ（chapter-summary.md と対）
  "characters": [{ "name": "...", "state": "..." }],
  "openThreads": ["未回収の伏線..."],      // 次章が拾うべき糸
  "established": ["既出設定..."]           // 矛盾防止のため次章に再提示
}
```

次章の `article:create` 時に `prevRunId` の `chapter-state.json` を注入する。

## 6. 新コマンド / スキル

| コマンド | 責務 | 進捗記録 |
|---|---|---|
| `series:init <slug> --profile <p>` | `series/<slug>/`（series.json / voice.md 枠）を作る | 非 canonical |
| `series:freeze-voice <slug> [--voice-file <path>]` | 手書き voice を取り込み、`hash`/`version`/`frozenAt`/`history[]` を確定し `frozen: true` に。初回は同一パス可、再 freeze は `version`+1（旧版を voice-v<N>.md に保全・§5.3） | 非 canonical |
| `series:plan <slug>` | outline からメンバー枠を `series.json` に割り付け（テーマ分割・小説） | 非 canonical |
| `article:create ... --series <slug> [--order N] [--prev <runId>]` | voice を `meta.style` に焼き込み（§5.3）・連続状態を注入。meta.series（voiceVersion/Hash 込み）を記録 | **既存 canonical（create）** |
| `series:status <slug> [--fix] [--write]` | メンバー横断の進捗・残枠を集計。既定は dry-run 表示、`--fix` で `series.json` を修復＋`meta.series.order` 欠落の遡及補修（§6.1）、`--write` で `series/<slug>/README.md`（人が読む一覧・派生ビュー）を生成 | 非 canonical（`--fix`/`--write` 時のみ書込） |
| `article:export ... [--out-dir <dir>]` | シリーズメンバーを `<seriesId>-<NN>-<slug>[-<platform>].md`（NN=保存順 order 2桁）で自動命名 export。`--out` 明示が優先、両無しはエラー | 既存 canonical（export・§追加課題D） |

- `series:*` は **canonical 9 段に含めない**（シリーズ管理であって記事生成工程ではない。`record-publication` を canonical に含めないのと同じ判断）。各メンバーの進捗は従来どおり run 単位の `progress.events.jsonl` に残る。
- スキル `/series`（仮）が編集長を介して `series:init → voice 確定 → plan → メンバーごとに /write-article → series:status` を駆動する。各メンバーの作成自体は既存 `/write-article` を流用する。

### 6.1 `meta.series` と `series.json` の整合性（二重書き込みの順序）

`article:create --series` は **run（`meta.series`）と シリーズ container（`series.json.members`）の 2 か所を更新する**。途中失敗で束と run がズレないよう、次を固定する（Codex P2）。

- **run meta を正（source of truth）とする**。書き込み順は **① run を作成し `meta.series` を確定 → ② `series.json.members` の該当枠を `runId`/`status` で更新**。①成功・②失敗なら run は健全に残り、束だけが古い状態になる（孤児ではなく未反映）。
- **`series:status --fix` / 再 `series:plan` は run 側を正として `series.json` を修復**する（`series:status` の既定は dry-run 表示で書き込まない。修復は `--fix` 明示時のみ）。`runs/` を走査して `meta.series.seriesId` が一致する run を members に突き合わせ、`series.json` に欠けている/食い違う枠を埋め直す（`meta.series` は上書きしない）。
- これにより「create 成功後に series.json 更新失敗」は次回の status/plan で自己修復し、「series.json 更新成功後に run 不在」は起き得ない（run を先に作るため）。
- **`--fix` は曖昧な衝突を自動解決しない（拒否してレポートのみ）**。次のような多義的状態は run 側からも一意に決まらないため、`--fix` は該当箇所を**修復せず警告として列挙**し、編集長/ユーザーが手で解す（衝突の判定基準・正規化は課題 C1 に含めて確定）:
  - 同一 `seriesId` で `order` が重複する run が複数ある。
  - 同じ `runId` が複数 member 枠に載っている。
  - planned 枠の `slug` と、run の topic 由来 slug が食い違う（どちらを正にするか機械的に決められない）。
  - `meta.series.voiceHash` が、**その run の `voiceVersion` に対応する voice ファイルの実 hash** と一致しない（焼き込み時と voice が変わった疑い）。**現行 `voice.hash` ではなく run の version に対応するファイルと突き合わせる**（再 freeze 後の旧 run を誤検出しないため）。
    - 照合の正本は **`history[]` を索引として該当 version の `file`（現行版＝`voice.md`、旧版＝`voice-v<N>.md`）を引き、その実ファイルを §5.3 の手順で再計算した hash** とする。`history[]` に記録された hash は索引・表示用で、検証の最終判定は**実ファイルの再計算 hash**に置く（`series.json` が手で書き換えられても実体で検証する）。`history[]` の hash と実ファイル hash が食い違う場合・対応 version の voice ファイルが欠落する場合は、修復せず警告列挙する（§6.1 末尾の方針どおり）。優先順位の最終確定は C1。

### 6.2 並行作成時の競合と対策（`series.json` 記帳の直列化）

`recordMember`（[src/cli/series.ts](../src/cli/series.ts)）は **`series.json` を read → upsert → write する read-modify-write** で、`SeriesStore.read`/`write` は素の `readFile`/`writeFile`（ロック・原子的 rename・version 比較（CAS）のいずれも無い・[src/storage/SeriesStore.ts:59-84](../src/storage/SeriesStore.ts#L59-L84)）。
そのため**同一シリーズの記事を並行作成すると `series.json` で競合**する。`--order` 自動採番は create **後**に確定する（§本バグ修正後も `recordMember` 内で最新 `series.json` を読んで採番）ため、ほぼ同時に走る2本は同じ古い状態を見て競合し得る。

想定される不整合：

| # | 競合 | 機序 | `--fix` で自己修復できるか |
|---|---|---|---|
| R1 | **同じ order を二重採番** | 2本がほぼ同時に `series.json` を読むと、双方が「最大 order は N だから次は N+1」と判断し、両方の `meta.series.order` が N+1 で焼き込まれる。 | **不可**。run meta（正本）両方が同じ order を主張するため `series:status` の衝突1（order 重複）になり、`--fix` は拒否（§6.1 末尾）。手で order を振り直す。 |
| R2 | **member 追記の lost update** | 両方が同じ古い `series.json` を元に upsert し、後勝ちの write が先の member を消す。 | **可**。run meta は健全に残るので、`series:status --fix` が `runs/` を走査して消えた member を埋め直す（§6.1。run を正とする設計の恩恵）。 |
| R3 | **明示 `--order` の取り合い** | 並行作成で同じ `--order N` を指定すると同一 slot を奪い合い、`upsertMember` の後勝ちで片方の枠が置き換わる（R1 と違い order は意図値なので採番ズレではなく slot 上書き）。 | **不可**（R1 と同様、両 run meta が order N を主張）。異なる `--order` を割り当てて回避する。 |

要点は**非対称性**：run meta を正本とする設計（§6.1）のおかげで「`series.json` 側の lost update（R2）」は `--fix` で回復できるが、「両 run meta に同じ order が焼き込まれた状態（R1/R3）」は正本同士の衝突なので機械的には解けず、手作業になる。

#### 対策: `series.json` 記帳の直列化（採用＝案B）

競合の実体は **`recordMember` の `series.json` read-modify-write** だけにある。
`recordMember` は create **完了後**に呼ばれる（[src/index.ts:218](../src/index.ts#L218)＝`createQiitaArticle` が
`result.runId` を返した後）ため、**高コストな LLM 生成は競合に関与せず、臨界区間はミリ秒**。
そこで「create 全体を禁止する粗いロック」ではなく、**この記帳区間だけを排他する細かいロック**を入れる
（コスト対効果でこちらを採る。粗いロックは数分間ロック保持・クラッシュ時の stale lock 処理・安全な並列の阻害を伴う）。

- **排他の単位**: シリーズ単位（`series/<slug>/`）。`recordMember` の「read → upsert → write」を
  クリティカルセクションにし、同一シリーズの 2 本目はここで待つ（短時間）。
- **実装手段**: クロスプラットフォーム（Windows 含む）で原子的な **`mkdir` ロック**を第一候補とする
  （ロックディレクトリの作成成否を排他に使う。`mkdir` は存在時に失敗＝atomic test-and-set）。
  取得は短いポーリング＋タイムアウト、解放は `finally` で確実に削除。
  代替として **temp 書き＋原子的 rename＋再読込（CAS）** でもよい（ロックファイル不要だが retry ループが要る）。
- **ロックの置き場所**: **`series/.locks/<slug>.lock/`**（シリーズ本体 `series/<slug>/` 配下ではない）。
  シリーズ未作成時にロック取得が `ENOENT` になって通常の「Series not found」経路を塞がないため、
  かつロック取得がシリーズ本体ディレクトリを副作用で作らないため、親が安定して存在する `.locks/` 下に置く。
- **stale lock 対策（TOCTOU 回避）**: ロック保持はミリ秒想定なので長時間 stale はほぼ起きない。
  **自動奪取は既定で行わず、タイムアウトしたらエラーで止めて手動復旧に寄せる**。
  「古い lock を見て削除」する単純な自動奪取は TOCTOU で危険（確認〜削除の間に別プロセスが再取得すると
  正当な lock を壊す）。自動奪取を入れるなら `ownerToken`＋`acquiredAt` をロック内に書き、削除直前に
  token を再検証する（トークンファイルを置くと `rmdir` では消せないため recursive 削除を使う）。
  LLM 生成中はロックを持たないため、create のクラッシュで stale lock が残ることはない（この設計の利点）。
- **効果**: R1（二重採番）・R2（lost update）は記帳が直列化されるため**根絶**される
  （後続の `recordMember` は前の write 済み `series.json` を読んで採番するため、order が重複しない）。
- **残るもの**: **R3（明示 `--order` の取り合い）はロックでは解けない**。これは並行ではなく
  「2 本が同じ order を意図的に主張する」ユーザー誤り（逐次実行でも発生）で、引き続き
  `series:status` の衝突1で検出する（§6.1 末尾）。

#### 運用方針

- 記帳直列化（案B）導入後も、**運用としては 1 本ずつ逐次作成を推奨**（最も単純）。並行は CLI 上は安全になるが、
  進行管理（編集長の工程把握）の観点で逐次が分かりやすい。
- 並行する場合は **各記事に異なる `--order` を明示**して R3 を避け、完了後に `series:status` で確認する。
- 粗いロック（create 全体の排他＝案A）は採用しない。必要が生じたら opt-in フラグとして将来拡張に回す。

## 7. 3 用途へのマッピング

| 用途 | role | voice.md | 連続性 | plan/outline |
|---|---|---|---|---|
| 科学シリーズ | `article` | 共有（固定） | 不要 | 任意（枠だけ） |
| 小説 | `chapter` | 共有（固定） | **必須**（chapter-state） | 必須（章順） |
| テーマ分割 | `article` | 共有（固定） | 任意（軽い相互参照） | **必須**（非重複割り付け） |

最小実装（科学シリーズ）は `meta.series` ＋ voice.md ＋ create への `--series` だけで成立する。小説・テーマ分割は §5.4 / §6 の plan を足して順次対応する。

## 8. 既存ゲート・成果物への接続

- **progress / status**: 各メンバーは既存 9 段をそのまま通す。`series:status` はメンバーの `progress.json` を横断集計するだけで、新しい工程順は導入しない。
- **factcheck / verify-artifacts**: シリーズでも記事単位で必須。voice 共有は文体であって事実ではないので、factcheck の対象・粒度は不変。
- **references（参考章）**: 記事単位で `sources.json` から機械生成する既存挙動のまま。シリーズ横断の相互リンク（記事 A → 記事 B）は voice/sources とは別問題で、初期スコープ外（課題 C5）。
- **editorial-review**: 記事単位で従来どおり。voice の一貫性チェックはレビュー観点に足せるが、必須化はしない（課題 C4）。

## 9. 課題・未解決論点

| # | 課題 | 重大度 | 現時点の方針 |
|---|---|---|---|
| C1 | `series.json` のスキーマ確定（version 封筒・members の状態遷移・slug/runId のキー安全性）。`export/index.json` と同様にプロトタイプ汚染対策と安全文字種ガードが要る。加えて **`series:status --fix` の衝突判定基準（§6.1 の多義的状態）と正規化**、**再 freeze の `--voice-file` 省略禁止条件**（§5.3）、**`history[]` と実ファイル hash の優先順位**（§6.1。暫定は「実ファイル再計算を正本・history は索引」）もここで確定する。 | P1 | §5.2 / §6.1 は案。実装前に `export/index.json`（[ExportIndex.ts](../src/storage/ExportIndex.ts)）に倣って確定する。`SeriesStore` の save/hash helper も併せて切る（§5.3）。 |
| C2 | voice の自動「蒸留」をどう作るか。記事全文を入れると内容が次記事に漏れる。誰が（どのモデルが）何を抽出するかが未定。 | P1→P3 | **第 1 段は手書き voice.md 必須で回避**（§5.3。未凍結/空なら create 拒否）。自動抽出 `series:extract-voice` は第 4 段の拡張候補に降格。 |
| C3 | voice の first-write-wins と「途中で文体を変えたい」の両立。固定が強すぎると科学シリーズの方針転換ができず、緩いと一貫性が崩れる。 | P2 | 既定は固定。明示コマンドで version を上げ履歴を残す案。`--editor-model` の運用を参考にする。 |
| C4 | voice 逸脱の検出。後続記事が文体から外れても機械的には気づけない（editorial は任意・正確性ゲートではない）。 | P2 | 初期は人手（編集長レビュー）。将来 editorial-review に voice 観点を追加する拡張候補。 |
| C5 | テーマ分割の**非重複保証**と相互リンク。「記事 B で既出だから A では省く」を機械的に担保する手段が無い。references は記事内で閉じている。 | P2 | 初期は outline.md ＋編集長の人手割り付け。機械的 dedup は将来拡張。 |
| C6 | 小説の連続性で `chapter-state.json` を**誰が生成するか**。done 出口で要約する工程の担当（CLI か編集長か別エージェントか）が未定。要約品質が次章の矛盾に直結する。 | P2 | §5.4 はデータ形だけ確定。生成工程は要設計（factcheck と同様に CLI 無し工程として編集長が記録する案）。 |
| C7 | `series:status` のコスト集計は各 run の `progress.json` 依存。Claude Code（外側 AI）のトークンは router.log に出ないため、シリーズ合計も概算止まり（既存の単記事と同じ制約）。 | P3 | 既存制約の踏襲。概算と明記する。 |
| C8 | runId 採番の衝突（同日に同シリーズの複数メンバーを作ると `<date>-<slug>` が衝突しうる）。 | P3 | slug にメンバー識別子（章番号等）を含める運用ガイドで回避。CLI 側の発番補助は将来拡張。 |
| C9 | 同一シリーズの**並行作成で `series.json` が競合**（§6.2）。`recordMember` が read-modify-write でロック/CAS 無し。order 二重採番（R1）・member の lost update（R2）が race で起き得る。 | **解決済**（案B 実装） | `recordMember` の read-modify-write を `SeriesStore.withLock`（`series/.locks/<slug>.lock` の `mkdir` 原子ロック）でシリーズ単位に直列化。臨界区間はミリ秒（create 完了後の記帳のみ）で R1/R2 を根絶。LLM 生成中はロック非保持＝stale lock が残らない。`.locks` は slug 予約。粗いロック（案A）は不採用。**R3（明示 `--order` の取り合い）はロック対象外**でユーザー誤り扱い＝`series:status` 衝突1で検出。並行テスト＋ネガティブコントロールで担保。 |

## 10. 段階的導入

1. **第 1 段（最小・科学シリーズ）**:
   1. `RunMeta` に `series?`（§5.1。`voiceVersion`/`voiceHash` 含む）を型 ＋ 検証付きで追加（`published`/`lineage` と並列）。
   2. `series/<slug>/` と `series.json`（§5.2）/ `voice.md` の最小スキーマ確定（課題 C1）＋ `series:init`。**voice.md は手書き必須**。
   3. `series:freeze-voice`（手書き voice.md → `hash`/`version`/`frozenAt` 確定・`frozen: true`。`voiceHash` 算出は §5.3 で固定）。
   4. `article:create --series <slug>`: **`meta.style = profile.style ＋ voice.md` を合成して run meta に焼き込み**（revise が `meta.style` で再現＝§5.3）、`meta.series`（`voiceVersion`/`voiceHash` 込み）を記録。**`voice.frozen !== true` / voice.md 空・欠落なら create 拒否**、**`--profile` が series profile と異なれば拒否**（`--allow-profile-mismatch` で許容、§5.2）。run→`series.json` の順で書く（§6.1）。
   5. `series:status`（既定 dry-run 集計）＋ `--fix` で `series.json` 修復（§6.1）。

> **実装メモ（C1 後の最初の配線判断）**: 現状 [`RunStore.create`](../src/storage/RunStore.ts#L110-L131) は `(runId, topic, steps, platform, style, profile)` で `series` を受け取らず、[`createQiitaArticle` のオプション](../src/workflows/createQiitaArticle.ts#L39)も `{ runId, platform, style, profile }` 止まり。`article:create --series` は **(a) 合成済み `style`（`profile.style + voice.md`）を既存経路で渡す**だけでなく、**(b) `meta.series`（`voiceVersion`/`voiceHash` 込み）を確実に追記**する必要がある。
>
> **確定タイミングは「`store.create` 直後・`runQiitaArticle` 前」に固定する**。[createQiitaArticle.ts:43-51](../src/workflows/createQiitaArticle.ts#L43-L51) は `store.create` → `runQiitaArticle` の順で、その brief 処理が [728-733](../src/workflows/createQiitaArticle.ts#L728-L733) で `readMeta→writeMeta`（`articleTitle`/`tags` 書き込み）する。`meta.series` を **create 直後・runQiitaArticle 前**に一度書けば、brief の readMeta がそれを引き継ぎ競合しない。逆に **runQiitaArticle 開始後や CLI 側で create 完了後に書くと、中間の `writeMeta` と競合・遅延確定**になる。
>
> 選択肢は ①`createQiitaArticle` の option に `series` を足して内部の `store.create` 直後に `writeMeta` で確定／②CLI 側で `store.create` を直接呼ぶ経路に寄せて create 直後に確定。**①が素直**（create の成否と `meta.series` 確定を同じ workflow 境界に置けるため。`record-publication`/`importArticle` のように CLI/helper が `readMeta→writeMeta` する経路も既存だが、ここは create と確定を分離したくない）。確定後に `series.json.members` を更新する（§6.1 の「run→series.json の順・run meta が正」）。
2. **第 2 段（テーマ分割）**: `series:plan` ＋ outline.md ＋ 未作成枠（members の `planned`）。非重複は人手（課題 C5）。
3. **第 3 段（小説）**: `role: "chapter"` ＋ `chapter-state.json` 引き継ぎ（§5.4）＋ 状態書き戻し工程（課題 C6）。
4. **第 4 段（自動化候補）**: voice 逸脱検出（C4）、機械 dedup（C5）、相互リンク（C5）。

---

## 付録: Codex レビュー反映ログ（2026-06-23・第 1 巡）

| 指摘 | 対応 |
|---|---|
| `lineage` に `seriesId`/`seriesOrder`/`prevRunId` を足すと縦（版）と横（束）の責務が濁る。`meta.series` を別軸にすべき | §3 F1 / §5.1 で第 3 軸 `meta.series` を新設。`lineage` は版管理のまま温存 |
| `--style-from <runId>`（記事全文）は内容まで引っ張る危険。voice.md / series-style.md を蒸留して使う | §5.3 / 課題 C2。注入実体は voice.md（蒸留物）に分離 |
| 小説は `prevRunId` の final.md 全文でなく chapter-state.json / chapter-summary.md を引き継ぐ | §5.4 で構造化状態の引き継ぎを定義 |
| テーマ分割を本気でやるなら早めに薄い `series.json` を入れる（Bだけだと未作成記事・非重複が弱い） | §5.2 で最小フェーズから薄い series container を立てる方針に。純 meta-only 段階は設けない |

## 付録: Codex レビュー反映ログ（2026-06-23・第 2 巡）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| `profile + criteria` が生成に注入と誤記。生成（draft/final）に入るのは `style` のみ、`criteria` は評価系 | P1 | §背景 / §3 F4 を `style`（`styleBlock`）注入に訂正。根拠を [qiitaSteps.ts:9-11](../src/workflows/qiitaSteps.ts#L9-L11) に差し替え。§5.3 も `style` 注入点に重ねる旨へ |
| C2（voice 抽出）未設計のまま第 1 段で `--series` 注入を実装対象にしている＝実装者が止まる | P1 | §5.3 / §10 第 1 段で「手書き voice.md 必須・未凍結/空なら create 拒否」を確定。自動抽出は第 4 段へ降格（C2 を P3 に） |
| 注入した voice の版・ハッシュが run に残らず、どの文体条件で生成したか監査できない | P2 | §5.1 で `meta.series` に `voiceVersion` / `voiceHash` を追加。`series.json.voice.version`/`hash` と対応 |
| `series.json.voice.sourceRunId` と `meta.series.styleSourceRunId` が重複。出所は手書き/複数 exemplar/外部もあり単一 runId だと詰まる | P2 | §5.2 で provenance を `series.json.voice.provenance`（配列）に集約。run 側から `styleSourceRunId` を削り `voiceVersion`/`voiceHash` に寄せる |
| `article:create --series` の 2 か所更新（meta.series / series.json）の失敗時整合性が未記載 | P2 | §6.1 を新設。run meta を正とし「run → series.json」の順で書き、ズレは status/plan で run を正に修復 |

## 付録: Codex レビュー反映ログ（2026-06-23・第 3 巡）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| 手書き voice の `hash`/`version`/`frozen` を確定する正規コマンドが無く、ユーザーが `series.json` を手編集する流れになる | P1 | §6 / §10 に `series:freeze-voice <slug> --voice-file <path>` を新設（first-write-wins・再 freeze で version+1・旧版を voice-v<N>.md に保全） |
| `revise` は `meta.style` だけを読むため、作成時の voice をどこに焼き込むか未定。voice version 更新後に旧 run を revise すると旧 voice を再現できない | P1 | §5.3。`article:create --series` が `meta.style = profile.style ＋ voice.md` を合成して run meta に焼き込む。revise は既存経路（[createQiitaArticle.ts:108](../src/workflows/createQiitaArticle.ts#L108)）で当時の voice を再現。旧 run は自分の meta.style で不変 |
| `series:status` が表では「読取」だが §6.1/§10 で `series.json` を修復＝書込で矛盾 | P2 | §6 表・§6.1・§10 を「既定 dry-run、`--fix` 明示時のみ書込」に統一 |
| `voiceHash` の算出方法が未定（`store.save` の末尾改行正規化でブレる） | P2 | §5.3 で「`series/<slug>/` に保存後の UTF-8 に対する sha256(hex)」と固定 |
| `series.json.profile` と `--profile` の食い違いの扱いが未定 | P2 | §5.2 で「`--series` 時は series profile が既定、相違は create 拒否＝`--allow-profile-mismatch` 必須」 |

## 付録: Codex レビュー反映ログ（2026-06-23・第 4 巡）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| `voiceHash` の根拠に `RunStore.save` を置いたが、それは `runs/<runId>/` 専用で `series/<slug>/` には使えない | P1 | §5.3 を「`SeriesStore`（共通 helper）が `RunStore.save` と同じ末尾改行正規化を行い、保存後 bytes を sha256」に訂正。C1 に SeriesStore helper を追加 |
| 再 `freeze-voice` の旧版退避順序が曖昧（voice.md 自身を指定／先に上書き で旧版を失う） | P2 | §5.3 で「① 現 voice.md を voice-v<currentVersion>.md に退避 → ② 新 voice 保存 → ③ hash/version/frozenAt 更新」の順を固定 |
| `series:status --fix` の衝突時の扱いが未定（order 重複・同 runId 多重・slug 不一致 等） | P2 | §6.1 で「`--fix` は曖昧な衝突を修復せず警告列挙のみ」を明記。判定基準・正規化は C1 に畳み込み |
| `voice.md` 説明が「全メンバーの create/revise に注入」のままで v3 の焼き込み設計と矛盾 | P3 | §5.2 の説明を「create 時に注入し meta.style へ焼き込み、revise は焼き込み済み meta.style で再現」に訂正 |

## 付録: Codex レビュー反映ログ（2026-06-23・第 5 巡）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| `--voice-file` が voice.md 自身を禁止だと、最も自然な「voice.md を編集して freeze」が塞がる | P1 | §5.3 / §6 で「初回 freeze は同一パス許可（退避不要）。内容を変える再 freeze だけ別ファイル経由（voice.draft.md 等）を要求」に緩和 |
| voiceHash 不整合検証で現行 `voice.hash` と比較すると、再 freeze 後の旧 run（旧 version）を誤検出する | P2 | §5.2 で `series.json.voice.history[]`（`{version,hash,file}`）を追加。§6.1 を「run の `voiceVersion` に対応する履歴 hash と突き合わせ」に訂正 |
| 中核フローの「voice.md を profile に重ねて注入」が v4 の焼き込み表現と古い | P3 | §4 を「profile.style + voice.md を合成して meta.style に焼き込む」に統一 |

## 付録: Codex レビュー反映ログ（2026-06-23・第 6 巡）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| 再 freeze 時の `--voice-file` 省略の扱いが未定（省略＝現 voice.md 再凍結と誤読され得る） | P2 | §5.3 / C1 で「凍結済み series への再 freeze は `--voice-file` 必須・`voice.md` 自身は不可・同内容は no-op 拒否」を明記 |
| `history[]` の hash と実 `voice-v<N>.md` の hash のどちらを正とするか未定 | P2 | §6.1 で「実ファイル再計算 hash を検証正本・`history[]` は索引」に。最終確定は C1 に畳み込み |

## 付録: Codex レビュー反映ログ（2026-06-23・第 7 巡）

| 指摘 | 重大度 | 対応 |
|---|---|---|
| `meta.series` 追記タイミングが未固定。runQiitaArticle 開始後/CLI 側で書くと brief の中間 writeMeta と競合・遅延確定 | P1 | §10 実装メモを「`store.create` 直後・`runQiitaArticle` 前に `meta.series` を確定」に固定。根拠を [createQiitaArticle.ts:43-51 / 728-733](../src/workflows/createQiitaArticle.ts#L43-L51) で裏取り |
| 推奨①の理由「run/meta は workflow/store 所有」は強すぎ（record-publication/importArticle は CLI/helper が writeMeta する） | P2 | 理由を「create の成否と `meta.series` 確定を同じ workflow 境界に置けるため」に訂正 |
