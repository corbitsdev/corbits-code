import {
  describeError,
  writeCrashReport,
  type CrashKind,
} from "./crash/report.js";
import { getActiveRun, markCrashed } from "./session/active-run.js";
import { printResumeHint } from "./session/resume-hint.js";
import { getActiveDisposeHost } from "./session/active-host.js";
import { saveCrashState } from "./session/state.js";
import { classifyErrorClass } from "./telemetry/classify.js";
import { getTelemetry } from "./telemetry/singleton.js";

// Lives in its own module so crash/signal fixtures install the real
// process-level handlers without pulling the whole TUI/config graph.

// Shared by handleFatal and the signal handlers so a signal mid-crash-unwind
// (or a crash mid-signal-teardown) can't re-enter either path twice.
let terminating = false;

export const RUNTIME_TEARDOWN_DEADLINE_MS = 2_000;

// Tests shorten the bound so a never-settling dispose host doesn't pay the
// full 2s per test. One process-global read by both installers; the last
// installer call wins, and no process installs both with different values.
let teardownDeadlineMs = RUNTIME_TEARDOWN_DEADLINE_MS;

export interface ProcessHandlerOptions {
  /** Shorten the bounded-teardown deadline; tests only, production keeps 2s. */
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
  // OpenTUI's own listeners only log, so an escaped throw would leave the
  // terminal stuck; tear the host down here. disposeHost is idempotent, so
  // this is safe if runTUI's catch already ran it. Flip isCrashed before
  // awaiting so queued snapshot writes still observe the fence.
  const teardown = awaitActiveDisposeHost("during fatal handling");
  markCrashed();
  await teardown;
  process.stderr.write(`${kind}: ${describeError(error)}\n`);
  const file = await writeCrashReport(kind, error);
  if (file !== null) {
    process.stderr.write(`crash report written to ${file}\n`);
  } else {
    process.stderr.write("failed to write crash report\n");
  }
  await finalizeActiveRunOnCrash(error);
  // Report only the language's own error types by name; application or plugin
  // subclass names are author-chosen and as identifying as any free text.
  getTelemetry().capture("crash", {
    kind,
    error_class: classifyErrorClass(error),
  });
  await getTelemetry().flush();
  process.exit(1);
}

// Shared finalize path: crash records "crashed" with the error message, signal
// records "failed" with `terminated by <signal>` and writes no crash report.
// Save-then-log await ordering must stay exactly as written.
async function finalizeActiveRun(
  status: "crashed" | "failed",
  error: string,
  context: string,
): Promise<void> {
  const run = getActiveRun();
  if (run === null) return;
  try {
    await saveCrashState(run.cwd, run.sessionId, {
      status,
      turnsUsed: run.turnsUsed,
      task: run.task,
      startedAt: run.startedAt,
      finishedAt: Date.now(),
      error,
      ...(run.model !== undefined ? { model: run.model } : {}),
      ...(run.activatedTools !== undefined
        ? { activatedTools: run.activatedTools }
        : {}),
      ...(run.lastCacheWriteAt !== undefined
        ? { lastCacheWriteAt: run.lastCacheWriteAt }
        : {}),
    });
  } catch (saveErr: unknown) {
    process.stderr.write(
      `failed to finalize run state after ${context}: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}\n`,
    );
  }
}

// A crash reaching here escaped runTUI's own try/catch, so run.json was never
// closed out; the in-flight runner (TUI or exec) registered the session handle
// with everything saveCrashState needs, so no run.json read is needed on this
// path. The write goes through saveCrashState directly — chaining behind the
// state.ts write chain could wait on the very write that crashed.
async function finalizeActiveRunOnCrash(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  return finalizeActiveRun("crashed", message, "crash");
}

// OpenTUI installs process-global uncaughtException/unhandledRejection
// listeners that only log, suppressing Bun's default print-and-exit; with
// raw-mode stdin holding the loop open, an escaped throw would hang the
// process forever. Node invokes every registered listener regardless of
// order, so these still run and terminate.
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

// Mirrors finalizeActiveRunOnCrash, but a signal is a clean termination: the
// run is left "failed" and no crash report is written. Callers must
// markCrashed() first so chained renames cannot clobber the terminal write.
async function finalizeActiveRunOnSignal(
  signal: NodeJS.Signals,
): Promise<void> {
  return finalizeActiveRun("failed", `terminated by ${signal}`, signal);
}

const SIGNAL_EXIT_NUMBER: Record<"SIGINT" | "SIGTERM" | "SIGHUP", number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
};

// Raw mode clears ISIG, so an interactive Ctrl+C never reaches this handler;
// shell.ts owns that path. This handles signals that do reach the process:
// external orchestration (kill, systemd, docker stop) or exec mode, which has
// no TUI host and no raw stdin. Listeners finalize the registered handle and
// no-op only when none is registered.
//
// Terminal restore happens here, not via OpenTUI's own same-signal listener,
// whose registration order and behavior are vendored internals; disposeHost is
// idempotent, so running it alongside that listener is harmless.
// Exported so an integration test can register these handlers and send a real
// signal without spawning the full TUI stack.
export function installSignalHandlers(options?: ProcessHandlerOptions): void {
  if (options?.teardownDeadlineMs !== undefined) {
    teardownDeadlineMs = options.teardownDeadlineMs;
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      if (terminating) return;
      terminating = true;
      void (async () => {
        // Same fence as handleFatal: flip isCrashed before awaiting teardown
        // so queued snapshot writes cannot clobber the terminal write.
        const teardown = awaitActiveDisposeHost(`handling ${signal}`);
        markCrashed();
        await teardown;
        // Print before the finalize await so disk I/O flushes through the
        // stderr pipe before process.exit, which can otherwise drop it.
        // printResumeHint is exactly-once, so a racing signal cannot
        // double-print the line.
        const run = getActiveRun();
        if (run !== null) printResumeHint(run.sessionId);
        await finalizeActiveRunOnSignal(signal);
        process.exit(128 + SIGNAL_EXIT_NUMBER[signal]);
      })();
    });
  }
}
