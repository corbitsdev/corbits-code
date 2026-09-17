import { setActiveRun } from "../../../src/session/active-run.js";
import { saveState } from "../../../src/session/state.js";

export interface InitCrashFixtureOptions {
  /** Env var carrying the session id (e.g. "CRASH_TEST_SESSION_ID"). */
  readonly envVar: string;
  /** Task string recorded on the initial "running" run.json. */
  readonly task: string;
}

export interface CrashFixtureInit {
  readonly cwd: string;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly task: string;
  readonly model: string;
  /**
   * The registered active-run handle object. Mutate it in place (e.g. on
   * session rotation) rather than registering a fresh handle, matching
   * runner.ts's activeRunHandle.
   */
  readonly activeRunHandle: Parameters<typeof setActiveRun>[0];
}

/**
 * Common init prelude for the crash-run fixtures: reads the session id from
 * `envVar`, writes the initial "running" run.json, and registers the
 * active-run handle. Fixtures keep their own handler installs (crash vs
 * signal), write gates, and stdout protocol.
 */
export async function initCrashFixture(
  options: InitCrashFixtureOptions,
): Promise<CrashFixtureInit> {
  const cwd = process.cwd();
  const sessionId = process.env[options.envVar];
  if (sessionId === undefined) {
    throw new Error(`${options.envVar} must be set`);
  }

  const startedAt = Date.now();
  const task = options.task;
  const model = "test-provider:test-model";

  await saveState(cwd, sessionId, {
    status: "running",
    turnsUsed: 3,
    task,
    startedAt,
    model,
  });

  const activeRunHandle = {
    sessionId,
    cwd,
    task,
    startedAt,
    turnsUsed: 3,
    model,
  };
  setActiveRun(activeRunHandle);
  return { cwd, sessionId, startedAt, task, model, activeRunHandle };
}
