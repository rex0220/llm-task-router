# 実装計画：方向性ゲート（優先度3 / direction-check.md）

対象: [docs/課題-対策案.md](課題-対策案.md) の優先度3 — **factcheck の前に方向性ゲート `runs/<id>/direction-check.md` を置く**（課題3「時間がかかりすぎる／factcheck 前にドラフトを見て方向性を確認したい」を回収）。

この文書は実装計画のみ（コードは含まない）。優先度1の進捗基盤（`progress.events.jsonl` / canonical 工程 / `article:status`）と優先度2の作法（editor 欄のマーカー保護・`runs/<id>/` に閉じる）の上に積む。前提コミット: `feat/progress-logging`（`b3a92c6`）。

---

## 背景（工程タイムラインの確認）

- `article:create` は `brief → outline → draft.md → review → final.md` を**1コマンドで通す**（[src/workflows/qiitaSteps.ts](../src/workflows/qiitaSteps.ts)）。つまり create 後には **final.md が既に存在**する。draft.md も残る。
- 高コストな工程は factcheck（Web 裏取り）と build-verify（実機）で、いずれも create/refine の**後**に編集長が発注する。
- 方向性ゲートの狙いは「factcheck/build に時間を溶かす前に、記事の方向性（テーマ適合・構成・読者）を編集長が一度見て OK/要修正を決める」こと。**正確性ゲートではない**（事実は factcheck、品質は refine/editorial が持つ）。

---

## 設計の確定事項（実装中に揺らさない）

- **direction-check は publication-check と同型の「編集長主体の軽量ゲート」**。判定（方向性 OK / 要修正）は編集長が下す。コードは判定を再評価しない。
- **記録は `runs/<id>/direction-check.md` に閉じる**。優先度2と同じく **`<!-- auto:begin/end -->` のマーカー保護**を使うが、領域の切り分けを優先度2と変える:
  - **auto ブロック（CLI 駆動・毎回上書き）**: 方向性スナップショット（タイトル・見出しアウトライン・分量）＋ **verdict ＋ 指示（`--verdict`/`--note` の値）**。verdict は CLI 引数が権威なので auto に置く。
  - **editor 欄（マーカー保護で保持）**: 編集長の**自由記述の所感**のみ（verdict は置かない）。
  - こうすると「verdict は CLI 必須・毎回権威」と「再生成で editor を保持」が衝突しない（verdict は毎回 auto に反映され、progress note と常に一致。所感だけが残る）。final 変更後の再生成は「方向性を再判定する」意味になるので毎回 `--verdict` 必須は意味的にも正しい。
- **進捗は canonical 工程 `direction` として記録する（ただし `source=final` のときだけ）**。`article:status` の現在地に「方向性ゲート」が出る。位置は **evaluate（final-review）の後・factcheck の前**（高コスト工程の直前）。canonical 工程数は 9 → 10 になる（既存 aggregate テストの期待値を更新）。
- **読む対象（source）と canonical 充足を分ける**（対策案 §3-A ＋ stale gate 回避）:
  - **`--source final`（既定）= 本ゲート**。canonical `direction` を `done` にする（factcheck 直前の正式な方向性判定）。
  - **`--source draft` = 早期プレビュー**。draft は refine/evaluate でこの後 final が変わるため、**canonical `direction` は満たさない**。記録は**非 canonical の `direction-draft` イベント**として残す（`article:status` では末尾の追加工程に並び、canonical ゲートを前進させない）。これで「draft で OK → final 変化 → status 上は direction 済み」という stale gate を防ぐ。
