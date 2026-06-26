# 課題・対策・実装計画：article:finalize（仕上げ工程の単一コマンド化）

## 背景

記事の仕上げ（公開前の出典まわり）は現状、編集長が次の複数コマンドを別々のツール呼び出しで順に回している：

```
article:claims-normalize → article:sources-check --only-cited → article:claims-normalize → article:references
```

オペレーターを Claude Code で回すと、ツール呼び出し1回ごとにシリアライズ崩れ（`invoke` タグの本文漏れ）の機会が増え、まれに工程が止まってユーザーの「Go」を要する（[qiita-article-howto.md 4.6](qiita-article-howto.md) 参照）。**ツール呼び出しの回数を減らせば、崩れの「面」そのものが減る**。

加えて、現状の手回しには次の落とし穴がある（codex レビューで確認済み）：

- **順序依存**: `sources-check --only-cited` は `claims.json` / `sources.json` を前提とし、無ければ throw する（[src/index.ts:1890-1894](../src/index.ts)）。先に `claims-normalize` が要る。
- **到達性 stamp は raw 側に入る**: `sources-check` は `applyReachabilityToRaw` で `sources.raw.json` を更新する（[src/index.ts:1925-1926](../src/index.ts)）。`sources.json`（採番済み台帳）と参考章へ反映するには **check 後にもう一度 `claims-normalize`** が必要。
- **dead/unknown でも通常終了**: `sources-check` は dead/unknown があっても summary と `next:` を出すだけで throw しない（[src/index.ts:1936-1950](../src/index.ts)）。exit code だけ見て次へ進むと**未解決リンクが残ったまま「仕上げ完了」に見える**。

## 課題

仕上げ工程を、**順序を正しく固定し、未解決リンク（dead/unknown）で確実に止まり、ツール呼び出し1回で回せる**単一コマンドにする。

## 対策（設計）

新コマンド `article:finalize` を追加する。内部で既存ロジックを正しい順序で呼び、未解決があれば**非ゼロ終了して修正指示を出す**。

### 実行順序

```
1. claims-normalize            （raw → 採番済み claims.json / sources.json）
2. sources-check --only-cited  （cited な URL を HTTP 確認し reachable を raw に stamp）
3. [ゲート] summary.dead > 0 || summary.unknown > 0 なら停止（後述）
4. claims-normalize            （到達性 stamp(raw) を sources.json へ畳み直す）
5. references                  （sources.json から参考章を機械生成し final.md へ反映）
```

- 2 の到達性確認は **外部通信**。ここは現状設定との整合に注意（後述「auto-approve との整合」）。`finalize` は `sources-check` を内包するので、通信実行の承認方針は `sources-check` 単体と揃える。
- 1 と 4 はどちらも `claims-normalize`。raw が factcheck で出ている前提（無ければ 1 が既存エラーで止まる）。

### auto-approve との整合（P1・要注意）

現行の [templates/.claude/settings.json](../templates/.claude/settings.json) は `Bash(llm-task-router article:*)` の**接頭辞許可**で、hook も `sub.startsWith(ALLOWED_ARTICLE_PREFIX)` で判定する（[auto-approve-llm-task-router.mjs](../templates/.claude/hooks/auto-approve-llm-task-router.mjs)）。つまり **`article:finalize` を足すと自動的に auto-approve 対象になる**。同じ理由で **`article:sources-check` も実は今は自動承認されている**（権限層では通信系を区別していない）。

CLAUDE.md / howto の「外部通信なので明示承認を取る」は、**権限層のブロックではなく会話レベルの規律**（編集長が通信前にユーザーへ確認する。`export` の GO/NO-GO と同じ運用）として効いている。`finalize` もこの前提に合わせる。選択肢：

- **(既定) 現行モデルを踏襲**: `finalize` は `article:*` で auto-approve される。通信実行の承認は会話レベル（編集長が `finalize` 実行前にユーザー確認）で担保し、export と同列に扱う。設定変更なし・整合が取れる。**メモの旧記述「auto-approve から除外」は撤回**する。
- **(任意) 真に権限層で止めたい場合**: `article:*` の接頭辞許可をやめて**明示コマンドリスト化**するか、hook に**通信系 denylist**（`sources-check` / `finalize`）を足す。挙動変更が大きく既存の運用（sources-check も今は自動承認）も変わるため、別タスクとして切る。

→ 本実装では **(既定) を採用**し、howto 承認回数の節に「`finalize` / `sources-check` は権限層では自動承認、通信実行の可否は会話レベルで確認」と**正確に**書く（「入れない」とは書かない）。

### dead/unknown ゲート（P2）

- 3 のゲートは `sources-check` の **`--json` summary（`{summary, flagged}`）を内部で読む**（`flagged` は既に算出済み・[src/index.ts:1909-1922](../src/index.ts)）。
- `summary.dead > 0 || summary.unknown > 0` のとき：
  - 4・5 へ進まず**停止**し、非ゼロ終了する。
  - `flagged`（URL＋reachable）を列挙し、「dead は verified claim から到達可能な代替へ張り替え → factchecker 修正 → finalize 再実行」「unknown は公開前に解決」という**次アクション**を stderr に出す。
- これにより「exit 0 で素通り」を塞ぐ。

### 副作用とリラン（P1）

- `finalize` は途中（2 以降）で外部通信し、raw / sources.json / final.md を更新し得る。**「常に副作用ゼロ」ではない**ので、停止後の再実行は各工程の冪等性（first-write-wins・bak 退避）に乗る前提。
- 途中停止時は `article:status` と成果物を確認してから再実行する（howto 4.6 の2分岐に準拠）。

