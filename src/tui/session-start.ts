// TUI session start: everything runTUI does before its main try block.
//
// A named function with explicit inputs and outputs, replacing the pre-try
// closure scope (config reassignment, trust stores, session pick, workdir,
// crash guard) that runTUI used to carry as two dozen `let` bindings. The
// live session values the loop later reassigns (config, sessionId, workdir…)
// return as plain fields the caller re-binds; the crash-only state stays
// behind the TUICrashGuard interface.

import { getLogger } from "@intx/log";

import { COMMAND_NAME, LOG_NAMESPACE_ROOT } from "../branding.js";
import type { Config } from "../config/index.js";
import type { Telemetry } from "../telemetry/index.js";
import { clearActiveDisposeHost } from "../session/active-host.js";
import { clearActiveRun, setActiveRun, type RunStateHandle } from "../session/active-run.js";
import { initSessionDir, sessionContextDir } from "../session/index.js";
import {
  finalizeRunState,
  loadState,
  saveState,
  type ConnectedMcpServer,
  type RunState,
} from "../session/state.js";
import { createPluginLoadDiagnostics, type PluginLoadDiagnostics } from "../plugins/diagnostics.js";
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
}

const FRESH_RESUME_SEED: ResumeSeed = { turnsUsed: 0, mcpServers: [] };

/**
 * Fold a resumed session's run.json into a concrete seed once, at the
 * resume boundary, so every downstream reader (the run sink, the
 * connected-servers list, the immediate post-resume saveState) trusts a
 * fully-populated value instead of each repeating its own `?? 0` / `?? []`
 * default. A fresh (non-resumed) run gets the same shape via
 * FRESH_RESUME_SEED, so callers never branch on "was this a resume."
 */
