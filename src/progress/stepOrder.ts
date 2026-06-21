// canonical（標準）工程順。currentIndex / total を「イベントが来た順」に依存させず安定させるための定義。
// 記録は CLI アクション単位の粒度（create 内部の brief/outline/draft/review/final は alias で create に畳む）。
// ここに無い step は aggregate で末尾に「追加工程」として登場順に並ぶ。

export type CanonicalStep = { key: string; label: string };

// 課題.md の7工程表に対応する高レベル工程（CLI/サブエージェントの記録粒度）。
export const QIITA_CANONICAL_STEPS: CanonicalStep[] = [
  { key: "create", label: "create（企画→draft）" },
  // 評価と改稿は同じ「final-review」段。article:refine（評価＋改稿ループ）と article:evaluate
  // （採点のみ）は同一段の代替エントリなので1枠に統合する（evaluate は alias で refine へ畳む）。
  { key: "refine", label: "評価・改稿（refine / evaluate）" },
  { key: "direction", label: "方向性ゲート（factcheck前）" },
  { key: "factcheck", label: "factcheck（Web裏取り）" },
  { key: "build-verify", label: "build-verify（実機）" },
  { key: "editorial", label: "編集レビュー" },
  { key: "claims-normalize", label: "claims-normalize（台帳正規化）" },
  { key: "verify-artifacts", label: "verify-artifacts（公開前ゲート）" },
  { key: "export", label: "export（公開相当）" },
];

// 記録名 → canonical キーへの寄せ。create の内部工程やコマンド別名を高レベル工程に畳む。
export const STEP_ALIASES: Record<string, string> = {
  // create の内部ステップ
  brief: "create",
  outline: "create",
  draft: "create",
  review: "create",
  final: "create",
  // コマンド別名
  "review-editorial": "editorial",
  editorial_review: "editorial",
  "claims-recheck": "claims-normalize",
  "direction-check": "direction",
  // 評価（article:evaluate）は改稿段に畳む（refine と同じ final-review 段）。
  evaluate: "refine",
  // 注: direction-draft（早期プレビュー）は canonical direction に畳まない（非 canonical のまま）。
};

export function resolveCanonicalKey(step: string): string {
  return STEP_ALIASES[step] ?? step;
}
