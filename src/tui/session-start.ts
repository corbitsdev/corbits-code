// TUI session start: everything runTUI does before its main try block.
//
// Returns plain fields the caller re-binds (config, sessionId, workdir…);
// crash-only state stays behind TUICrashGuard.

import { getLogger } from "@intx/log";

import { COMMAND_NAME, LOG_NAMESPACE_ROOT } from "../branding.js";
import type { Config } from "../config/index.js";
import type { Telemetry } from "../telemetry/index.js";
import { clearActiveDisposeHost } from "../session/active-host.js";
import {
  clearActiveRun,
  getActiveRun,
  setActiveRun,
  type RunStateHandle,
} from "../session/active-run.js";
import { initSessionDir, sessionContextDir } from "../session/index.js";
import {
  finalizeRunState,
  loadState,
  saveState,
  type ConnectedMcpServer,
  type RunState,
} from "../session/state.js";
import {
  createPluginLoadDiagnostics,
  type PluginLoadDiagnostics,
} from "../plugins/diagnostics.js";
import { expandSkipDiagnosticsHandler } from "../plugins/loader.js";
import {
  assembleInferenceBase,
  assembleSessionTrust,
  type SessionTrust,
} from "../session/assemble-runtime.js";
import { pickSession } from "./pick-session.js";

const sessionStartLogger = getLogger([LOG_NAMESPACE_ROOT, "tui"]);

export interface ResumeSeed {
  turnsUsed: number;
  mcpServers: ConnectedMcpServer[];
  // tool_search-promoted tool names from the prior run, re-activated before
  // the first post-resume inference so the wire matches the transcript.
  activatedTools: string[];
  // Only when the prior run stamped an Anthropic-protocol cache write.
  lastCacheWriteAt?: number;
  cacheWriteModel?: string;
  // The prior run's provider:model, split for restore; absent on fresh runs
  // and legacy records that predate the model field.
  storedModel?: { providerName: string; model: string };
}

const FRESH_RESUME_SEED: ResumeSeed = {
  turnsUsed: 0,
  mcpServers: [],
  activatedTools: [],
};

/**
 * Split run.json `provider:model` on the first colon so colons inside model
 * ids survive. Absent or malformed values yield undefined; never throws.
 */
function splitStoredModel(
  value: string | undefined,
): { providerName: string; model: string } | undefined {
  if (value === undefined) return undefined;
  const colon = value.indexOf(":");
  if (colon <= 0 || colon === value.length - 1) return undefined;
  return {
    providerName: value.slice(0, colon),
    model: value.slice(colon + 1),
  };
}

/**
 * Fold run.json into one concrete seed at the resume boundary so downstream
 * readers (run sink, connected servers, post-resume saveState) get a fully
 * populated value instead of repeating their own `?? 0` / `?? []` defaults.
 * Fresh runs use FRESH_RESUME_SEED, so callers never branch on resume.
 */
export function resolveResumeSeed(pickedState: RunState | null): ResumeSeed {
  if (pickedState === null) return FRESH_RESUME_SEED;
  const storedModel = splitStoredModel(pickedState.model);
  return {
    turnsUsed: pickedState.turnsUsed,
    mcpServers: pickedState.mcpServers ?? [],
    activatedTools: pickedState.activatedTools ?? [],
    ...(storedModel !== undefined ? { storedModel } : {}),
    ...(pickedState.lastCacheWriteAt !== undefined
      ? {
          lastCacheWriteAt: pickedState.lastCacheWriteAt,
          ...(pickedState.model !== undefined
            ? { cacheWriteModel: pickedState.model }
            : {}),
        }
      : {}),
  };
}

export interface TUILiveSession {
  cwd: string;
  sessionId: string;
  startedAt: number;
  runTaskTitle: string;
  providerName: string;
  model: string;
}

export interface TUICrashGuard {
  isFinalized: () => boolean;
  markFinalized: () => void;
  setPartialFlush: (flush: () => Promise<void>) => void;
  invokeDisposeHost: () => void | Promise<void>;
  setDisposeHost: (dispose: () => void | Promise<void>) => void;
  bindLiveSession: (get: () => TUILiveSession) => void;
  finalizeOnCrash: (err: unknown) => Promise<void>;
}

/**
 * Crash-only session identity. Starts on the prepare-time getter until
 * runTUI binds the live loop lets.
 */