- **verdict は2値、progress 状態に写像する**: `ok` → canonical `direction=done`（ゲート通過、factcheck へ）。`revise` → canonical `direction=error`（**未通過**）。`revise` を `done` で記録すると aggregate が完了扱いし `article:status` が factcheck に進む＝その後 final を revise しても `done` が残り **stale gate** になる。`error` なら currentIndex は direction に留まり、**再判定 `ok`（done）が error を上書き**する（aggregate の done>error・retry 成功ロジックに乗る）。あわせて `revise` のときは stderr で強く警告し、note に `revise before factcheck` を残す。写像は純関数 `directionGateStatus(verdict)` に切り出してテストする。
- **factcheck の事前条件にはしない（強制ゲートにしない）**。direction-check はあくまで効率化の推奨ステップ。verify-artifacts や factcheck の実行を direction-check の有無でブロックしない（publication-check のような公開前必須ゲートとは別物）。運用（編集長手順）で「factcheck の前に回す」を促すに留める。
- **コストは持たない**。direction-check は編集長の判断であり model 呼び出しを伴わない（アウトライン抽出はローカル処理）。progress の `direction` イベントに costUsd は載せない。

---

## タスク分解

### T1. canonical 工程に `direction` を追加
- **変更**: [src/progress/stepOrder.ts](../src/progress/stepOrder.ts) の `QIITA_CANONICAL_STEPS` に `{ key: "direction", label: "方向性ゲート" }` を **evaluate と factcheck の間**へ挿入。
- alias は不要（新規 step 名）。ただし将来の表記ゆれ用に `direction-check` → `direction` を `STEP_ALIASES` に入れておく（progress:event で `--step direction-check` と打たれても畳む）。
- **完了条件**: `aggregate` が 10 工程を返す。既存テスト（「9工程」「currentIndex」「complete」系）の期待値を更新（後述 T5）。

### T2. アウトライン抽出（純関数）
- **追加**: `src/cli/directionCheck.ts` に方向性スナップショットの収集・抽出を置く。
  - `extractOutline(markdown): { title?: string; headings: { level: number; text: string }[]; chars: number }`
    - title は本文先頭 H1（[src/cli/export.ts](../src/cli/export.ts) の `firstH1` を再利用。優先度2で export 済み）。
    - headings は `##` / `###` 行を順に（コードフェンス内の `#` は除外する。export の H1 抽出と同じく「行頭 # 」判定で、fenced code block 内は無視）。
    - chars は本文の文字数（分量の目安。見出し数とあわせて構成の粗密が分かる）。
  - `DirectionCheckData = { runId; source: "final" | "draft"; title?; headings; chars; verdict: "ok" | "revise"; note?; profile?; topic? }`
  - 収集 `collectDirectionCheckData(store, runId, source, verdict, note)`: meta（topic/profile）＋対象 md を読み、上記に集約。対象 md（final.md / draft.md）が無ければ明確にエラー（source の取り違えを早期に気づかせる）。
- **完了条件**: コードフェンス内 `#` を見出しに拾わない。final.md / draft.md の取り違えを検出。I/O と整形を分離。

### T3. Markdown レンダリング ＋ マーカー保護（優先度2を踏襲）
- **追加**: `src/cli/directionCheck.ts` に `renderDirectionCheck(data)` と `mergeDirectionCheck(data, existing)`（優先度2の `mergeCompletionReport` と同じマーカー保護ロジック。begin/end が1つずつ正順かを検査し、破損は recovered）。
  - 共通化の検討: 優先度2の `mergeCompletionReport` とマーカー保護は実質同じ。**マーカー結合ヘルパを `src/cli/markerMerge.ts` などへ抽出**し、completion-report と direction-check の両方から使う（コピペ防止。優先度2のレビューで「コピペは必ずズレる」を踏襲）。`mergeCompletionReport` もそれを使うようリファクタ。
- **出力テンプレート**:
  ```md
  # 方向性ゲート: <runId>

  <!-- auto:begin -->
  <!-- 自動生成。再生成で上書きされます（verdict/指示は --verdict/--note が権威）。所感は下の編集欄へ。 -->
  - 対象: <final.md | draft.md>
  - テーマ: <topic>
  - profile: <profile>
  - タイトル: <H1>
  - 分量: 約 N 文字 / 見出し M 本
  - verdict: <ok | revise>
  - 指示（revise のとき）: <--note の値。factcheck の前に revise する具体指示>

  ## アウトライン
  - ## 見出し1
    - ### 小見出し…
  <!-- auto:end -->

  ## 所感（編集長）
  <!-- editor: 方向性の所感・OK の理由・気になる点をここに。verdict は上の auto 欄（--verdict）が権威 -->
  ```
  - **領域の切り分け**: verdict/指示は **auto ブロック**（`--verdict`/`--note` が権威。毎回上書き）。editor 欄は**自由記述の所感のみ**。これで「CLI 必須の verdict」と「再生成で editor 保持」が衝突しない（優先度2は editor に GO/NO-GO 転記を置いたが、direction では verdict を CLI 駆動にするため auto 側へ）。
