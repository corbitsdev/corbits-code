/**
 * One advertised posix set (CL-8400). Registry engines stay posix-named;
 * advertise is a projection onto wire names. Incoming aliases resolve onto
 * the same engine id for dispatch and grants.
 *
 * Wire: read write edit delete bash grep glob
 * Engine: read_file write_file edit_file delete_file run_shell grep search_files
 * Hidden dispatch: shell → run_shell (Codex argv/workdir/timeout_ms coerce),
 * update_plan → manage_tasks. apply_patch is neither advertised nor dispatched.
 */

import { type } from "arktype";
import type { ToolCall, ToolDefinition } from "@intx/types/runtime";

/** Advertised posix names → registry engine ids. 1:1, never dual-publish. */
export const WIRE_TO_ENGINE = {
  read: "read_file",
  write: "write_file",
  edit: "edit_file",
  delete: "delete_file",
  bash: "run_shell",
  glob: "search_files",
} as const;

/** Hidden incoming names that dispatch onto a mounted engine (not advertised). */
export const HIDDEN_TO_ENGINE = {
  shell: "run_shell",
  update_plan: "manage_tasks",
} as const;

const ENGINE_TO_WIRE: Record<string, string> = Object.fromEntries(
  Object.entries(WIRE_TO_ENGINE).map(([wire, engine]) => [engine, wire]),
);

const ALIAS_TO_ENGINE: Record<string, string> = {
  ...WIRE_TO_ENGINE,
  ...HIDDEN_TO_ENGINE,
};

/** Map an incoming alias (wire or hidden) onto the registry engine id. */
export function engineToolName(requested: string): string {
  return (
    ALIAS_TO_ENGINE[requested] ??
    ALIAS_TO_ENGINE[requested.toLowerCase()] ??
    requested
  );
}

/** Project a registry engine id onto the advertised wire name. */
export function advertisedToolName(engine: string): string {
  return ENGINE_TO_WIRE[engine] ?? engine;
}

/**
 * True when `name` (wire, engine, or hidden alias) is covered by an advertised
 * or activated listing that may itself be stored as either wire or engine ids.
 */
export function nameMatchesAdvertisedListing(
  name: string,
  isListed: (candidate: string) => boolean,
): boolean {
  if (isListed(name)) return true;
  const engine = engineToolName(name);
  if (engine !== name && isListed(engine)) return true;
  const wire = advertisedToolName(engine);
  return wire !== name && isListed(wire);
}

export function projectToolDefinition(def: ToolDefinition): ToolDefinition {
  const wire = advertisedToolName(def.name);
  return wire === def.name ? def : { ...def, name: wire };
}

export function projectToolDefinitions(
  defs: readonly ToolDefinition[],
): ToolDefinition[] {
  return defs.map(projectToolDefinition);
}

const SHELL_WRAPPERS = new Set(["bash", "sh", "zsh"]);

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_\-./:=@%]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Codex `shell` sends `command` as a string or argv array. `run_shell` takes a
 * single shell string. Unwrap `[shell, "-lc"|"-c", script]` to the script.
 */
export function normalizeShellCommand(command: string | string[]): string {
  if (typeof command === "string") return command;
  const wrapper = command[0];
  const flag = command[1];
  const script = command[2];
  if (
    command.length === 3 &&
    wrapper !== undefined &&
    script !== undefined &&
    SHELL_WRAPPERS.has(wrapper.replace(/^.*\//, "")) &&
    (flag === "-lc" || flag === "-c")
  ) {
    return script;
  }
  return command.map(shellQuote).join(" ");
}

const CodexShellArgs = type({
  command: "string | string[]",
  "workdir?": "string",
  "timeout_ms?": "number",
});

export function looksLikeCodexShellArgs(
  args: Record<string, unknown>,
): boolean {
  return (
    Array.isArray(args.command) ||
    args.workdir !== undefined ||
    args.timeout_ms !== undefined
  );
}

export function coerceShellArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const parsed = CodexShellArgs(args);
  if (parsed instanceof type.errors) {
    throw new Error("Error: shell requires a command (string or string[]).");
  }
  const coerced: Record<string, unknown> = {
    command: normalizeShellCommand(parsed.command),
  };
  if (parsed.workdir !== undefined) coerced.cwd = parsed.workdir;
  if (parsed.timeout_ms !== undefined) coerced.timeout = parsed.timeout_ms;
  return coerced;
}

const CodexPlanStatus = type("'pending' | 'in_progress' | 'completed'");
const UpdatePlanArgs = type({
  "explanation?": "string",
  plan: type({
    step: "string>0",
    status: CodexPlanStatus,
  }).array(),
});

function codexPlanStatusToTaskStatus(
  status: typeof CodexPlanStatus.infer,
): "todo" | "doing" | "done" {
  if (status === "pending") return "todo";
  if (status === "in_progress") return "doing";
  return "done";
}

export function translateUpdatePlanArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const parsed = UpdatePlanArgs(args);
  if (parsed instanceof type.errors) {
    throw new Error(
      "Error: update_plan requires a plan array of { step, status }.",
    );
  }
  return {
    action: "create",
    tasks: parsed.plan.map((item, i) => ({
      id: `p${i + 1}`,
      title: item.step,
      status: codexPlanStatusToTaskStatus(item.status),
    })),
  };
}

function incomingAlias(requested: string): string {
  let name = requested;
  if (name.startsWith("default.")) {
    const stripped = name.slice("default.".length);
    if (stripped.length > 0) name = stripped;
  }
  return name;
}

/**
 * Coerce hidden Codex-shaped arguments onto the engine tool, and rewrite the
 * dispatched name to the engine id. Callers pass the already-resolved engine.
 */
export function prepareDispatchedToolCall(
  call: ToolCall,
  engine: string,
): ToolCall {
  const incoming = incomingAlias(call.name);
  let args = call.arguments;
  if (
    incoming === "shell" ||
    incoming.toLowerCase() === "shell" ||
    (engine === "run_shell" && looksLikeCodexShellArgs(args))
  ) {
    args = coerceShellArgs(args);
  }
  if (
    (incoming === "update_plan" || incoming.toLowerCase() === "update_plan") &&
    engine === "manage_tasks"
  ) {
    args = translateUpdatePlanArgs(args);
  }
  if (args === call.arguments && engine === call.name) return call;
  return { ...call, name: engine, arguments: args };
}
