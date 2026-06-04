import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/**"] },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript already checks for undefined identifiers.
      "no-undef": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      // The one type-aware rule we care about: don't drop a promise on the floor.
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  prettier,
);
