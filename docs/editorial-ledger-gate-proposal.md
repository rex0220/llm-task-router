# 仕組み修正案: 編集レビュー台帳（editorial-ledger）の未解決を機械ゲート化する

- 起票日: 2026-06-22
- 改訂: 2026-06-22（codex レビュー反映 / rev2）
- 対象リポジトリ: llm-task-router
- 関連 run（発覚契機）: `runs/2026-06-22-hayabusa2`（weakness 6 件すべて open・うち major 1、resolution 未設定のまま completion-report → export まで素通り）
- 関連: [CLAUDE.md](../CLAUDE.md)（「weakness を `open` のまま残さない／完成報告前に 0 にする」）、[docs/課題-対策-実装計画-completion-report.md](./課題-対策-実装計画-completion-report.md)（completion-report は publication-check を**転記**し再評価しない、という確定設計）

## 1. 問題（なぜ規律だけでは守れないか）

CLAUDE.md は「採否を決めたら `article:editorial-resolve` で `editorial-ledger.json` に書き戻す」「**weakness を `open` のまま残さない（完成報告前に 0 にする）**」と定めている。しかし、この「0 にする」を**検査するコードがどこにもない**。事実系ゲート（factcheck-scope → stamp、verify-artifacts の cited/dead 整合）が機械的に堅いのに対し、**編集判断系だけが人手の規律に丸投げ**になっている。

具体的に、現状の各コマンドは台帳の解決状態を読まない:

- **verify-artifacts（公開前ゲート）** — [src/cli/verifyArtifacts.ts:117-124](../src/cli/verifyArtifacts.ts) は editorial について「`editorial-review.md` が存在するか」だけを検査する。`editorial-ledger.json` の `status` / `resolution` は読まない。→ open が何件あっても PASS。
- **completion-report** — [src/cli/completionReport.ts:163](../src/cli/completionReport.ts) は `gateState(pc, "editorial-review")`（publication-check 由来の reviewer verdict＝`publication-candidate`）を表示するだけ。台帳の未解決件数を集計しないので、**ゲート表は open 6 件でも緑のまま**になる。
- **editorial-resolve** — [src/index.ts:766-789](../src/index.ts) の独立コマンド。**実行すれば progress event（step=`editorial-resolve`, status=`done`）を記録する**（[index.ts:780-785](../src/index.ts)）。問題は「実行すること自体が任意で、**打たなければイベントも残らず、verify-artifacts も completion-report もその欠落を検出しない**」点。silent skip 禁止の思想（verify-artifacts の no silent skip）が editorial-resolve には及んでいない。

結果、`2026-06-22-hayabusa2` の打ち忘れは一回限りのミスではなく、**この設計なら必ず再発しうる構造的な穴**である。

## 2. 用語: 「公開可（settled）」と「未確定（unsettled）」

既存の `countUnresolved`（[src/workflows/editorialReview.ts:519](../src/workflows/editorialReview.ts)）は `status ∈ {open, partial}` かつ `resolution === undefined` を「未解決」と数える。ゲート設計ではこれに **`escalated`（上申中＝まだ公開承認されていない）** を加えて「未確定」とする。

> **公開可（settled）= `status === "resolved"`、または `resolution ∈ {accepted, waived, user-approved}`**
> **未確定（unsettled）= 上記以外。すなわち**
> - **未解決（unresolved）: `status ∈ {open, partial}` かつ `resolution === undefined`、または**
> - **上申中（escalated）: `resolution === "escalated"`**

ポイント（codex High 反映）:
- `escalated` は「編集長が判断した」状態ではあるが「ユーザーが公開承認した」状態では**ない**。CLAUDE.md の運用は「上申 → ユーザー承認後に `user-approved` で打ち直す」。したがって `escalated` のまま公開してはいけない＝**ゲート上は未確定として block 側に置く**。
- `resolution` の型は `"accepted" | "waived" | "escalated" | "user-approved"`（[editorialReview.ts:15](../src/workflows/editorialReview.ts)）。`status` は `"open" | "partial" | "resolved"`。
- `resolved`（reviewer 側で解消）は settled 扱い。

### severity ごとの扱い（フェーズ1・固定既定）

| severity | 未確定（unresolved または escalated）のとき | 根拠 |
|---|---|---|
| `major` | **error（公開ブロック）** | 掲載可否に直結。今回 W001 がこれ |
| `minor` | **error（公開ブロック）** | CLAUDE.md「0 にする」を厳密に履行。候補抽出も major\|minor を対象にしている |
| `preference` | **warning（非ブロック）** | 候補抽出から除外される好みレベル。記録は促すがゲートはしない |

**フェーズ1 はこの値を固定実装**にする（config 化はしない。理由は §5）。

## 3. 共通ヘルパー（既存 `countUnresolved` と統合）

新規関数を並立させると述語がドリフトする（codex Low 反映）。**既存 `countUnresolved` の述語を再利用**し、ファイル読み取り＋severity 分解＋escalated 判定だけを上に足す。`countUnresolved` 側は内部で同じ述語を共有する形にリファクタする（外部 API は維持）。

