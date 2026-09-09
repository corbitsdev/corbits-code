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
      "tmp/**",
      "**/tmp/**",
      ".claude/**",
      "**/.claude/**",
      ".tmp/**",
      "**/.tmp/**",
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
  {
    // A bare `mock.module` call has no teardown of its own, so a mock left
    // installed by one test file silently replaces a real module for every
    // other file in the same `bun test` process (see CL-6967). Route through
    // withMockedModule/withMockedModuleDuring (tests/helpers/mock-module.ts)
    // instead, which register their own restore.
    files: ["**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='mock'][callee.property.name='module']",
          message:
            "Use withMockedModule/withMockedModuleDuring from tests/helpers/mock-module.ts instead of bare mock.module — an un-restored mock.module leaks into every test file that runs after this one.",
        },
      ],
    },
  },
);
