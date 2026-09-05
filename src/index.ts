import { getLogger } from "@intx/log";
import { LOG_NAMESPACE_ROOT } from "./branding.js";
import { primeCrashReporting, writeCrashReport, type CrashKind } from "./crash/report.js";
import { getActiveRun, markCrashed } from "./session/active-run.js";
import { getActiveDisposeHost } from "./session/active-host.js";
import { saveCrashState } from "./session/state.js";
import { loadConfig, CliHelpError, CliUserError } from "./config/index.js";
import { ensureTelemetrySettings, globalSettingsPath } from "./config/settings.js";
import { installFileLogSink } from "./logging/sink.js";
import { flushPerfToOtel } from "./perf/index.js";
import { createTelemetry, telemetryDisabledByEnv } from "./telemetry/index.js";
import { classifyErrorClass } from "./telemetry/classify.js";
import { getTelemetry, setTelemetry } from "./telemetry/singleton.js";
import { runExec } from "./exec/runner.js";
import { runOnboarding } from "./tui/onboarding.js";
import { runTUI } from "./tui/runner.js";

export interface Runners {
  runTUI: (config: import("./config/index.js").Config) => Promise<number>;
  runExec: (config: import("./config/index.js").Config) => Promise<number>;
  runOnboarding: (config: import("./config/index.js").UnconfiguredConfig) => Promise<number>;
}

export async function mainWithRunners(argv: readonly string[], runners: Runners): Promise<number> {
  // Must run before any other line: @intx/log installs a console sink as a
  // side effect of import, and loadConfig itself can log (e.g. healed
  // settings). Once installed, this replaces that default so nothing —
  // including a vendored dependency's logger — reaches the terminal the
  // TUI is about to own.
  installFileLogSink();
  const config = await loadConfig(argv, { allowUnconfigured: true });
  // Resolve the crash-report directory once, up front, while the process is
  // healthy. This is the only place project-key resolution (which shells
  // out to git) may happen on the crash path — the handler itself must
  // never call it, or a hung git would block the exit it exists to force.
  primeCrashReporting(config.cwd);
  // Exec has no Ink banner; unconfigured TUI goes to onboarding without the
  // main-screen notice. Surface fail-open diagnostics on stderr for those
  // paths so junk local files are never silent.
  const surfaceDiagnosticsOnStderr = config.command === "exec" || !config.configured;
  if (surfaceDiagnosticsOnStderr && config.settingsDiagnostics !== undefined) {
    for (const d of config.settingsDiagnostics) {
      process.stderr.write(`settings: ${d.message}\n  fix: ${d.fix}\n`);
    }
  }
  // Always the TRUE global settings file, never config.globalSettingsPath —
  // that's the --config override file when one was given, and splitting
  // telemetry across two files means the installationId lands somewhere the
  // toggle (which also uses the true global path) never looks, silently
  // breaking re-enable. Never let telemetry setup delay or crash startup:
  // settings persistence is awaited (it's local disk I/O), but the capture
  // call itself is fire-and-forget per createTelemetry's contract.
  // Env kills short-circuit before ensureTelemetrySettings so a disabled run
  // never touches the settings file (no installationId generation).
  if (!telemetryDisabledByEnv()) {
    const settings = await ensureTelemetrySettings(globalSettingsPath()).catch((err: unknown) => {
      getLogger([LOG_NAMESPACE_ROOT, "telemetry"]).warn(
        "Failed to ensure telemetry settings at startup: {error}",
        { error: err },
      );
      return null;
    });
    // Consent by proceeding: until the disclosure has been shown, the
    // default disabled no-op singleton stays in place so no event of any
    // kind can leave the process. The disclosure surfaces activate telemetry
    // (and fire the held cli_start) on the first affirmative user action —
    // see telemetry/first-run.ts.
    if (settings?.telemetry?.noticeShown === true) {
      const telemetry = createTelemetry({ settings });
      setTelemetry(telemetry);
      telemetry.capture("cli_start");
    }
  }

  let exitCode: number;
  if (!config.configured) {
    if (config.command === "exec") {
      // Exec needs a provider; onboarding is TUI-only. Fail closed with a
      // clear message rather than launching Ink.
      process.stderr.write(
        "No provider configured. Run `corbits` (interactive) once to complete setup, " +
          "or pass --provider / --model with credentials.\n",
      );
      exitCode = 2;
    } else {
      exitCode = await runners.runOnboarding(config);
    }
  } else if (config.command === "exec") {
    exitCode = await runners.runExec(config);
  } else {
    exitCode = await runners.runTUI(config);
  }

  // Opt-in OTEL export of the PerfSpan tree (session/process boundary).
  // No-op when OTEL is disabled — zero network on the export path.
  const otelSettings = config.configured ? config.settings : null;
  await flushPerfToOtel(otelSettings);

  // Bound against process.exit dropping in-flight captures for short
  // sessions; flush itself is deadline-capped so exit stays snappy.
  await getTelemetry().flush();
  return exitCode;
}

