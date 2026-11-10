import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default defineConfig([
  { ignores: ["node_modules/**", "lib/generated/**"] },
  {
    files: [
      "src/chatgpt-snapshot.cts",
      "src/ontology-projection.cts",
      "src/semantic-validation.cts",
      "src/semantic-queue.cts",
    ],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    linterOptions: { noInlineConfig: true },
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
  {
    files: [
      "eslint.config.mjs",
      "lib/adapters/chatgpt-snapshot.cjs",
      "lib/codex-discovery.cjs",
      "lib/ontology-projection.cjs",
      "scripts/check-ts-scope.cjs",
      "scripts/smoke-package.cjs",
      "tests/chatgpt-snapshot.test.cjs",
      "tests/codex-discovery.test.cjs",
      "tests/ontology-projection.test.cjs",
    ],
    extends: [js.configs.recommended],
    linterOptions: { noInlineConfig: true },
    languageOptions: {
      globals: {
        Buffer: "readonly",
        TextDecoder: "readonly",
        console: "readonly",
        process: "readonly",
      },
    },
  },
]);