- **完了条件**: 再生成でアウトライン＋verdict（auto）が最新化され、所感（editor）は残る。マーカー破損で bak。

### T4. CLI サブコマンド `article:direction-check`
- **追加**: [src/index.ts](../src/index.ts) に登録。
  - `--run <id>`（必須）
  - `--verdict <ok|revise>`（**毎回必須・権威**。編集長が記事を読んだ上での判定。再生成＝方向性の再判定なので毎回明示させる）
  - `--note <text>`（任意。要修正の指示。`verdict revise` のときは推奨）
  - `--source <final|draft>`（既定 final）
  - `--stdout`（**保存も progress 記録もしない**完全な dry run。標準出力にプレビューを出すだけ）
  - `--reset-editor`（所感 editor 欄を初期化＋bak。優先度2と同じ作法）
- **挙動**:
  1. `assertRunExists`。
  2. T2 収集（対象 md 不在ならエラー）→ T3 レンダリング。
  3. `--stdout` なら**ここで標準出力して終了**（ファイル保存も progress 記録もしない）。
  4. それ以外: マーカー保護で `direction-check.md` 保存。
  5. **progress 記録（source で分岐）**:
     - `source=final`: `recordProgress(store, runId, { step: "direction", status: directionGateStatus(verdict), note: ... })`（cost なし）。`ok`→`done`、`revise`→`error`。`revise` の note に `revise before factcheck` を含める。
     - `source=draft`: **非 canonical の `direction-draft`** として記録（canonical `direction` は前進させない＝stale gate 回避）。
  6. stdout: `direction-check: runs/<id>/direction-check.md` ＋ verdict。`revise` のときは **stderr に `⚠ 方向性 要修正: factcheck の前に revise してください` を強めに出す**。
- **進捗の扱い**: `direction` は canonical 工程（`source=final` のみ充足）。`source=draft` は早期プレビューで canonical を満たさない。`--stdout` は記録しない。
- **allowlist**: `templates/.claude/settings.json` に `Bash(llm-task-router article:direction-check:*)` を追加（model 呼び出し無し・読み取り中心＝自動承認）。
- **完了条件**: `article:direction-check --run <id> --verdict ok` で direction-check.md 生成＋`article:status` に「方向性ゲート done」が出る。`--source draft` では canonical direction が done にならない。`--stdout` ではファイルも progress も残らない。

### T5. tests ＋ ドキュメント
- **tests（`vitest`）**:
  - `extractOutline`: `##`/`###` を順に拾う。コードフェンス内 `#` を拾わない。H1 をタイトルに。
  - `collectDirectionCheckData`: final/draft の選択、対象不在でエラー、verdict/note の反映。
  - `renderDirectionCheck` / `mergeDirectionCheck`: auto に verdict が入る・再生成で verdict/アウトラインが最新化される・**所感（editor）は保持**・破損で recovered。
  - 共通 `markerMerge`: 抽出後、completion-report 既存テストが緑のまま（リグレッション）。
  - `stepOrder` / `aggregate`: `direction` が evaluate と factcheck の間に入り total=10。`direction-draft` は非 canonical（末尾の追加工程）で canonical `direction` を前進させない。
  - CLI: 対象 md 不在で明確エラー。`--stdout` でファイルも progress も残らない。`--verdict` 必須。`--source draft` で canonical direction が done にならない。
