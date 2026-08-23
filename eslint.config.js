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
      // Staged adoption: the codebase predates these two rules and carries
      // ~1200 pre-existing violations, almost all in tests and TUI plumbing.
      // Warning keeps them visible without making the CI gate unachievable;
      // they graduate to "error" once the backlog is cleared.
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/no-empty-function": "warn",
    },
  },
);