export async function main(argv: readonly string[]): Promise<number> {
  return mainWithRunners(argv, {
    runTUI,
    runExec: async (config) => {
      const result = await runExec(config);
      return result.exitCode;
    },
    runOnboarding,
  });
}

// Shared by handleFatal and the signal handlers below so a signal arriving
// mid-crash-unwind (or a crash surfacing while a signal is already tearing
// the process down) can't re-enter either path a second time.
let terminating = false;

// Exported so an integration test can register these process-level handlers
// and inject a crash without spawning the full TUI stack.
export async function handleFatal(kind: CrashKind, error: unknown): Promise<void> {
  if (terminating) return;
  terminating = true;
  // OpenTUI's own uncaughtException/unhandledRejection listener only logs
  // (see installCrashHandlers' comment below) — it never tears down the
  // terminal the way its signal listener does. Without this, a throw that
  // escapes runTUI's own try/catch (e.g. inside a fire-and-forget `void`
  // call) leaves the alternate screen and raw mode stuck. disposeHost is
  // idempotent, so this is safe even if runTUI's own catch block already
  // ran it moments earlier.
  try {
    getActiveDisposeHost()?.();
  } catch (disposeErr: unknown) {
    process.stderr.write(
      `host dispose failed during fatal handling: ${disposeErr instanceof Error ? disposeErr.message : String(disposeErr)}\n`,
    );
  }
  // Flip this before any awaits below so any snapshot write still queued
  // behind another one in state.ts's per-session chain sees it and steps
  // aside the moment it's next in line, rather than racing saveCrashState's
  // rename() below. See markCrashed's doc comment for the residual window
  // this cannot close.
  markCrashed();
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
  getTelemetry().capture("crash", { kind, error_class: classifyErrorClass(error) });
  await getTelemetry().flush();
  process.exit(1);
}

// A crash reaching here escaped without ever hitting runTUI's own try/catch
// (e.g. a throw inside a fire-and-forget `void` call), so run.json was never
// closed out. getActiveRun surfaces the in-flight session set by the in-flight
// runner (TUI or exec), with
// enough (task, startedAt, model) carried on the handle itself that no read
// of run.json is needed — a readFile here would be exactly the kind of
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
      turnsUsed: 0,
      task: run.task,
      startedAt: run.startedAt,
      finishedAt: Date.now(),
      error: message,
      ...(run.model !== undefined ? { model: run.model } : {}),
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
export function installCrashHandlers(): void {
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
async function finalizeActiveRunOnSignal(signal: NodeJS.Signals): Promise<void> {
  const run = getActiveRun();
  if (run === null) return;
  try {
    await saveCrashState(run.cwd, run.sessionId, {
      status: "failed",
      turnsUsed: 0,
      task: run.task,
      startedAt: run.startedAt,
      finishedAt: Date.now(),
      error: `terminated by ${signal}`,
      ...(run.model !== undefined ? { model: run.model } : {}),
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
export function installSignalHandlers(): void {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      if (terminating) return;
      terminating = true;
      try {
        getActiveDisposeHost()?.();
      } catch (disposeErr: unknown) {
        process.stderr.write(
          `host dispose failed handling ${signal}: ${disposeErr instanceof Error ? disposeErr.message : String(disposeErr)}\n`,
        );
      }
      // Same fence as handleFatal: any snapshot still queued in writeChains must
      // see isCrashed and step aside before saveCrashState renames run.json.
      markCrashed();
      void finalizeActiveRunOnSignal(signal).finally(() => {
        process.exit(128 + SIGNAL_EXIT_NUMBER[signal]);
      });
    });
  }
}

export function cliCaughtExit(err: unknown): {
  stream: "stdout" | "stderr";
  text: string;
  code: number;
} {
  if (err instanceof CliHelpError) {
    return { stream: "stdout", text: `${err.message}\n`, code: err.exitCode };
  }
  if (err instanceof CliUserError) {
    return { stream: "stderr", text: `${err.message}\n`, code: err.exitCode };
  }
  return {
    stream: "stderr",
    text: `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    code: 1,
  };
}

if (import.meta.main) {
  installCrashHandlers();
  installSignalHandlers();

  let code: number;
  try {
    code = await main(process.argv.slice(2));
  } catch (err: unknown) {
    const exit = cliCaughtExit(err);
    const dest = exit.stream === "stdout" ? process.stdout : process.stderr;
    dest.write(exit.text);
    code = exit.code;
  }
  process.exit(code);
}