export function createTUICrashGuard(
  getLiveSession: () => TUILiveSession,
): TUICrashGuard {
  let finalized = false;
  // Bound after the cycle recorder exists (needs the session workdir);
  // declared first so it covers every fallible step below.
  let flushPartialOnCrash: () => Promise<void> = async () => undefined;
  // Bound once the host is mounted; otherwise a crash leaves the alternate
  // screen, mouse reporting and raw mode on and the terminal wedged.
  let disposeHost: () => void | Promise<void> = () => undefined;
  let getSession = getLiveSession;

  const finalizeOnCrash = async (err: unknown): Promise<void> => {
    if (finalized) return;
    finalized = true;
    // Clear the active-run handle up front: index.ts's own uncaughtException /
    // unhandledRejection listeners call getActiveRun() and would write a
    // competing "crashed" record if a throw escapes the awaits below.
    const turnsUsed = getActiveRun()?.turnsUsed ?? 0;
    const activatedTools = getActiveRun()?.activatedTools;
    const lastCacheWriteAt = getActiveRun()?.lastCacheWriteAt;
    clearActiveRun();
    clearActiveDisposeHost();
    await flushPartialOnCrash().catch((flushErr: unknown) => {
      // Best-effort only, saveState still runs below; log so a flush failure
      // is visible when diagnosing a crash exit.
      const flushMessage =
        flushErr instanceof Error ? flushErr.message : String(flushErr);
      sessionStartLogger.warn("crash finalize: partial flush failed: {error}", {
        error: flushMessage,
      });
      process.stderr.write(
        `${COMMAND_NAME}: crash finalize partial flush failed: ${flushMessage}\n`,
      );
    });
    const live = getSession();
    const message = err instanceof Error ? err.message : String(err);
    await finalizeRunState(live.cwd, live.sessionId, {
      status: "failed",
      turnsUsed,
      task:
        live.runTaskTitle.trim().length > 0
          ? live.runTaskTitle.trim()
          : "(conversation)",
      startedAt: live.startedAt,
      finishedAt: Date.now(),
      error: message,
      model: `${live.providerName}:${live.model}`,
      mcpServers: [],
      ...(activatedTools !== undefined ? { activatedTools } : {}),
      ...(lastCacheWriteAt !== undefined ? { lastCacheWriteAt } : {}),
    }).catch((saveErr: unknown) => {
      const saveMessage =
        saveErr instanceof Error ? saveErr.message : String(saveErr);
      sessionStartLogger.warn(
        "crash finalize: saveState failed for session {sessionId}: {error}",
        {
          sessionId: live.sessionId,
          error: saveMessage,
        },
      );
      process.stderr.write(
        `${COMMAND_NAME}: crash finalize saveState failed for ${live.sessionId}: ${saveMessage}\n`,
      );
    });
  };

  return {
    isFinalized: () => finalized,
    markFinalized: () => {
      finalized = true;
    },
    setPartialFlush: (flush) => {
      flushPartialOnCrash = flush;
    },
    invokeDisposeHost: () => disposeHost(),
    setDisposeHost: (dispose) => {
      disposeHost = dispose;
    },
    bindLiveSession: (get) => {
      getSession = get;
    },
    finalizeOnCrash,
  };
}

export interface PreparedTUISession {
  config: Config;
  inferenceDeps: Awaited<ReturnType<typeof assembleInferenceBase>>;
  trust: SessionTrust;
  pluginLoadDiag: PluginLoadDiagnostics;
  sessionId: string;
  resumeSkipInitialTask: boolean;
  startedAt: number;
  runTaskTitle: string;
  resumeSeed: ResumeSeed;
  workdir: string;
  activeRunHandle: RunStateHandle;
  crashGuard: TUICrashGuard;
}

/**
 * Boot the session runTUI will drive: inference base, plugin trust +
 * discovery, resume pick, context dir, minimal run.json, active-run handle,
 * and the crash guard covering setup. Returns null when the resume picker
 * is dismissed (no session started).
 */
