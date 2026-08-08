import type { ToolPlugin } from "@intx/tools-posix";
import { createLSPPlugin } from "@intx/tools-lsp";
import { pathEscapePlugin } from "../plugins/path-escape-plugin.js";
import { deleteFilePlugin } from "../plugins/delete-file-plugin.js";
import { secretGuardPlugin } from "../plugins/secret-guard-plugin.js";
import { authzPlugin } from "../plugins/authz-plugin.js";
import { permissionPlugin } from "../plugins/permission-plugin.js";
import { verifyPlugin } from "../plugins/verify-plugin.js";
import { editFileDiagnosticsPlugin } from "../plugins/edit-file-diagnostics-plugin.js";
import { editFileLineRangePlugin } from "../plugins/edit-file-line-range-plugin.js";
import { ripgrepPlugin } from "../plugins/ripgrep-plugin.js";
import { toolOutputUriPlugin } from "../plugins/tool-output-uri-plugin.js";
import { lspHintPlugin } from "../plugins/lsp-hint-plugin.js";
import { resultTruncationPlugin } from "../plugins/result-truncation-plugin.js";
import { toolResultSecretScrubPlugin } from "../plugins/tool-result-secret-scrub-plugin.js";
import {
  shellGuardPlugin,
  type ShellTimeoutConfig,
} from "../plugins/shell-guard-plugin.js";
import {
  readFileGuardPlugin,
  type ReadFileGuardPluginOptions,
} from "../plugins/read-file-guard-plugin.js";
import type { PermissionGate } from "../permission/gate.js";
import { createWorktreeRootsProvider } from "../permission/worktree-roots.js";

export type CorePosixToolPluginsArgs = {
  cwd: string;
  permissionGate: PermissionGate;
  shellTimeout?: ShellTimeoutConfig;
  extraToolPlugins?: ToolPlugin[];
  readFileGuard?: ReadFileGuardPluginOptions;
  // Per-project settings.env, merged into the run_shell spawn environment.
  shellEnv?: Record<string, string>;
};

// Middleware order matches docs/ARCHITECTURE.md: path escape through truncation,
// with shell-guard after permission so blocked commands never spawn.
//
// The secret scrub and the character cap are prepended unconditionally, ahead
// of every other plugin, rather than left in call order. composeMiddleware
// wraps outer-to-inner in array order, so a plugin earlier in this array
// still observes the final result even when a later plugin (ripgrepPlugin,
// notably) answers a call directly without invoking its own `next()` and so
// never reaches whatever sits after it. A mandatory terminal concern like
// redacting a credential cannot depend on every middleware author remembering
// to call `next()` — see vendor/intx-inference/src/assembly.ts's
// sizeCapTransform for the same reasoning upstream. Scrub sits outermost so it
// runs on the already-capped content, matching the previous in-chain order.
export function buildCorePosixToolPlugins(args: CorePosixToolPluginsArgs): ToolPlugin[] {
  const {
    cwd,
    permissionGate,
    shellTimeout,
    extraToolPlugins = [],
    readFileGuard = {},
    shellEnv,
  } = args;
  return [
    toolResultSecretScrubPlugin(),
    resultTruncationPlugin(),
    pathEscapePlugin(cwd, createWorktreeRootsProvider(cwd)),
    deleteFilePlugin(cwd),
    toolOutputUriPlugin(),
    secretGuardPlugin(),
    authzPlugin(),
    permissionPlugin(permissionGate),
    shellGuardPlugin(cwd, shellTimeout, shellEnv),
    readFileGuardPlugin(cwd, readFileGuard),
    ripgrepPlugin(cwd),
    // Verify wraps the line-range short-circuit (composeMiddleware runs plugins
    // outer-to-inner in array order) so its before/after check still covers
    // start_line/end_line edits instead of only substring-mode edit_file calls.
    verifyPlugin(),
    editFileLineRangePlugin(),
    // Outside verify: enrich stock substring mismatch errors (composeMiddleware last→first).
    editFileDiagnosticsPlugin(),
    lspHintPlugin(),
    createLSPPlugin({ cwd, minSeverity: 1 }),
    ...extraToolPlugins,
  ];
}