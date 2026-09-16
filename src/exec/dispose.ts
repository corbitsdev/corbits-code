import { getLogger } from "@intx/log";

import { LOG_NAMESPACE_ROOT } from "../branding.js";
import { awaitCloseWithoutHidingLeftover } from "../subagent/dispose.js";
import type { SubAgentSessionStore } from "../subagent/index.js";

const logger = getLogger([LOG_NAMESPACE_ROOT, "exec"]);

/** Normalize unknown catch values for structured warn/error logs. */
export function formatCaughtError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Headless analogue of TUI `runtime-shutdown`: dispose the toolset (posix
 * process-group reap) before waiting on agent.close so a hung close cannot
 * skip killing detached run_shell children. `cancelAll` is awaited so a
 * leftover-child throw is visible. Once-only per runtime object so the send
 * path, `finally`, and signal host cannot double-dispose.
 *
 * Lives in its own module (not exec/runner.ts, whose import graph costs
 * ~0.4s in a fresh process) so the exec-shutdown-reap fixture can exercise
 * the real dispose path without paying that in every subprocess it spawns.
 */
const execDisposeInFlight = new WeakMap<object, Promise<void>>();

function rethrowExecDisposeFailures(failures: unknown[]): void {
  const first = failures[0];
  if (first === undefined) return;
  if (failures.length === 1) throw first;
  throw new AggregateError(failures, "exec runtime dispose failed");
}

export function disposeExecRuntime(args: {
  agent: { close: () => Promise<unknown> } | null;
  toolset: { dispose: () => Promise<unknown> } | null;
  subAgentSessions: Pick<SubAgentSessionStore, "cancelAll"> | null;
}): Promise<void> {
  const key = args.toolset ?? args.agent ?? args.subAgentSessions;
  if (key !== null) {
    const existing = execDisposeInFlight.get(key);
    if (existing !== undefined) return existing;
  }

  const run = runExecDispose(args);
  if (key !== null) execDisposeInFlight.set(key, run);
  return run;
}

async function runExecDispose(args: {
  agent: { close: () => Promise<unknown> } | null;
  toolset: { dispose: () => Promise<unknown> } | null;
  subAgentSessions: Pick<SubAgentSessionStore, "cancelAll"> | null;
}): Promise<void> {
  const failures: unknown[] = [];
  if (args.toolset !== null) {
    try {
      await args.toolset.dispose();
    } catch (err: unknown) {
      logger.debug("toolset.dispose during exec finally failed: {error}", {
        error: formatCaughtError(err),
      });
      failures.push(err);
    }
  }
  try {
    await args.subAgentSessions?.cancelAll("Session closed");
  } catch (err) {
    failures.push(err);
  }
  if (args.agent !== null) {
    try {
      await awaitCloseWithoutHidingLeftover(args.agent.close(), failures[0]);
    } catch (err: unknown) {
      logger.debug("agent.close during exec finally failed: {error}", {
        error: formatCaughtError(err),
      });
      failures.push(err);
    }
  }
  rethrowExecDisposeFailures(failures);
}
