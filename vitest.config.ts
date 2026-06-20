import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 既定 5s だと、フルスイート並列実行の負荷時にモック workflow テスト
    // （tests/workflows/createQiitaArticle.test.ts 等）が flaky に timeout する。
    // 内容不一致ではなく負荷由来なので、余裕を持たせる。
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