```ts
// src/workflows/editorialReview.ts

// 既存述語を関数化して countUnresolved と共有する（定義の二重化を防ぐ）。
function isUnresolved(w: { status: WeaknessStatus; resolution?: WeaknessResolution }): boolean {
  return (w.status === "open" || w.status === "partial") && w.resolution === undefined;
}
function isEscalated(w: { resolution?: WeaknessResolution }): boolean {
  return w.resolution === "escalated";
}
// 公開を止めるべき「未確定」= 未解決 または 上申中。
function isUnsettled(w: { status: WeaknessStatus; resolution?: WeaknessResolution }): boolean {
  return isUnresolved(w) || isEscalated(w);
}

// 既存 export は維持（中身を述語共有に置換）。
export function countUnresolved(
  weaknesses: { status: WeaknessStatus; severity: WeaknessSeverity; resolution?: WeaknessResolution }[]
): number {
  return weaknesses.filter(isUnresolved).length;
}

export type UnsettledWeakness = {
  id: string; severity: WeaknessSeverity; status: WeaknessStatus;
  reason: "unresolved" | "escalated"; problem: string;
};
export type EditorialGateInput = {
  hasLedger: boolean;
  major: UnsettledWeakness[];
  minor: UnsettledWeakness[];
  preference: UnsettledWeakness[];
};

/** 台帳を読み、未確定（未解決 or 上申中）を severity 別に集計する。 */
export async function collectUnsettledWeaknesses(
  store: RunStore, runId: string
): Promise<EditorialGateInput> {
  const ledger = await readLedger(store, runId); // 既存 private 関数（editorialReview.ts:137）
  const out: EditorialGateInput = { hasLedger: ledger !== null, major: [], minor: [], preference: [] };
  if (!ledger) return out;
  for (const w of ledger.weaknesses) {
    if (!isUnsettled(w)) continue;
    out[w.severity].push({
      id: w.id, severity: w.severity, status: w.status,
      reason: isEscalated(w) ? "escalated" : "unresolved", problem: w.problem,
    });
  }
  return out;
}
```

## 4. 変更点

### 4-1. verify-artifacts（公開前ゲートで block）

[src/cli/verifyArtifacts.ts:117-124](../src/cli/verifyArtifacts.ts) の editorial-review ゲート `done` 経路に未確定検査を追加する。

```ts
const editorialReview = await readOrNull(store, runId, "editorial-review.md");
// checkGate の done コールバックが同期前提なら、事前に await して結果を渡す形にする。
const gate = await collectUnsettledWeaknesses(store, runId);
checkGate(pc, "editorial-review", errors, {
  done: () => {
    if (editorialReview === null) {
      errors.push("editorial-review=done ですが editorial-review.md がありません。");
      return;
    }
    // editorial-review=done を宣言している以上、採否を記録する台帳も必須にする。
    // skip 宣言の run はそもそも done 経路に入らないので、既存の skip 運用は壊れない。
    if (!gate.hasLedger) {
      errors.push("editorial-review=done ですが editorial-ledger.json がありません。");
      return;
    }
    const blocking = [...gate.major, ...gate.minor];
    if (blocking.length > 0) {
      const list = blocking.map((w) => `${w.id}(${w.severity}/${w.reason})`).join(", ");
      errors.push(
        `editorial-ledger に未確定の weakness が ${blocking.length} 件あります（unresolved は ` +
          `article:editorial-resolve で採否を、escalated はユーザー承認後 user-approved で確定してください）: ${list}`
      );
    }
    if (gate.preference.length > 0) {
      warnings.push(`editorial-ledger に未確定の preference が ${gate.preference.length} 件あります（任意・waived 推奨）。`);
    }
  },
});
```

注意点:
- `checkGate` の `done` が同期前提のため、`collectUnsettledWeaknesses` は**ブロックの外で await** して結果を渡す（async コールバック化のリファクタは避ける）。
- editorial-review が skip 宣言の run（編集レビュー未実施）では台帳が無い → `hasLedger=false` で空集計＝素通り（既存挙動を変えない）。

### 4-2. completion-report（転記思想を壊さず machine verdict を別表示）

[docs/課題-対策-実装計画-completion-report.md:16](./課題-対策-実装計画-completion-report.md) の確定設計どおり、**GO/NO-GO は `publication-check.md` からの転記が正**であり、completion-report はゲートを再評価しない。よって **publication-check の GO を黙って NO-GO に上書きしない**（codex Medium 反映）。代わりに、機械集計を**別軸として併記**する。

- データ収集（[completionReport.ts:159-167](../src/cli/completionReport.ts) 付近）で `collectUnsettledWeaknesses` を呼び、`editorial` GateInfo に未確定内訳を持たせる。
- **editorial 行**（[completionReport.ts:265](../src/cli/completionReport.ts)）の summary を拡張:
  - 未確定 0 → 従来どおり（例 `done / publication-candidate / 採用2・waived4`）。
  - 未確定あり → `done / 未確定 major1 minor0（unresolved1）— 要 editorial-resolve` を併記。
