import { writeCrashReport, type CrashKind } from "./crash/report.js";
import { getActiveRun, markCrashed } from "./session/active-run.js";
import { getActiveDisposeHost } from "./session/active-host.js";
import { saveCrashState } from "./session/state.js";
import { classifyErrorClass } from "./telemetry/classify.js";
import { getTelemetry } from "./telemetry/singleton.js";

// Lives in its own module (not src/index.ts, which pulls the whole TUI and
// config graph) so crash/signal fixtures can install the real process-level
// handlers without paying that import cost in every subprocess they spawn.

// Shared by handleFatal and the signal handlers below so a signal arriving
// mid-crash-unwind (or a crash surfacing while a signal is already tearing
// the process down) can't re-enter either path a second time.
let terminating = false;

export const RUNTIME_TEARDOWN_DEADLINE_MS = 2_000;

// Production keeps the default; install options let a test process shorten
// the bound so a deliberately never-settling dispose host doesn't pay the
// full 2s of wall clock per test (same pattern as the tool watchdog's
// salvageGraceMs override).
// Single-setter assumption: this is one process-global read by both
// installCrashHandlers and installSignalHandlers, so the last installer call
// wins. Production never sets it; the only setter is the reap-fixture
// subprocess (tests/fixtures/exec-shutdown-reap/simulate-reap.ts), which sets
// it once per process before installing — never both installers with
// different values in one process.
let teardownDeadlineMs = RUNTIME_TEARDOWN_DEADLINE_MS;

export interface ProcessHandlerOptions {
  /**
   * Override the bounded-teardown deadline for this process. Production never
   * sets it, keeping the 2s default; tests set it short so a never-settling
   * dispose host doesn't pay the full deadline in wall clock.
   */
  teardownDeadlineMs?: number;
}

