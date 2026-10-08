import type { ToolPlugin } from "@intx/tools-posix";
import { createLSPPlugin } from "@intx/tools-lsp";
import { pathEscapePlugin } from "../plugins/path-escape-plugin.js";
import { evidenceArchivePathGuardPlugin } from "../plugins/evidence-archive-path-guard.js";
import { evidenceArchiveSearchPlugin } from "../plugins/evidence-archive-search-plugin.js";
import { deleteFilePlugin } from "../plugins/delete-file-plugin.js";
import { secretGuardPlugin } from "../plugins/secret-guard-plugin.js";
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
import {
  shellGuardPlugin,
  type ShellTimeoutConfig,
} from "../plugins/shell-guard-plugin.js";
import type { BackgroundShellRegistry } from "../shell/background-shell.js";
import {
  readFileGuardPlugin,
  type ReadFileGuardPluginOptions,
} from "../plugins/read-file-guard-plugin.js";
import type { PermissionGate } from "../permission/gate.js";
import { createWorktreeRootsProvider } from "../permission/worktree-roots.js";
import type { CompactionArchive } from "../session/compaction-archive.js";
import type { ShellOutputFeedMap } from "../session/shell-output-feed.js";

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
  // Live getter for the background-shell registry (run_shell background:true).
  // Omitted makes background runs fail closed in shell-guard.
  getBackgroundShellRegistry?: () => BackgroundShellRegistry | undefined;
  // Live getter for the per-call bounded shell-output feeds the transcript
  // polls for a running command's live tail. Omitted leaves the tail unwired.
  getShellOutputFeeds?: () => ShellOutputFeedMap | undefined;
  /** Primary-only evidence archive; workers omit this getter. */
  getEvidenceArchive?: () => CompactionArchive | undefined;
  /**
   * Runtime secret-guard denylist for the active --config path. Entry points
   * pass [config.globalSettingsPath]; workers inherit their parent's list.
   * Omitted (tests, ad-hoc stacks) keeps the static denylist only.
   */
  secretGuardExtraDeniedPaths?: readonly string[];
}

// Middleware order matches docs/ARCHITECTURE.md: path escape through
// truncation, shell-guard after permission so blocked commands never spawn.
//
// The secret scrub and the char cap are prepended unconditionally, ahead of
// every other plugin: composeMiddleware wraps outer-to-inner, so a plugin
// earlier in the array still sees the final result even when a later plugin
// (ripgrepPlugin notably) answers without calling next(). A mandatory
// terminal concern cannot depend on every middleware author remembering
// next() — see vendor/intx-inference/src/assembly.ts's sizeCapTransform.
//
// Truncation must run outermost, so the scrub (index 1, closest to the base
// handler) runs on the FULL content and truncation only trims what the scrub
// produced. The reverse order is exploitable: a secret straddling the cap
// boundary gets cut mid-pattern, the scrub regex no longer matches the
// fragment, and a bare credential piece reaches the model. Scrub-then-truncate
// loses nothing sensitive.
export function buildCorePosixToolPlugins(
  args: CorePosixToolPluginsArgs,
): ToolPlugin[] {
  const {
    cwd,
    permissionGate,
    shellTimeout,
    extraToolPlugins = [],
    readFileGuard = {},
    getBlobWriter,
    getContextDir,
    shellEnv,
    getBackgroundShellRegistry,
    getShellOutputFeeds,
    getEvidenceArchive,
    secretGuardExtraDeniedPaths,
  } = args;
  // Pre-gate sandboxes honor yolo mode so outside-workspace paths and shell
  // cwd are not hard-denied after the gate auto-allows. Live getter so
  // `/yolo` mid-session re-bounds without rebuilding the stack; secret-guard
  // and the catastrophic-shell check still hard-deny.
  const allowOutside = (): boolean => permissionGate.getSkipPermissions();
  // One shared workspace-roots provider so pathEscape and delete_file admit
  // the same registered sibling worktrees.
  const rootsProvider = createWorktreeRootsProvider(cwd);
  // The gate's shell legs must treat extras-denied paths as sensitive like
  // the secret-guard plugin does. The gate is shared across stacks, so
  // forward the list here rather than wiring each runner separately.
  if (secretGuardExtraDeniedPaths !== undefined) {
    permissionGate.setSensitiveExtraDeniedPaths?.(secretGuardExtraDeniedPaths);
  }
  const truncationOptions =
    getBlobWriter !== undefined ||
    getContextDir !== undefined ||
    getEvidenceArchive !== undefined
      ? {
          ...(getBlobWriter !== undefined ? { getBlobWriter } : {}),
          ...(getContextDir !== undefined ? { getContextDir } : {}),
          ...(getEvidenceArchive !== undefined ? { getEvidenceArchive } : {}),
        }
      : {};
  return [
    resultTruncationPlugin(truncationOptions),
    toolResultSecretScrubPlugin(),
    pathEscapePlugin(cwd, rootsProvider, {
      allowOutside,
      trustedPluginRoots: () => [...permissionGate.getTrustedPluginRoots()],
    }),
    evidenceArchivePathGuardPlugin(),
    deleteFilePlugin(cwd, { allowOutside, rootsProvider }),
    toolOutputUriPlugin(),
    secretGuardPlugin(
      secretGuardExtraDeniedPaths !== undefined
        ? { extraDeniedPaths: secretGuardExtraDeniedPaths }
        : undefined,
    ),
    permissionPlugin(permissionGate),
    shellGuardPlugin(cwd, shellTimeout, shellEnv, {
      allowOutsideCwd: allowOutside,
      ...(getBackgroundShellRegistry !== undefined
        ? { getBackgroundShellRegistry }
        : {}),
      ...(getShellOutputFeeds !== undefined ? { getShellOutputFeeds } : {}),
    }),
    ...(getEvidenceArchive !== undefined
      ? [evidenceArchiveSearchPlugin(getEvidenceArchive)]
      : []),
    readFileGuardPlugin(cwd, readFileGuard),
    ripgrepPlugin(cwd, {}, undefined, secretGuardExtraDeniedPaths ?? []),
    // Verify wraps the line-range short-circuit so its before/after check
    // also covers start_line/end_line edits.
    verifyPlugin(),
    editFileLineRangePlugin(),
    // Outside verify: enrich stock substring mismatch errors (composeMiddleware
    // runs last→first).
    editFileDiagnosticsPlugin(),
    lspHintPlugin(),
    createLSPPlugin({ cwd, minSeverity: 1 }),
    ...extraToolPlugins,
  ];
}