- **ドキュメント**:
  - [docs/qiita-article-howto.md](qiita-article-howto.md): 「6. ファクトチェック」の**前**に「5.x 方向性ゲート（direction-check）」節を新設。付録フローに factcheck の前へ1〜2行。
  - [templates/.claude/agents/article-editor-in-chief.md](../templates/.claude/agents/article-editor-in-chief.md): 進行の手順4（factcheck 発注）の**前**に「方向性ゲートを回す（OK で factcheck へ／要修正なら revise）」を追記。コマンド早見に追加。
  - [CLAUDE.md](../CLAUDE.md) / [templates/CLAUDE.md](../templates/CLAUDE.md): 「factcheck の前に方向性ゲートを通す」を1行（任意の推奨ステップである旨）。
- **完了条件**: `npm test` 緑。`init` 後フォルダで `article:direction-check` がプロンプトなしで動く。

---

## 依存関係と着手順

```
T1 (canonical 追加) ─┐
T2 (アウトライン抽出) ─┼─ T3 (描画＋マーカー保護/共通化) ─ T4 (CLI) ─ T5 (tests/docs)
```

- T1 は独立で先に入れられる（既存テスト更新を伴う）。T2→T3→T4 が本体。
- T3 でマーカー保護を `markerMerge.ts` に抽出し、優先度2の completion-report もそれを使う形へリファクタ（同 PR 内）。

---

## スコープ外（この計画に含めない）

- 所要時間見積もり（優先度6。`progress.json` 実績が溜まってから。direction-check はコスト/所要を持たない）。
- factcheck 差分スキップ（優先度4。別計画）。
- direction-check を factcheck/verify-artifacts の**必須前提**にすること（強制ゲート化はしない。あくまで推奨）。
- model を使った自動方向性評価（方向性判定は編集長の役割。LLM 判定は入れない）。

---

## 受け入れ基準（優先度3 全体）

1. `article:direction-check --run <id> --verdict ok|revise [--source final|draft]` が `runs/<id>/direction-check.md` を生成する（`--verdict` 必須）。
2. auto ブロックにタイトル・分量・見出しアウトライン＋verdict/指示が入り、コードフェンス内 `#` を拾わない。
3. verdict/指示は auto（CLI 駆動・毎回最新）、所感は editor 欄でマーカー保護され再生成で残る（`--reset-editor` のときのみ初期化＋bak）。
4. `source=final` + `verdict=ok` のときだけ canonical `direction`（evaluate と factcheck の間）が `done` になる。`verdict=revise` は `direction=error`（未通過・currentIndex は direction に留まる・再判定 ok の done で上書き）。`source=draft` は非 canonical `direction-draft` で canonical を前進させない（stale gate 回避）。
5. `--stdout` はファイルも progress も残さない（完全な dry run）。
6. `verdict=revise` のとき stderr で強く警告し、progress を `error` で記録し note に `revise before factcheck` を残す（status が factcheck に進まない）。
7. 対象 md（final.md / draft.md）不在時は明確なエラー。
8. マーカー保護は completion-report と共通実装（`markerMerge.ts`、コピペなし）。
9. factcheck/verify-artifacts の実行を direction-check の有無でブロックしない（強制ゲートではない）。
10. `npm test` 緑、`article:direction-check` がプロンプトなしで動く。

---

## 確定した論点（レビュー反映済み）

- **canonical 位置**: `evaluate → direction(final) → factcheck` で確定。draft 版は canonical を満たさない早期プレビュー（`direction-draft`）に分離。
- **verdict の進捗反映**: `ok`→`direction=done`（通過）、`revise`→`direction=error`（未通過。再判定 ok の done で上書き）。当初は revise も done にする案だったが、aggregate が done を完了扱いし stale gate を再発させるため error に確定。あわせて stderr 警告 ＋ note に `revise before factcheck`。
- **CLI の要否**: 専用 CLI を置くで確定（アウトライン抽出＋マーカー保護まで含めると手書き＋progress:event より事故が少ない）。
- **verdict と editor 保持の衝突（追加対応）**: verdict/指示を **auto ブロック（CLI 駆動・毎回権威）** に移し、editor 欄は所感のみに限定。これで「CLI 必須の verdict」と「再生成での editor 保持」が両立し、ファイルの verdict と progress note が乖離しない。
- **stale gate 回避（追加対応）**: `source=draft` は canonical を満たさず `direction-draft`（非 canonical）で記録。`--stdout` は保存も progress 記録もしない dry run。