### progress 記録の所在（P2・明示する）

「各サブ工程が自動記録される」は不正確。現状の記録状況は工程ごとに違う：

| 内部工程 | progress 記録 | 備考 |
|---|---|---|
| `claims-normalize` | あり | canonical 工程として記録 |
| `sources-check` | あり | 非 canonical の「追加アクション」として 1 行（dry-run 時は書かない・[src/index.ts:1924-1933](../src/index.ts)） |
| `references` | **なし** | 現状 `recordProgress` を呼んでいない（[src/index.ts:1694](../src/index.ts)〜） |
| `finalize-override` | あり | `--allow-unverified-links` で gate を貫通したときだけ、override 理由（`--note`）を非 canonical イベント 1 行で残す（stderr だけにしない＝監査理由の永続化・P2） |

- `finalize` は薄いオーケストレータで、**独自の canonical 工程は増やさない**（段数を変えない）。記録は各内部工程の既存挙動に従う＝上表のまま。
- **action 本体を内部関数へ抽出する際の注意**: 各 CLI action 側にある `recordProgress` 呼び出しを内部関数へ一緒に移すこと（CLI action 側に残したまま内部関数だけ呼ぶと**記録が抜ける**）。`references` は元々無記録なので、`finalize` で参考章生成の足跡を残したいなら**この機会に references へ非 canonical イベントを足すか**を別途判断する（足すなら sources-check と同じ「追加アクション」粒度で・dry-run/`--stdout` 時は書かない）。

### オプション（案）

| オプション | 既定 | 意味 |
|---|---|---|
| `--run <id>` | 必須 | 対象 run |
| `--plan` | off | **無通信・無書き込み**。各工程の実行計画と現状の cited 件数だけ表示（最も安いプレビュー） |
| `--dry-run` | off | **既存 `sources-check --dry-run` と同義＝通信はするが書き込まない**。2 で到達性を確認し dead/unknown を報告するが、raw/sources.json/final.md は書かない（4・5 もスキップ） |
| `--allow-unverified-links` | off | dead/unknown でも 4・5 まで進める（理由 `--note` 必須・export 側の既存フラグと整合） |
| `--references-heading <text>` | — | 既存 `references` と同じ（run 単位 first-write-wins） |
| `--json` | off | 各工程の結果を機械可読でまとめて出力 |

> `--allow-unverified-links` は緊急避難用。既定では dead/unknown で止める（P2 の主旨）。export 側に同名フラグがあるので**名前と意味を揃える**。

#### override と dead の境界（定義）

override は **gate を貫通**させるが、その先の `references` は `reachable:"dead"` を**機械除外**する（死リンクは焼かない・[references.ts](../src/cli/references.ts) `selectReferenceSources`）。したがって override 時の挙動は cited の構成で分岐する：

- **非 dead の cited が1件でも残る**（unknown / ok 混在含む）→ finalize は**成功**。dead は参考章から除外され warn が出る。unknown は載る（公開前に解決を促す warn）。
- **cited が全部 dead** → 参考章に載せる source が 0 件になり `references` が**失敗**（"参考に載せる検証済み source がありません…到達可能なもの無し"）＝非ゼロ終了。**これは意図どおりの境界**で、死リンクだけで参考章を捏造しない（override は gate を越えるだけで、死リンクを公開可能にはしない）。E2E で両ケースを固定（partial-dead 成功 / all-dead 失敗）。

## 実装計画（段階）

1. **オーケストレータ抽出**: `claims-normalize` / `sources-check` / `references` の各 action 本体を、CLI 引数パースから切り離した内部関数に整理（既に近い形なら薄い wrapper でよい）。`sources-check` の内部関数は `{summary, flagged}` を返り値で取れるようにする（現状 console 出力だけなので戻り値化）。
2. **`article:finalize` action 追加**: 上記 5 ステップを順に呼び、3 のゲートで早期 return（非ゼロ終了）。
3. **テスト**: (a) 正常系（dead=0/unknown=0 で 5 まで完走し参考章が出る）、(b) dead>0 で 4 に進まず非ゼロ終了、(c) `--plan` で**無通信・無書き込み**（実行計画と cited 件数だけ出る）、(d) `--dry-run` で**通信あり・書き込みなし**（到達性は確認し dead/unknown を報告するが raw/sources.json/final.md 不変・4/5 スキップ）、(e) `--allow-unverified-links` で dead/unknown でも貫通。
4. **ドキュメント**: howto 6.7 / 付録フローに「`finalize` で 5.8〜5.85 をまとめて回せる（個別コマンドは引き続き可）」を追記。承認回数の節に「`finalize` / `sources-check` は権限層では `article:*` で自動承認、通信実行の可否は会話レベルで確認（export と同列）」と正確に書く（「入れない」とは書かない＝P1）。

## 非対象（今回入れない）

- Stop フックによる自動差し戻し（別設計。現 hook は PreToolUse のみ＝[templates/.claude/settings.json](../templates/.claude/settings.json) の `hooks.PreToolUse`）。やるなら「復元実行」ではなく「壊れている旨を返して正しい再実行を促す」差し戻し止まり。
- 個別コマンドの廃止（`finalize` は束ねるだけ。`claims-normalize` 単体・`references --stdout` 等は残す）。

## 関連

- 死リンク再発防止の全体像: [課題-対策-実装計画-死リンク再発防止.md](課題-対策-実装計画-死リンク再発防止.md)
- 手順: [qiita-article-howto.md](qiita-article-howto.md)（6.7 公開前ゲート、4.6 復旧）
