// 本文全体が ```（言語名つきも可）で囲まれている場合のみ、その外側フェンスを除去する。
// 文中の正当なコードブロックには影響しない（先頭/末尾のフェンスが対になっている場合だけ剥がす）。
export function stripWrappingCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (!match) {
    return text;
  }

  const inner = match[1];
  // 内側にさらにフェンスが含まれる（=複数のコードブロックが並ぶ本文）なら、外側剥がしは誤りなので何もしない。
  if (inner.includes("```")) {
    return text;
  }

  return inner;
}

// 本文に紛れ込みやすい「ラップ文」（前置き・後置き・追加提案）を検知して警告文を返す。
// 自然文なので自動削除はせず、警告のみ（誤って正当な導入/結論を消さないため）。
export function detectWrapText(markdown: string): string[] {
  const warnings: string[] = [];
  const trimmed = markdown.trim();
  if (!trimmed) {
    return warnings;
  }

  const lines = trimmed.split("\n");

  // 前置きの検知は「見出しで始まるか」ではなく文言パターンで行う。
  // （Zenn/note などはタイトルが front-matter にあり、本文がリード文から始まるのが正しいため、
  //   見出し開始を必須にすると誤検知する。）
  const firstNonEmpty = lines.find((line) => line.trim() !== "")?.trim() ?? "";
  const preamblePatterns = [
    /^(以下|下記)(は|に|の)/,
    /改稿|書き直し|リライト|修正版|改訂版/,
    /^(here is|here's|below is)\b/i,
    /^(承知しました|了解しました|わかりました)/,
  ];
  if (preamblePatterns.some((pattern) => pattern.test(firstNonEmpty))) {
    warnings.push("冒頭に前置き（例:『以下は…改稿版です』）が混入している可能性があります。");
  }

  // 末尾が記事本文ではなく、追加提案・問いかけになっていないか（直近の数行を確認）。
  const tail = lines
    .filter((line) => line.trim() !== "")
    .slice(-3)
    .join("\n");
  const offerPatterns = [
    "出し直せ",
    "出し直し",
    "作り直せ",
    "作り直し",
    "ご要望",
    "ご希望",
    "いかがでしょうか",
    "どれかで",
    "いずれかで",
    "別の版",
    "他のバージョン",
    "お知らせください",
    "ご指定ください",
    "対応します",
  ];
  if (offerPatterns.some((pattern) => tail.includes(pattern))) {
    warnings.push("末尾に追加提案・問いかけ（例:『…で出し直せます』）が混入している可能性があります。");
  }

  return warnings;
}
