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
  {
    // CL-6791 ratchet: src/tui files have per-file line budgets enforced by
    // `bun run check:tui-budget` (scripts/guard-tui-file-budget.ts). A barrel
    // `export *` makes module size invisible to importers and lets a split
    // quietly regress into a god-file; export named symbols instead.
    files: ["src/tui/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExportAllDeclaration",
          message:
            "export * is banned under src/tui — files have line budgets enforced by `bun run check:tui-budget` (scripts/budgets.json); export named symbols instead.",
        },
      ],
    },
  },
  {
    // CL-6791 phase 2: src/tui/shell.ts was split into src/tui/shell/* along a
    // strict dependency gradient (internals -> geometry/layout -> transcript
    // builders -> chrome paint pipeline -> overlay host/list -> prompt ->
    // palette -> observe/copy -> keys -> index). The shell may use layer-0
    // TUI primitives and its own siblings; it must never reach the host
    // surfaces that consume it — those import the shell, not the reverse.
    files: ["src/tui/shell/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "^\\.\\./(provider|runner|product-host|overlays|command-surfaces|gate-wire|model-catalog|list-modal)(/[^/]+)*(\\.js)?$",
              message:
                "src/tui/shell/** must not import host surfaces (provider, runner, product-host, overlays, command-surfaces, gate-wire, model-catalog, list-modal) — those own the shell, never the reverse. Depend on siblings in shell/* or layer-0 TUI modules instead.",
            },
          ],
        },
      ],
    },
  },
);
