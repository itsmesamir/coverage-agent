// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**", "**/migrations/**", "web/.next/**"],
  },
  {
    rules: {
      // Module-boundary enforcement is dependency-cruiser's job (it resolves
      // the real graph); eslint stays focused on code quality.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Config files loaded by tools (drizzle-kit, dependency-cruiser) that
    // require CommonJS, not project ESM. `module` and `require` are real
    // globals here, not undefined names.
    files: ["*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { module: "writable", require: "readonly", __dirname: "readonly" },
    },
  },
);
