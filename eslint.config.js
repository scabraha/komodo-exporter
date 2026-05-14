// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The runtime data we get from komodo_client is heavily typed, but we
      // occasionally need to widen to `unknown` (errors, JSON-decoded blobs).
      // Forbid `any` outright; rely on `unknown` + narrowing instead.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      // Tests reach into private members via well-typed structural casts;
      // the unsafe-* and explicit-any rules add noise without catching bugs
      // that the type system isn't already catching.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    files: ["vitest.config.ts", "eslint.config.js"],
    languageOptions: {
      parserOptions: { project: null },
    },
    extends: [tseslint.configs.disableTypeChecked],
  },
);
