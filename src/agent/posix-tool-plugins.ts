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
import { readFileGuardPlugin } from "../plugins/read-file-guard-plugin.js";
import { webToolsPlugin } from "../web/plugin.js";
import type { WebProvider } from "../web/types.js";
import type { PermissionGate } from "../permission/gate.js";

export type CorePosixToolPluginsArgs = {
  cwd: string;
  permissionGate: PermissionGate;
  webProvider?: WebProvider;
  shellTimeout?: ShellTimeoutConfig;
  extraToolPlugins?: ToolPlugin[];
};

// Middleware order matches docs/ARCHITECTURE.md: path escape through truncation,
// with shell-guard after permission so blocked commands never spawn. Secret-shaped
// result scrub runs immediately before truncation so credentials are redacted first.
export function buildCorePosixToolPlugins(args: CorePosixToolPluginsArgs): ToolPlugin[] {
  const { cwd, permissionGate, webProvider, shellTimeout, extraToolPlugins = [] } = args;
  return [
    pathEscapePlugin(cwd),
    deleteFilePlugin(cwd),
    toolOutputUriPlugin(),
    secretGuardPlugin(),
    authzPlugin(),
    permissionPlugin(permissionGate),
    shellGuardPlugin(cwd, shellTimeout),
    readFileGuardPlugin(cwd),
    ripgrepPlugin(cwd),
    // Line-range short-circuit sits inside verify (before stock edit_file).
    editFileLineRangePlugin(),
    verifyPlugin(),
    // Outside verify: enrich stock substring mismatch errors (composeMiddleware last→first).
    editFileDiagnosticsPlugin(),
    webToolsPlugin(webProvider !== undefined ? { provider: webProvider } : {}),
    lspHintPlugin(),
    createLSPPlugin({ cwd, minSeverity: 1 }),
    toolResultSecretScrubPlugin(),
    resultTruncationPlugin(),
    ...extraToolPlugins,
  ];
}