- **GO/NO-GO の表示を2層にする**:
  - `publication-check GO/NO-GO`: 従来どおり publication-check.md から**そのまま転記**（正本）。
  - `machine gate（editorial）`: `OK` / `BLOCK（未確定 N 件）` を機械集計で別行に出す。両者が食い違う場合（転記=GO だが machine=BLOCK）は「**正本=publication-check、ただし machine gate が未確定を検出**」と明示し、編集長に publication-check 側の更新を促す。
  - **台帳欠落も machine gate で検出**: `editorial-review` ゲートが `done` 宣言なのに台帳が無い場合は `BLOCK（editorial-ledger.json なし）`（verify-artifacts の §4-1 と挙動を揃える）。`skipped`/未宣言の run は台帳なしが正常なので `n/a`。
- これにより「散文では判断済みだが台帳は未処理」という今回の齟齬が、**正本を書き換えずに**表面化する。どちらが正本か曖昧にならない。

> 補足: 公開直前の硬いブロックは §4-1 の verify-artifacts に集約する（completion-report は NO-GO=差し戻し報告もあり得るため必須ブロックにしない、という既存方針 [同計画 §設計確定事項](./課題-対策-実装計画-completion-report.md) を尊重）。

## 5. config 化は別フェーズ（フェーズ1では固定既定）

`article:verify-artifacts` は現状 `--config` を受け取らず `RunStore` だけで動く（codex Medium 反映）。しきい値を config 化するには CLI のオプション経路と profile 読み込みを新設する必要があり、ゲート本体より影響範囲が広い。

- **フェーズ1**: §2 表の値（major/minor=block, preference=warn）を**固定実装**。config 経路は作らない。
- **フェーズ2（任意・別 PR）**: 媒体ごとに緩めたい需要が出たら、`editorialGate.blockOn` / `warnOn` を profile/config に追加し、verify-artifacts / completion-report へ設定注入経路を通す。後方互換は「未設定なら §2 既定」。

これでフェーズ1の事故面（未定義の config 経路）を持ち込まずに、芯の機械ゲートだけ先に入る。

## 6. エッジケース

- **編集レビュー未実施（skip）**: 台帳ファイルが存在しない → 未確定 0 件として素通り。新設ゲートが既存の skip 運用を壊さない。
- **escalated のまま export しようとする**: §2 のとおり未確定＝block。公開するには `article:editorial-resolve --resolution user-approved`（ユーザー承認後）で確定させてから。completion-report 表にも `escalated N 件` を警告表示する。
- **reviewer 再検出で resolution が失効**: 継続レビューで同じ問題が再浮上すると [editorialReview.ts:181-184](../src/workflows/editorialReview.ts) が `resolution` を削除＝再び未解決。新ゲートは「蒸し返された指摘を再 resolve するまで公開を止める」ことになる（仕様どおり）。
- **preference のみ未確定**: 既定では warning のみ。verify-artifacts は PASS、publication-check 転記 GO も維持。

## 7. テスト

- `tests/cli/verifyArtifacts.*`（または bin.e2e）:
  - editorial-review=done＋台帳に major open・resolution なし → **FAIL**。
  - 同 weakness に `accepted` → **PASS**。
  - major `escalated` → **FAIL**（公開承認前）。同 weakness に `user-approved` → **PASS**。
  - preference open のみ → PASS（warning は出る）。
  - 台帳ファイルなし（編集レビュー skip）→ PASS。
- `tests/cli/completionReport.*`:
  - major 未確定ありで生成 → editorial 行に「未確定 major1」、machine gate=BLOCK を表示し、**publication-check 転記 GO/NO-GO はそのまま**（上書きしないことを assert）。
  - 全件 settled → 従来どおり（machine gate=OK）。
- `tests/workflows/editorialReview.test.ts`:
  - `isUnresolved` / `isEscalated` / `collectUnsettledWeaknesses` の severity 別集計、`countUnresolved` が述語共有後も従来値を返すこと（リグレッション）。

## 8. ロールアウト

1. `isUnresolved`/`isEscalated`/`isUnsettled` 述語抽出 ＋ `countUnresolved` を述語共有へ置換（外部 API 不変）＋ `collectUnsettledWeaknesses` 追加 ＋ 単体テスト。
2. verify-artifacts にゲート追加（error/warning）＋テスト。
3. completion-report に未確定表示＋machine gate 別行（転記 GO/NO-GO は不変）＋テスト。
4. CLAUDE.md / docs を「機械ゲート化済み」に追記（規律→ゲート格上げ）。
5. config 化はフェーズ2（別 PR）として §5 に切り出し。
6. 既存 run への影響確認: `editorial-review=done` かつ未確定ありの過去 run は verify-artifacts が FAIL に転じる。再公開予定がなければ無視可、必要なら resolve して再生成。

## 9. このゲートで防げること（まとめ）

- 「completion-report の散文では判断済みだが、正本（台帳）は open のまま」という齟齬を**機械的に検出**（正本を書き換えずに併記）。
- editorial-resolve の打ち忘れ／`escalated` のまま公開で major 指摘が公開前ゲートを素通りする事故を**ブロック**。
- 「完成報告前に open 0」を、文章規律から**強制ゲート**へ格上げ。
