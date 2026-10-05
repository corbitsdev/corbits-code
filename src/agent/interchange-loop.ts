/**
 * Optional Interchange-driven core loop (CL-8267).
 *
 * The reactor (`@intx/agent` + `ChatDirector`) remains the only loop driver.
 * This module is the opt-in seam for driving it through Interchange's
 * `runWorkflow`/`runLocal` instead, without waiting on the full 0.4.0 hub.
 *
 * Gating: enabled only when `CORBITS_INTERCHANGE_LOOP` is `1` or `true`.
 * Resolution is lazy and total — `@intx/workflow` is not a dependency of this
 * package yet, so when it cannot be loaded the caller keeps the reactor path.
 * Nothing here changes behavior unless the flag is set.
 */

export const INTERCHANGE_LOOP_ENV_VAR = "CORBITS_INTERCHANGE_LOOP";

const INTERCHANGE_WORKFLOW_SPECIFIER = "@intx/workflow";

export type InterchangeLoopStatus =
  | { status: "driven"; via: "runWorkflow" | "runLocal" }
  | { status: "unavailable"; reason: string };

/** True only when the operator explicitly opts into the Interchange loop. */
export function isInterchangeLoopEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[INTERCHANGE_LOOP_ENV_VAR]?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

type WorkflowModule = Record<string, unknown>;

function pickDriver(loaded: WorkflowModule): InterchangeLoopStatus {
  // Prefer the hub-backed entry point; the in-memory runner is the local
  // fallback. Both names come from upstream `@intx/workflow`.
  if (typeof loaded["runWorkflow"] === "function")
    return { status: "driven", via: "runWorkflow" };
  if (typeof loaded["runLocal"] === "function")
    return { status: "driven", via: "runLocal" };
  return {
    status: "unavailable",
    reason: `${INTERCHANGE_WORKFLOW_SPECIFIER} loaded but exports neither runWorkflow nor runLocal`,
  };
}

/**
 * Resolve the Interchange loop driver. Never throws and never imports
 * statically — the package is an optional peer, absent until the workflow
 * runtime lands. Callers fall through to the reactor on `unavailable`.
 */
export async function resolveInterchangeLoopRunner(): Promise<InterchangeLoopStatus> {
  let loaded: unknown;
  try {
    loaded = (await import(
      INTERCHANGE_WORKFLOW_SPECIFIER
    )) as unknown as WorkflowModule;
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      status: "unavailable",
      reason: `${INTERCHANGE_WORKFLOW_SPECIFIER} is not installed (${detail})`,
    };
  }
  if (typeof loaded !== "object" || loaded === null)
    return {
      status: "unavailable",
      reason: `${INTERCHANGE_WORKFLOW_SPECIFIER} did not load as a module`,
    };
  return pickDriver(loaded as unknown as WorkflowModule);
}
