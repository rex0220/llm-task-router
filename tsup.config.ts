import { defineConfig } from "tsup";

// CLI を単一の Node ESM bundle に固める。
// - 出力: dist/llm-task-router.js（package.json の bin が指す実体）
// - shebang を付与して直接実行可能にする
// - 依存パッケージ（openai/@anthropic-ai/sdk/commander 等）は external のまま
//   （node_modules から解決。bundle に取り込まない）
export default defineConfig({
  entry: { "llm-task-router": "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node18",
  outDir: "dist",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
  splitting: false,
  sourcemap: false,
  dts: false,
});
