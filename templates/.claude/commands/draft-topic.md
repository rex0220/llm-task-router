---
description: テーマから記事の指示ファイル topics/<slug>.txt（シリーズは topics/<seriesId>-<slug>.txt）を規約に従って起案する（本文は書かない）
---
与えられたテーマから、`article:create` に渡す指示ファイル `topics/<slug>.txt` を起案してください。本文は書かず、ブリーフ（企画書）だけを作ります。

テーマ: $ARGUMENTS

シリーズ指定: 引数に `--series <slug>` が含まれる場合、その記事はシリーズ `<slug>` のメンバーです。**ファイル名は `topics/<seriesId>-<記事slug>.txt`**（接頭辞でシリーズが分かる形）にし、profile はシリーズの profile（`series/<slug>/series.json` の `profile`）に既定で揃えます。`--series` が無ければ従来どおり `topics/<記事slug>.txt`。

規約（この構成・方針を必ず守る）:
- 次の見出しを必ず埋める：
  - `# テーマ`（1行。仮タイトル可）
  - `# 想定読者`（誰向けか・前提知識の置き方）
  - `# ゴール（読者が得るもの）`（「読者が〜できる」の達成形で 2〜4 点）
  - `# 含めたい要素`（記事の骨子。導入→本論→まとめが追える順序で）
  - `# 制約`（トーン: 煽らない・断定しすぎない・未解明や諸説は明示／文字数の目安／profile）
- コードを含むテーマなら `# コードの扱い` を足す：コード例は Node/TS で型が通る形（build-verifier の構文/型チェック用。**コードは実行されない**）、実行しないと確かめられない出力やランタイム依存（例: kintone.* / ブラウザAPI）は「未検証と明示」する旨を書く。
- 手順を扱うテーマなら、読者がそのまま実行できる粒度まで具体化する（曖昧な一般論にしない）。
- slug はテーマから kebab-case で決める（例: kintone-plugin-conflict）。profile の既定は qiita（シリーズ指定時はシリーズの profile）。
- ファイル名: 単発は `topics/<slug>.txt`。シリーズ（`--series <slug>` 指定）は `topics/<seriesId>-<記事slug>.txt`（例: `topics/dinosaur-tyrannosaurus.txt`）。`<記事slug>` に seriesId を二重に付けない。

進め方:
1. テーマが薄ければ、想定読者・ゴール・含めたい要素を 1〜2 問だけ確認する。
2. 上記規約で指示ファイル（単発 `topics/<slug>.txt` / シリーズ `topics/<seriesId>-<slug>.txt`）を作成し、内容を提示して**承認を得る**。
3. ここでは記事生成を走らせない（記事化は別途 /write-article で行う。シリーズは `article:create --series <slug> --topic-file topics/<seriesId>-<slug>.txt`）。
