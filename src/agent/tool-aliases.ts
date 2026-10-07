/**
 * Advertised tool names are a projection of registry engine ids that depends
 * on the model family: each family sees exactly one name per tool, the one it
 * was trained on. Incoming calls accept every name any profile advertises, so
 * dispatch, grants, and history replay never depend on the active profile.
 *
 * default (industry-common): read write edit delete bash glob todowrite skill
 *   webfetch websearch question
 * gpt (Codex): default, except shell, update_plan, wait
 */

import { type } from "arktype";
import type { ToolCall, ToolDefinition } from "@intx/types/runtime";
import { canonicalToolName } from "./canonical-tool-name.js";
import {
  detectModelFamily,
  type ModelFamily,
} from "../subagent/provider-family.js";

export type ToolProfile = "default" | "gpt";

/** Registry engine ids → default wire names. */
const DEFAULT_ENGINE_TO_WIRE = {
  read_file: "read",
  write_file: "write",
  edit_file: "edit",
  delete_file: "delete",
  run_shell: "bash",
  search_files: "glob",
  manage_tasks: "todowrite",
  use_skill: "skill",
  web_fetch: "webfetch",
  web_search: "websearch",
  ask_operator: "question",
} as const;

const GPT_OVERRIDES = {
  run_shell: "shell",
  manage_tasks: "update_plan",
  wait_agents: "wait",
} as const;

const ENGINE_TO_WIRE_BY_PROFILE: Record<
  ToolProfile,
  Readonly<Record<string, string>>
> = {
  default: DEFAULT_ENGINE_TO_WIRE,
  gpt: { ...DEFAULT_ENGINE_TO_WIRE, ...GPT_OVERRIDES },
};

/** Tools the gpt profile folds into the single apply_patch envelope tool. */
const PATCH_FOLDED_ENGINES: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "delete_file",
]);

/**
 * gpt models are trained on apply_patch, not write/edit/delete. Replace the
 * first folded name with apply_patch and drop the rest; other profiles and
 * lists with no file-mutation tool pass through unchanged.
 */
export function foldFileToolNames(
  names: readonly string[],
  profile: ToolProfile,
): readonly string[] {
  if (profile !== "gpt") return names;
  const folded = (name: string): boolean =>
    PATCH_FOLDED_ENGINES.has(engineToolName(name));
  if (!names.some(folded)) return names;
  const first = names.findIndex(folded);
  return names.flatMap((name, i) =>
    i === first ? ["apply_patch"] : folded(name) ? [] : [name],
  );
}

export function foldFileToolDefinitions(
  defs: readonly ToolDefinition[],
  profile: ToolProfile,
): ToolDefinition[] {
  if (profile !== "gpt" || !defs.some((d) => d.name === "apply_patch")) {
    return [...defs];
  }
  return defs.filter((d) => !PATCH_FOLDED_ENGINES.has(engineToolName(d.name)));
}

export function toolProfileForFamily(family: ModelFamily): ToolProfile {
  return family === "gpt" ? "gpt" : "default";
}

export function toolProfileForModel(input: {
  providerName: string;
  model?: string;
}): ToolProfile {
  return toolProfileForFamily(detectModelFamily(input));
}

/** Default wire names → registry engine ids. 1:1, never dual-publish. */
export const WIRE_TO_ENGINE: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(DEFAULT_ENGINE_TO_WIRE).map(([engine, wire]) => [
      wire,
      engine,
    ]),
  );

/** Names only a non-default profile advertises; still accepted on dispatch. */
export const HIDDEN_TO_ENGINE: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(GPT_OVERRIDES).map(([engine, wire]) => [wire, engine]),
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