async function awaitActiveDisposeHost(context: string): Promise<void> {
  const dispose = getActiveDisposeHost();
  if (dispose === null) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(dispose()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(`runtime teardown exceeded ${teardownDeadlineMs}ms`),
          );
        }, teardownDeadlineMs);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
  } catch (disposeErr: unknown) {
    process.stderr.write(
      `host dispose failed ${context}: ${disposeErr instanceof Error ? disposeErr.message : String(disposeErr)}\n`,
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Exported so an integration test can register these process-level handlers
// and inject a crash without spawning the full TUI stack.
export async function handleFatal(
  kind: CrashKind,
  error: unknown,
): Promise<void> {
  if (terminating) return;
  terminating = true;
  // OpenTUI's own uncaughtException/unhandledRejection listener only logs
  // (see installCrashHandlers' comment below) — it never tears down the
  // terminal the way its signal listener does. Without this, a throw that
  // escapes runTUI's own try/catch (e.g. inside a fire-and-forget `void`
  // call) leaves the alternate screen and raw mode stuck. disposeHost is
  // idempotent, so this is safe even if runTUI's own catch block already
  // ran it moments earlier. Start teardown immediately, but flip isCrashed
  // before awaiting so queued snapshot writes still observe the fence.
  const teardown = awaitActiveDisposeHost("during fatal handling");
  markCrashed();
  await teardown;
  process.stderr.write(
    `${kind}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  const file = await writeCrashReport(kind, error);
  if (file !== null) {
    process.stderr.write(`crash report written to ${file}\n`);
  } else {
    process.stderr.write("failed to write crash report\n");
  }
  await finalizeActiveRunOnCrash(error);
  // kind is one of the two process-level handler names. A constructor name is
  // author-chosen — an application or plugin error subclass can be as
  // identifying as any other free text — so only the language's own error
  // types are reported by name.
  getTelemetry().capture("crash", {
    kind,
    error_class: classifyErrorClass(error),
  });
  await getTelemetry().flush();
  process.exit(1);
}

// A crash reaching here escaped without ever hitting runTUI's own try/catch
// (e.g. a throw inside a fire-and-forget `void` call), so run.json was never
// closed out. getActiveRun surfaces the in-flight session set by the in-flight
// runner (TUI or exec), with
// enough (task, startedAt, model, turnsUsed) carried on the handle itself that
// no read of run.json is needed — a readFile here would be exactly the kind of
// unbounded crash-path I/O primeCrashReporting (src/crash/report.ts) exists
// to avoid for git: a stalled disk or network mount would block process.exit
// forever. The write itself goes through saveCrashState, which bypasses the
// per-session write chain in state.ts on purpose — chaining behind a write
// that never settles (possibly the very write that triggered this crash)
// would block process.exit indefinitely, defeating this handler's one job.
async function finalizeActiveRunOnCrash(error: unknown): Promise<void> {
  const run = getActiveRun();
  if (run === null) return;
  const message = error instanceof Error ? error.message : String(error);
  try {
    await saveCrashState(run.cwd, run.sessionId, {
      status: "crashed",
      turnsUsed: run.turnsUsed,
      task: run.task,
      startedAt: run.startedAt,
      finishedAt: Date.now(),
      error: message,
      ...(run.model !== undefined ? { model: run.model } : {}),
      ...(run.activatedTools !== undefined
        ? { activatedTools: run.activatedTools }
        : {}),
    });
  } catch (saveErr: unknown) {
    process.stderr.write(
      `failed to finalize run state after crash: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}\n`,
    );
  }
}

// OpenTUI installs a process-global uncaughtException/unhandledRejection
// handler that only logs (opentui/core's Renderer.handleError), which
// suppresses Bun's default print-and-exit. Combined with raw-mode stdin
// holding the event loop open, an escaped throw would otherwise hang the
// process forever with the terminal still in the alternate screen. Node
// invokes every registered listener for the event regardless of order, so
// these still run and terminate the process even though OpenTUI's own
// listener never exits or rethrows.
export function installCrashHandlers(options?: ProcessHandlerOptions): void {
  if (options?.teardownDeadlineMs !== undefined) {
    teardownDeadlineMs = options.teardownDeadlineMs;
  }
  process.on("uncaughtException", (err) => {
    void handleFatal("uncaughtException", err);
  });
  process.on("unhandledRejection", (reason) => {
    void handleFatal("unhandledRejection", reason);
  });
}

// Mirrors finalizeActiveRunOnCrash but is not itself a crash — a signal is a
// clean, externally-requested termination (operator, shell, orchestrator),
// so the run is left "failed" (interrupted) rather than "crashed", and no
// crash report is written for it. Callers must markCrashed() before this so
// chained saveState renames cannot clobber the terminal write (same contract
// as the uncaughtException path).
async function finalizeActiveRunOnSignal(
  signal: NodeJS.Signals,
): Promise<void> {
  const run = getActiveRun();
  if (run === null) return;
  try {
    await saveCrashState(run.cwd, run.sessionId, {
      status: "failed",
      turnsUsed: run.turnsUsed,
      task: run.task,
      startedAt: run.startedAt,
      finishedAt: Date.now(),
      error: `terminated by ${signal}`,
      ...(run.model !== undefined ? { model: run.model } : {}),
      ...(run.activatedTools !== undefined
        ? { activatedTools: run.activatedTools }
        : {}),
    });
  } catch (saveErr: unknown) {
    process.stderr.write(
      `failed to finalize run state after ${signal}: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}\n`,
    );
  }
}

const SIGNAL_EXIT_NUMBER: Record<"SIGINT" | "SIGTERM" | "SIGHUP", number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
};

// Bun's tty raw mode (which the TUI runs under for its whole session) clears
// ISIG, so a real terminal's Ctrl+C never reaches this handler while a
// session is interactive — confirmed empirically (see the raw-mode SIGINT
// regression test) rather than assumed. The in-session exit path in shell.ts
// therefore owns Ctrl+C exclusively for the interactive case. This handler
// exists for the signal actually reaching the process: external
// orchestration (kill, systemd, docker stop), or a terminal that never
// entered raw mode at all (exec mode has no TUI host and no raw stdin, so
// its Ctrl+C is a real SIGINT today). Listeners are already installed at
// process entry; they finalize the registered handle, and no-op only when
// none is registered.
//
// Terminal restore is done directly here, the same way handleFatal does it,
// rather than left to OpenTUI's own same-signal listener (registered later,
// at host-mount time, once a TUI is actually running): relying on a
// vendored listener's registration order and internal behavior to already
// cover teardown would make correctness depend on undocumented @opentui
// internals that could change on any version bump, with terminal-left-wedged
// as the silent failure mode. disposeHost is idempotent, so calling it here
// even when OpenTUI's own listener also runs is harmless.
// Exported so an integration test can register these process-level handlers
// and send a real signal without spawning the full TUI stack.
export function installSignalHandlers(options?: ProcessHandlerOptions): void {
  if (options?.teardownDeadlineMs !== undefined) {
    teardownDeadlineMs = options.teardownDeadlineMs;
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      if (terminating) return;
      terminating = true;
      void (async () => {
        // Same fence as handleFatal: start teardown, then flip isCrashed
        // before awaiting so queued snapshot writes cannot clobber the
        // terminal write. See markCrashed's doc comment for the residual
        // window this cannot close.
        const teardown = awaitActiveDisposeHost(`handling ${signal}`);
        markCrashed();
        await teardown;
        await finalizeActiveRunOnSignal(signal);
        process.exit(128 + SIGNAL_EXIT_NUMBER[signal]);
      })();
    });
  }
}
