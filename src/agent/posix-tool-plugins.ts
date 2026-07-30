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
import type { WebProvider } from "../web/types.js";
import type { PermissionGate } from "../permission/gate.js";
import { createWorktreeRootsProvider } from "../permission/worktrees.js";

export type CorePosixToolPluginsArgs = {
  cwd: string;
  permissionGate: PermissionGate;
  // Kept for signature parity with callers that still resolve a discovered
  // "web"-kind plugin (e.g. sub-agent toolset assembly); no longer consumed
  // here since web_search/web_fetch are now always-on built-ins (see
  // src/tools/web-fetch.ts, src/tools/web-search.ts) rather than plugin-backed.
  webProvider?: WebProvider;
  shellTimeout?: ShellTimeoutConfig;
  extraToolPlugins?: ToolPlugin[];
  readFileGuard?: ReadFileGuardPluginOptions;
  // Per-project settings.env, merged into the run_shell spawn environment.
  shellEnv?: Record<string, string>;
};

// Middleware order matches docs/ARCHITECTURE.md: path escape through truncation,
// with shell-guard after permission so blocked commands never spawn. Secret-shaped
// result scrub runs immediately before truncation so credentials are redacted first.
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
    toolResultSecretScrubPlugin(),
    resultTruncationPlugin(),
    ...extraToolPlugins,
  ];
}