export function resolveResumeSeed(pickedState: RunState | null): ResumeSeed {
  if (pickedState === null) return FRESH_RESUME_SEED;
  return {
    turnsUsed: pickedState.turnsUsed,
    mcpServers: pickedState.mcpServers ?? [],
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
  invokeDisposeHost: () => void;
  setDisposeHost: (dispose: () => void) => void;
  bindLiveSession: (get: () => TUILiveSession) => void;
  finalizeOnCrash: (err: unknown) => Promise<void>;
}

/**
 * Crash-only session identity. Defaults to the getter passed at construction
 * (prepare-time lets) until runTUI binds the live loop lets.
 */
export function createTUICrashGuard(getLiveSession: () => TUILiveSession): TUICrashGuard {
  let finalized = false;
  // Bound after the cycle recorder exists (it needs the session workdir); the
  // crash guard is declared first so it covers every fallible step below.
  let flushPartialOnCrash: () => Promise<void> = async () => {};
  // Bound once the host is mounted. Without this the crash path leaves the
  // renderer alive, so the alternate screen, mouse reporting and raw mode are
  // never disabled and the operator's terminal is left wedged.
  let disposeHost: () => void = () => {};
  let getSession = getLiveSession;

  const finalizeOnCrash = async (err: unknown): Promise<void> => {
    if (finalized) return;
    finalized = true;
    // Clear the active-run handle up front, before the awaits below. This
    // handler isn't the only reader of the handle: index.ts installs its own
    // uncaughtException/unhandledRejection listeners that call getActiveRun()
    // directly and, if it's still set, write a competing "crashed" record via
    // saveCrashState. finalizeRunState (state.ts) also clears the handle
    // before its own saveState await, but only once it's called below — an
    // escaped throw during the flushPartialOnCrash await just above would
    // still reach that listener with the handle live, so it's cleared here
    // too to close that earlier window.
    clearActiveRun();
    clearActiveDisposeHost();
    await flushPartialOnCrash().catch((flushErr: unknown) => {
      // Best-effort only — still attempt saveState below. Log so a flush
      // failure is not invisible when diagnosing a crash exit.
      const flushMessage = flushErr instanceof Error ? flushErr.message : String(flushErr);
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
      turnsUsed: 0,
      task: live.runTaskTitle.trim().length > 0 ? live.runTaskTitle.trim() : "(conversation)",
      startedAt: live.startedAt,
      finishedAt: Date.now(),
      error: message,
      model: `${live.providerName}:${live.model}`,
      mcpServers: [],
    }).catch((saveErr: unknown) => {
      const saveMessage = saveErr instanceof Error ? saveErr.message : String(saveErr);
      sessionStartLogger.warn("crash finalize: saveState failed for session {sessionId}: {error}", {
        sessionId: live.sessionId,
        error: saveMessage,
      });
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
    invokeDisposeHost: () => {
      disposeHost();
    },
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
 * is dismissed — no session started, nothing to clean up.
 */
export async function prepareTUISession(
  initialConfig: Config,
  telemetry: Telemetry,
): Promise<PreparedTUISession | null> {
  let config = initialConfig;
  // loadConfig already bootstrapped pricing metadata; re-read cache here so a
  // TUI-only entry (tests) still picks up the tool-home cache path.
  const inferenceDeps = await assembleInferenceBase();

  // Auto-discover plugins from the repo's plugins/ directory and user plugin
  // dirs, plus any explicit paths registered through the /plugins UI.
  // Project origins without a project-trust entry, and path origins without a
  // global path-trust entry, load metadata-only (no import).
  // Claude Code marketplace installs are opt-in via settings.discoverClaudePlugins.
  // The diagnostics batch is declared before the assembly call below so a
  // skipped marketplace member (bad pluginPaths entry) collects into the same
  // summary as discovery, rather than defaulting to stderr — `onSkip` on
  // expandExistingPluginMembers is required precisely so this can't be
  // forgotten at a call site.
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
  // Resolved once at the resume boundary so turnsUsed/mcpServers reads
  // downstream never repeat their own omission-handling default.
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
  }

  const workdir = sessionContextDir(config.cwd, sessionId);
  await initSessionDir(config.cwd, sessionId);

  // A session can still crash during the setup below, before the reactor ever
  // starts (buildAgent, plugin discovery, MCP wiring, etc. all run first). Write
  // a minimal readable record now so a session that dies before its first turn
  // still carries model identity instead of leaving `.agent-state/<id>/` with no
  // run.json at all.
  await saveState(config.cwd, sessionId, {
    status: "running",
    turnsUsed: resumeSeed.turnsUsed,
    task: runTaskTitle.trim().length > 0 ? runTaskTitle.trim() : "(conversation)",
    startedAt,
    model: `${config.providerName}:${config.model}`,
    mcpServers: resumeSeed.mcpServers,
  });

  // Registered the moment a run starts so the top-level uncaughtException /
  // unhandledRejection handler in index.ts (which cannot see any local state
  // in the caller) can finalize run.json for crashes that escape without
  // ever reaching the caller's own try/catch — e.g. a throw inside a
  // fire-and-forget `void` call. Cleared wherever the guard below flips
  // finalized, since those paths already write a terminal run.json themselves.
  const activeRunHandle: RunStateHandle = {
    sessionId,
    cwd: config.cwd,
    task: runTaskTitle.trim().length > 0 ? runTaskTitle.trim() : "(conversation)",
    startedAt,
    model: `${config.providerName}:${config.model}`,
  };
  setActiveRun(activeRunHandle);

  // Crash guard: if anything from setup onward throws all the way out of
  // runTUI instead of reaching the normal finalize block, this still closes
  // out run.json so status and finishedAt never disagree. The normal finalize
  // path marks finalized so this never double-writes on a clean exit. The
  // flag also gates persistRunSnapshot from *issuing* a straggler write at
  // all once the run is closed — a different job from saveState's per-session
  // write ordering in state.ts. That ordering only decides which
  // already-issued write lands last; it has no way to know a "running"
  // snapshot fired after finalize is stale and should never be written in
  // the first place. Without this flag such a snapshot would still queue
  // behind the terminal write and legitimately "win" the ordering,
  // resurrecting a closed run.json. Two different constraints (don't issue a
  // stale write vs. order the writes you do issue), each owned by its own
  // layer — not a duplicate check.
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
