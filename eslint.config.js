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
      // Intentionally invalid source: the broken-toolchain eval fixture.

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
      // LogTape (and a few test spies) use tagged-template logging as a
      // statement; the expression is the side effect.
      "@typescript-eslint/no-unused-expressions": ["error", { allowTaggedTemplates: true }],
      // Staged adoption: the codebase predates these two rules and carries
      // ~1200 pre-existing violations, almost all in tests and TUI plumbing.
      // Warning keeps them visible without making the CI gate unachievable;
      // they graduate to "error" once the backlog is cleared.
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/no-empty-function": "warn",
    },
  },
  {
    files: ["src/util/control-char-strip.ts"],
    rules: {
      // This module's job is matching C0/C1 bytes; the patterns are the
      // product, not a lint accident.
      "no-control-regex": "off",
    },
  },
);
