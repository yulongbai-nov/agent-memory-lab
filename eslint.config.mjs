import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default defineConfig([
  { ignores: ["node_modules/**", "lib/generated/**"] },
  {
    files: ["src/*.cts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    linterOptions: { noInlineConfig: true },
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
]);
