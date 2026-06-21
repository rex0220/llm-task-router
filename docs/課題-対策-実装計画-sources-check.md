# 実装計画：article:sources-check（URL 到達性の自動 stamp）

課題: 到達性メタ（`reachable`）は PR #28 で「持てる・読める・守れる」ようになったが、**記録するのは factchecker の手作業**。死リンクの取りこぼし（factchecker が気づかず `verified` のまま残す）を機械で拾えると、参考章に死リンクが載る事故をさらに減らせる。前提: PR #28（到達性メタ）反映後の main。

これは **HTTP 外部通信を伴う**ため、PR #28 で意図的に分離した別 PR。`verify-artifacts` は通信しない原則を維持し、到達確認はこの opt-in CLI に閉じる。

実データ（`2026-06-21-pure-audio-decline`）: Sony history(403)/Fraunhofer(404)/Analog Devices(到達不能) を factchecker が手で見つけて差し替えた。`sources-check` があれば同じ死リンクを機械で `reachable:"dead"`/`"unknown"` に落とし、編集長が差し替え判断に集中できる。

---

## 設計の確定方針

- **書き込み先は `sources.raw.json`（raw を正本に保つ）**。PR #28 で normalize は「reachable は raw を正本として伝播（未記録は省略）」と決めた。`sources-check` が ledger/`sources.json` に直接書くと次の normalize で消えるため、**raw を URL 一致で更新 → 編集長が `claims-normalize` を回して propagate**、という流れにする。これで PR #28 の不変条件と衝突しない。
- **判定は通信不確実性に対して保守的**（dead は verify-artifacts の FAIL を誘発するので誤判定を避ける）。**redirect は follow し、最終応答の status で分類**する:
  - 最終 `2xx` → `"ok"`
  - `404` / `410` → `"dead"`（恒久的に存在しない）
  - `401` / `403` / その他 `4xx` → `"unknown"`（bot ブロック等で人間には生きている場合がある＝機械では断定しない）
  - `5xx` → `"unknown"`（**一時障害が多いので既定では dead にしない**。確定 dead は 404/410 のみ。将来 `--strict-dead` で 5xx→dead に格上げ可・codex 案）
  - 最終 `3xx`（redirect 上限超過 / ループ / `Location` 欠落で解決できない）→ `"unknown"`
  - ネットワークエラー / タイムアウト / DNS 失敗 → `"unknown"`（transient を dead にしない）
  - → **「迷ったら unknown」**。`dead` は 404/410 のみ。最終的な dead 確定・差し替えは編集長/factchecker の判断（`sources-check` は粗いふるい）。
- **replacedBy は触らない**（差し替え先の選定は編集的判断で factchecker の領分）。`sources-check` は `reachable` の stamp だけに専念する。
- **決定的にテストできるよう fetcher を注入**する。コア（status→reachable マッピング、raw の URL 一致更新、並行制御）は注入した fake fetch で単体テスト。CLI が実 fetch を配線。
- **opt-in・自動ゲート外**。`verify-artifacts` からは呼ばない。allowlist にも入れない（外部通信なので承認を要する）。

---

## スキーマ変更（後方互換・optional）

`checkedAt`（到達確認の鮮度）を足すと「いつ確認したか」「再確認が要るか」が台帳で分かる。`httpStatus` は任意（デバッグ用・ノイズなら入れない）。

```ts
// RawSource / Source / LedgerSource に追加（すべて optional）
checkedAt: z.string().regex(DATE_RE).optional(), // 最後に到達確認した日付（YYYY-MM-DD）
```

- `reachable` は PR #28 で追加済み。`sources-check` はこれを書く。
- `checkedAt` は `sources-check`（と将来の factcheck 手記録）が書く。normalize は raw を正本に伝播（reachable と同じ扱い）。
- **日付（DATE_RE）にする**のは `retrievedAt` と粒度を揃えるため（codex Low）。鮮度（再チェックの要否）を見るのが目的で、同日内の時刻・順序は追わない。監査で秒単位が要るなら後で ISO datetime に拡張する（その際は `retrievedAt` も合わせて検討）。

---

## タスク分解

### T1. 到達性チェックのコア（純関数 / 注入 fetch）
- **追加**: `src/cli/sourcesCheck.ts`
  - `type Fetcher = (url: string, opts: { timeoutMs: number }) => Promise<{ status: number } | { error: string }>`
  - `classifyReachable(result): "ok" | "dead" | "unknown"`（上記マッピング。純関数・単体テスト）。
  - `checkSources(sources, fetch, { concurrency, timeoutMs }): Promise<Map<urlHash, { reachable, checkedAt }>>`（並行制御つき。順序非依存）。
- **完了条件**: マッピングが仕様どおり。並行数を超えない。fake fetch で決定的にテストできる。

### T2. raw への書き戻し（URL 一致）
- **追加**: `src/cli/sourcesCheck.ts`
  - `applyReachabilityToRaw(rawSources, results): RawSource[]`：`canonicalUrl`（urlHash）一致で `reachable`/`checkedAt` を更新（既存値は上書き）。raw に無い URL は対象外。純関数。
  - **同一 canonical URL が複数 raw key で出る場合は一致する raw source を全て stamp する**（`sources.raw.json` は key 重複のみ禁止で、同一 URL が別 key で複数あり得る／codex Low）。
