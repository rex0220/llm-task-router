import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 既定 5s だと、フルスイート並列実行の負荷時にモック workflow テスト
    // （tests/workflows/createQiitaArticle.test.ts 等）が flaky に timeout する。
    // 内容不一致ではなく負荷由来なので、余裕を持たせる。
    testTimeout: 20000,
    hookTimeout: 30000,
    // ローカルタイム表示（progress の開始/終了/更新）を決定的にテストするため TZ を固定する。
    // Node の Date はプロセス起動時 TZ に依存するので、テスト先頭の process.env.TZ ではなくここで固定。
    env: { TZ: "Asia/Tokyo" },
  },
});
