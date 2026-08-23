import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "vendor/**",
      ".worktrees/**",
      "**/.worktrees/**",
      ".scratch/**",
      "**/.scratch/**",
      "scratch/**",
      "**/scratch/**",
      "node_modules/**",
      "**/node_modules/**",
      // Intentionally corrupt eval fixture (CL-6882) — parser cannot load it.
      "tests/fixtures/broken-toolchain/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
);