export async function prepareTUISession(
  initialConfig: Config,
  telemetry: Telemetry,
): Promise<PreparedTUISession | null> {
  let config = initialConfig;
  // loadConfig already bootstrapped pricing metadata; re-read here so a
  // TUI-only entry (tests) still picks up the tool-home cache path.
  const inferenceDeps = await assembleInferenceBase();

  // Auto-discover plugins (repo plugins/, user dirs, /plugins UI paths);
  // untrusted origins load metadata-only (no import). Claude marketplace
  // installs are opt-in via settings.discoverClaudePlugins. The diagnostics
  // batch is declared first so a skipped marketplace member (bad pluginPaths
  // entry) collects into the same summary as discovery instead of defaulting
  // to stderr — `onSkip` on expandExistingPluginMembers is required so this
  // can't be forgotten at a call site.
  const pluginLoadDiag = createPluginLoadDiagnostics();
  // One-shot: seed global path trust from pluginPaths only when the store file
  // does not exist yet (legacy per-cwd grants). Later boots load the store as-is.
  const trust = await assembleSessionTrust({
    cwd: config.cwd,
    pluginPaths: config.settings?.pluginPaths,
    discoverClaudePlugins: config.settings?.discoverClaudePlugins,
    onExpandSkip: expandSkipDiagnosticsHandler(pluginLoadDiag),
    diagnostics: pluginLoadDiag,
    telemetry,
  });

  let sessionId = config.sessionId;
  let resumeSkipInitialTask = config.skipInitialTask === true;
  let startedAt = Date.now();
  let runTaskTitle = config.task;
  // Resolved once at the resume boundary so downstream reads of
  // turnsUsed/mcpServers never repeat omission defaults.
  let resumeSeed: ResumeSeed = FRESH_RESUME_SEED;

  if (config.resumePicker) {
    const picked = await pickSession(config.cwd);
    if (picked === null) return null;
    sessionId = picked.sessionId;
    resumeSkipInitialTask = true;
    const loaded = await loadState(config.cwd, sessionId);
    const pickedState = loaded.kind === "ok" ? loaded.state : null;
    resumeSeed = resolveResumeSeed(pickedState);
    if (pickedState !== null) {
      startedAt = pickedState.startedAt;
      runTaskTitle = pickedState.task;
    } else {
      runTaskTitle = picked.task.length > 0 ? picked.task : runTaskTitle;
    }
    config =
      pickedState !== null
        ? { ...config, sessionId, task: pickedState.task }
        : { ...config, sessionId, task: runTaskTitle };
  } else if (config.resumeMode === "id") {
    // `resume <id>` never read run.json — load it here so turnsUsed,
    // mcpServers, and activatedTools carry forward. runTaskTitle stays
    // config.task (the CLI folded the prior task into it when no new task
    // text was given).
    const loaded = await loadState(config.cwd, sessionId);
    const pickedState = loaded.kind === "ok" ? loaded.state : null;
    resumeSeed = resolveResumeSeed(pickedState);
    if (pickedState !== null) {
      startedAt = pickedState.startedAt;
    }
  }

  // A resume without explicit --provider/--model keeps the stored session's
  // model; the launch default would otherwise clobber it on both resume
  // branches above. The restore is gated on config.modelOverride (the
  // parse-time signal), so an explicit flag wins. Fresh runs and legacy
  // model-less records carry no storedModel.
  if (config.modelOverride !== true && resumeSeed.storedModel !== undefined) {
    config = {
      ...config,
      providerName: resumeSeed.storedModel.providerName,
      model: resumeSeed.storedModel.model,
    };
  }

  const workdir = sessionContextDir(config.cwd, sessionId);
  await initSessionDir(config.cwd, sessionId);

  // Setup below (buildAgent, plugin discovery, MCP wiring) can still crash
  // before the reactor starts. Write a minimal run.json now so a session that
  // dies before its first turn still carries model identity instead of
  // leaving `.agent-state/<id>/` with no record.
  await saveState(config.cwd, sessionId, {
    status: "running",
    turnsUsed: resumeSeed.turnsUsed,
    task:
      runTaskTitle.trim().length > 0 ? runTaskTitle.trim() : "(conversation)",
    startedAt,
    model: `${config.providerName}:${config.model}`,
    mcpServers: resumeSeed.mcpServers,
    activatedTools: resumeSeed.activatedTools,
    ...(resumeSeed.lastCacheWriteAt !== undefined
      ? { lastCacheWriteAt: resumeSeed.lastCacheWriteAt }
      : {}),
  });

  // Registered the moment a run starts so index.ts's top-level
  // uncaughtException / unhandledRejection handler can finalize run.json for
  // crashes that escape the caller's try/catch (e.g. a throw inside a
  // fire-and-forget `void` call). Cleared wherever the guard below flips
  // finalized — those paths already write a terminal run.json.
  const activeRunHandle: RunStateHandle = {
    sessionId,
    cwd: config.cwd,
    task:
      runTaskTitle.trim().length > 0 ? runTaskTitle.trim() : "(conversation)",
    startedAt,
    turnsUsed: resumeSeed.turnsUsed,
    model: `${config.providerName}:${config.model}`,
    activatedTools: resumeSeed.activatedTools,
    ...(resumeSeed.lastCacheWriteAt !== undefined
      ? { lastCacheWriteAt: resumeSeed.lastCacheWriteAt }
      : {}),
    ...(resumeSeed.cacheWriteModel !== undefined
      ? { cacheWriteModel: resumeSeed.cacheWriteModel }
      : {}),
  };
  setActiveRun(activeRunHandle);

  // Crash guard: if setup onward throws all the way out of runTUI, this still
  // closes run.json so status and finishedAt never disagree. The normal
  // finalize path marks finalized, so this never double-writes on a clean
  // exit. The flag also gates persistRunSnapshot from issuing a stale
  // "running" write once the run is closed — separate from saveState's write
  // ordering in state.ts, which only decides which already-issued write
  // lands last.
  //
  // Defaults to these prepare-time lets until runTUI binds the live loop
  // identity (sessionId / model rotate on /clear and /model).
  const crashGuard = createTUICrashGuard(() => ({
    cwd: config.cwd,
    sessionId,
    startedAt,
    runTaskTitle,
    providerName: config.providerName,
    model: config.model,
  }));

  return {
    config,
    inferenceDeps,
    trust,
    pluginLoadDiag,
    sessionId,
    resumeSkipInitialTask,
    startedAt,
    runTaskTitle,
    resumeSeed,
    workdir,
    activeRunHandle,
    crashGuard,
  };
}