- **完了条件**: raw の該当 source だけ更新。URL 正規化は既存 `urlHash`/`canonicalUrl` を流用。同一 URL 複数 key は全て更新。

### T3. CLI `article:sources-check`
- **追加**: `src/index.ts` に登録。
  - `--run <id>`（必須）/ `--timeout <ms>`（既定 10000）/ `--concurrency <n>`（既定 4）/ `--only-cited`（cited な source だけ確認＝公開前の最小確認）/ `--dry-run`（**外部通信は実行するが raw を書かない**。確認用）/ `--json`（結果サマリを JSON で stdout 出力＝出力形式の指定）。
  - **`--dry-run` を主名にする**（codex Medium）。既存 `article:references --stdout`＝「生成物を出して非書き込み」とは意味が違う（sources-check は通信を伴い「書き込みだけしない」）ので、混同を避け `--stdout` は使わず `--dry-run`（非書き込み）＋ `--json`（出力形式）に分離する。
  - 挙動: `sources.raw.json` を読む（無ければ「factcheck/normalize を先に」エラー）→ `--only-cited` 指定時は `claims.json` から cited を導出して絞る → 実 fetch で到達確認 → raw を更新（`--dry-run` は書かない）→ 結果サマリ（ok/dead/unknown 件数、dead/unknown の URL）を表示（`--json` なら JSON）。
  - **次アクション案内**: 書き込んだら「`article:claims-normalize` を回して反映＋ dead を `verified` から張り替え」を stdout に案内。
  - progress: canonical 工程ではない追加アクションとして1行（`step: "sources-check"`、note に `ok=… dead=… unknown=…`）。
- **allowlist**: **入れない**（外部通信は明示承認）。
- **完了条件**: 実行で raw に reachable/checkedAt が入る。dead/unknown が要対応として見える。`--dry-run` は非書き込み。

### T4. tests（注入 fetch で決定的）
- `classifyReachable`：最終2xx→ok、404/410→dead、401/403/その他4xx/5xx/未解決3xx/error/timeout→unknown。
- `checkSources`：並行制御、混在結果の集約。
- `applyReachabilityToRaw`：URL 一致更新・正規化一致（utm 違い等）・raw 外 URL は無視。
- CLI（bin e2e、fake は使えないので `--dry-run`＋到達しない URL で unknown 経路、または `--only-cited` の絞り込み挙動を確認。実通信は最小化）。
- **完了条件**: `npm test` 緑・typecheck クリーン。実通信に依存しない。

### T5. docs
- [templates/.claude/agents/article-factchecker.md](../templates/.claude/agents/article-factchecker.md)：手記録に加えて「編集長が `article:sources-check` で機械確認 → 結果を見て差し替え判断」を1行。
- [docs/qiita-article-howto.md](qiita-article-howto.md) 参考章節：normalize 前後で `sources-check`（任意・公開前の死リンク機械ふるい）を回す案内。
- [CLAUDE.md](../CLAUDE.md)：参考章の行に「（任意）`article:sources-check` で到達確認できる」を最小追記。
- **完了条件**: いつ・何のために回すかが分かる。

---

## スコープ外
- 自動差し替え（dead → 代替 source の自動選定）。差し替え先選定は編集判断で factchecker の領分。`sources-check` は stamp のみ。
- `verify-artifacts` での到達確認（通信しない原則を維持）。
- 定期再チェック / CI 連携。まずは手動 opt-in。
- 旧 run の一括再チェック（必要なら別途）。

---

## 受け入れ基準
1. `article:sources-check --run <id>` が sources.raw.json の各 URL を HTTP 確認し `reachable`/`checkedAt` を stamp（`--dry-run` は非書き込み・`--json` は JSON 出力）。
2. 判定は保守的（**dead は 404/410 のみ**。401/403/その他4xx・5xx・3xx 未解決・通信エラーは unknown）。redirect follow 後の最終 status で分類。
3. `--only-cited` で cited な source に絞れる。
4. replacedBy は触らない。書き込みは raw のみ（normalize で propagate）。同一 URL 複数 key は全て stamp。
5. 注入 fetch で決定的にテストでき、実通信に依存しない。
6. verify-artifacts/allowlist には入れない（外部通信は明示 opt-in）。
7. `npm test` 緑・typecheck クリーン。

---

## 確定した論点（codex レビュー反映済み）
- **A. 書き込み先（確定）**: raw（normalize で propagate）。ledger 直書きは normalize と二重管理になるため不採用。PR #28 の「raw が reachable 正本」と一致。
- **B. マッピング（確定）**: 401/403/その他4xx → `unknown`。**dead は 404/410 のみ**（5xx は一時障害が多いので既定 unknown。将来 `--strict-dead` で 5xx→dead）。3xx 未解決・通信エラー・timeout も unknown。
- **C. `checkedAt`（確定）**: optional 追加。`retrievedAt` と揃え DATE_RE（日付）。`httpStatus` は入れない。
- **D. 既定値（確定）**: timeout 10s / concurrency 4 / 既定は全 source（`--only-cited` で絞る）。allowlist 非追加。
- **E. フラグ命名（codex Medium・確定）**: `--dry-run`（非書き込み）を主名。`--json`（出力形式）と分離し `--stdout` は使わない（references の `--stdout` と意味が違うため混同回避）。
- **F. 3xx（codex Medium・確定）**: redirect follow し最終 status で分類。最終 2xx→ok、解決できない 3xx（ループ/上限/Location 欠落）→unknown。
