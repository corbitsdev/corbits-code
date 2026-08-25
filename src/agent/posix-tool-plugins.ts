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
import {
  resultTruncationPlugin,
  type SpillBlobWriter,
} from "../plugins/result-truncation-plugin.js";
import { toolResultSecretScrubPlugin } from "../plugins/tool-result-secret-scrub-plugin.js";
import { shellGuardPlugin, type ShellTimeoutConfig } from "../plugins/shell-guard-plugin.js";
import {
  readFileGuardPlugin,
  type ReadFileGuardPluginOptions,
} from "../plugins/read-file-guard-plugin.js";
import type { PermissionGate } from "../permission/gate.js";
import { createWorktreeRootsProvider } from "../permission/worktree-roots.js";

export interface CorePosixToolPluginsArgs {
  cwd: string;
  permissionGate: PermissionGate;
  shellTimeout?: ShellTimeoutConfig;
  extraToolPlugins?: ToolPlugin[];
  readFileGuard?: ReadFileGuardPluginOptions;
  // Session blob-store writer oversized tool results spill their full content
  // into. See result-truncation-plugin.ts.
  getBlobWriter?: () => SpillBlobWriter | undefined;
  // Absolute session context dir for the truncation notice's on-disk path.
  getContextDir?: () => string | undefined;
  // Per-project settings.env, merged into the run_shell spawn environment.
  shellEnv?: Record<string, string>;
}

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
// sizeCapTransform for the same reasoning upstream.
//
// Truncation must run outermost, ahead of (i.e. after "seeing the result of")
// the scrub — meaning the scrub sits closer to the base handler, at index 1,
// so it runs on the FULL, untruncated content and truncation only trims what
// the scrub already produced. The reverse order is exploitable: a secret
// straddling the character-cap boundary gets cut mid-pattern (e.g.
// `AKIA[0-9A-Z]{16}` losing its tail), the scrub's regex no longer matches
// the fragment, and a bare, unredacted piece of the credential reaches the
// model with no redaction marker. Scrub-then-truncate is always safe, since
// truncating already-redacted text loses nothing sensitive.
export function buildCorePosixToolPlugins(args: CorePosixToolPluginsArgs): ToolPlugin[] {
  const {
    cwd,
    permissionGate,
    shellTimeout,
    extraToolPlugins = [],
    readFileGuard = {},
    getBlobWriter,
    getContextDir,
    shellEnv,
  } = args;
  // Pre-gate sandboxes honor yolo mode so outside-workspace path tools and shell
  // cwd are not hard-denied after the gate already auto-allows. Pass a live
  // getter so `/yolo` mid-session unlocks (or re-enforces) bounds without
  // rebuilding the plugin stack. Secret-guard and authz still hard-deny
  // regardless.
  const allowOutside = (): boolean => permissionGate.getSkipPermissions();
  const truncationOptions =
    getBlobWriter !== undefined || getContextDir !== undefined
      ? {
          ...(getBlobWriter !== undefined ? { getBlobWriter } : {}),
          ...(getContextDir !== undefined ? { getContextDir } : {}),
        }
      : {};
  return [
    resultTruncationPlugin(truncationOptions),
    toolResultSecretScrubPlugin(),
    pathEscapePlugin(cwd, createWorktreeRootsProvider(cwd), { allowOutside }),
    deleteFilePlugin(cwd, { allowOutside }),
    toolOutputUriPlugin(),
    secretGuardPlugin(),
    authzPlugin(),
    permissionPlugin(permissionGate),
    shellGuardPlugin(cwd, shellTimeout, shellEnv, { allowOutsideCwd: allowOutside }),
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