/** Project a registry engine id onto the profile's advertised wire name. */
export function advertisedToolName(
  engine: string,
  profile: ToolProfile = "default",
): string {
  const table =
    typeof profile === "string" && profile in ENGINE_TO_WIRE_BY_PROFILE
      ? ENGINE_TO_WIRE_BY_PROFILE[profile]
      : ENGINE_TO_WIRE_BY_PROFILE.default;
  return table[engine] ?? engine;
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

// update_plan dispatches through translateUpdatePlanArgs, which only accepts
// the Codex { plan: [{ step, status }] } shape. Advertising manage_tasks's
// schema under that name sends the model into a rejected-call loop.
const UPDATE_PLAN_DEFINITION = {
  description:
    "Your work checklist for multi-step jobs. Send the full plan each call; keep at most one step in_progress. Skip for one-step work.",
  inputSchema: {
    type: "object",
    properties: {
      explanation: { type: "string" },
      plan: {
        type: "array",
        items: {
          type: "object",
          properties: {
            step: { type: "string" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
            },
          },
          required: ["step", "status"],
        },
      },
    },
    required: ["plan"],
  },
} as const;

export function projectToolDefinition(
  def: ToolDefinition,
  profile: ToolProfile = "default",
): ToolDefinition {
  const engine = canonicalToolName(def.name);
  const wire = advertisedToolName(engine, profile);
  if (wire === "update_plan" && engine === "manage_tasks") {
    return { ...def, name: wire, ...UPDATE_PLAN_DEFINITION };
  }
  return wire === def.name ? def : { ...def, name: wire };
}

export function projectToolDefinitions(
  defs: readonly ToolDefinition[],
  profile: ToolProfile = "default",
): ToolDefinition[] {
  return defs.map((def) => projectToolDefinition(def, profile));
}

/**
 * Authz parity definitions: every def unchanged, plus one `{...def, name:
 * alias}` copy for each alias in ALIAS_TO_ENGINE whose engine equals the
 * def's canonical name. The reactor authz snapshot is keyed by parked wire
 * name, so without these copies an ask-tier `bash`/`shell` call throws a
 * wiring-defect error instead of suspending. `update_plan` is never
 * snapshotted: its grant is create-only narrow. Non-aliased defs (MCP,
 * leaf-only) pass through unchanged. Output is deduplicated by name.
 */
export function authzParityDefinitions(
  defs: readonly ToolDefinition[],
): ToolDefinition[] {
  const seen = new Set<string>();
  const out: ToolDefinition[] = [];
  const push = (def: ToolDefinition): void => {
    if (seen.has(def.name)) return;
    seen.add(def.name);
    out.push(def);
  };
  for (const def of defs) push(def);
  for (const def of defs) {
    const engine = canonicalToolName(def.name);
    for (const [alias, aliasEngine] of Object.entries(ALIAS_TO_ENGINE)) {
      if (aliasEngine !== engine) continue;
      if (alias === "update_plan") continue;
      push({ ...def, name: alias });
    }
  }
  return out;
}

/**
 * Thin wrapper over a tool bundle (e.g. DynamicToolRunner): identical except
 * the `definitions` getter returns `authzParityDefinitions` over the live
 * set. Run/dispatch and mutation entry points delegate verbatim — only the
 * authz-facing definition set gains parity copies; the advertised wire set
 * is untouched.
 */
export function withAuthzParityDefinitions<
  T extends { readonly definitions: readonly ToolDefinition[] },
>(bundle: T): T {
  const wrapped = { ...bundle };
  const liveSource = bundle as Partial<{
    currentDefinitions: () => readonly ToolDefinition[];
  }>;
  Object.defineProperty(wrapped, "definitions", {
    get() {
      const live =
        typeof liveSource.currentDefinitions === "function"
          ? liveSource.currentDefinitions()
          : bundle.definitions;
      return authzParityDefinitions(live);
    },
    enumerable: true,
    configurable: true,
  });
  return wrapped;
}

const SHELL_WRAPPERS = new Set(["bash", "sh", "zsh"]);

export function shellQuote(arg: string): string {
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
