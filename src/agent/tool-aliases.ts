// Advertised tool names are a projection of registry engine ids by model
// family: each family sees exactly one name per tool, the one it was trained
// on. Incoming calls accept every name any profile advertises, so dispatch,
// grants, and history replay never depend on the active profile.

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

/**
 * Engines one advertised wire replaces. A profile without an entry keeps
 * the 1:1 wire table. Adding a family is a new ToolProfile plus a row here
 * and in ENGINE_TO_WIRE_BY_PROFILE — not a new director package.
 */
const PROFILE_FOLDS: Record<
  ToolProfile,
  { wire: string; engines: readonly string[] } | undefined
> = {
  default: undefined,
  gpt: {
    wire: "apply_patch",
    engines: ["write_file", "edit_file", "delete_file"],
  },
};

function buildAdvertisedWireEngines(
  profile: ToolProfile,
): ReadonlyMap<string, readonly string[]> {
  const fold = PROFILE_FOLDS[profile];
  const folded = new Set(fold?.engines ?? []);
  const map = new Map<string, string[]>();
  for (const [engine, wire] of Object.entries(
    ENGINE_TO_WIRE_BY_PROFILE[profile],
  )) {
    if (folded.has(engine)) continue;
    const existing = map.get(wire);
    if (existing === undefined) map.set(wire, [engine]);
    else existing.push(engine);
  }
  if (fold !== undefined) map.set(fold.wire, [...fold.engines]);
  return map;
}

const ADVERTISED_WIRE_ENGINES = Object.fromEntries(
  (Object.keys(ENGINE_TO_WIRE_BY_PROFILE) as ToolProfile[]).map((profile) => [
    profile,
    buildAdvertisedWireEngines(profile),
  ]),
) as Record<ToolProfile, ReadonlyMap<string, readonly string[]>>;

export function toolProfiles(): readonly ToolProfile[] {
  return Object.keys(ENGINE_TO_WIRE_BY_PROFILE) as ToolProfile[];
}

/** Wire name → engine ids this profile advertises. Folded wires map to every engine they replace. */
export function advertisedWireEngines(
  profile: ToolProfile,
): ReadonlyMap<string, readonly string[]> {
  return ADVERTISED_WIRE_ENGINES[profile];
}

/**
 * Engines `wire` stands for on `profile`. Undefined when this profile does
 * not advertise that name (a later family follows the same table).
 */
export function enginesForAdvertisedWire(
  wire: string,
  profile: ToolProfile,
): readonly string[] | undefined {
  const table = ADVERTISED_WIRE_ENGINES[profile];
  return table.get(wire) ?? table.get(wire.toLowerCase());
}

/** Wire this profile advertises for `engine`, including a fold that replaces it. */
function profileWireName(engine: string, profile: ToolProfile): string {
  const fold = PROFILE_FOLDS[profile];
  if (fold !== undefined && fold.engines.includes(engine)) return fold.wire;
  return advertisedToolName(engine, profile);
}

/** Every wire any profile advertises for `engine`, including fold wires. */
export function advertisedNamesForEngine(engine: string): readonly string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const profile of toolProfiles()) {
    const wire = profileWireName(engine, profile);
    if (seen.has(wire)) continue;
    seen.add(wire);
    names.push(wire);
  }
  return names;
}

/** gpt models are trained on apply_patch, not write/edit/delete. Other
 * profiles and lists without a folded tool pass through unchanged. */
export function foldFileToolNames(
  names: readonly string[],
  profile: ToolProfile,
): readonly string[] {
  const fold = PROFILE_FOLDS[profile];
  if (fold === undefined) return names;
  const folded = (name: string): boolean =>
    fold.engines.includes(engineToolName(name));
  if (!names.some(folded)) return names;
  const first = names.findIndex(folded);
  return names.flatMap((name, i) =>
    i === first ? [fold.wire] : folded(name) ? [] : [name],
  );
}

export function foldFileToolDefinitions(
  defs: readonly ToolDefinition[],
  profile: ToolProfile,
): ToolDefinition[] {
  const fold = PROFILE_FOLDS[profile];
  if (fold === undefined || !defs.some((d) => d.name === fold.wire)) {
    return [...defs];
  }
  const folded = new Set(fold.engines);
  return defs.filter((d) => !folded.has(engineToolName(d.name)));
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

/** True when `name` (wire, engine, or hidden alias) is covered by an
 * advertised or activated listing (which may store wire or engine ids).
 * A call is advertised when this profile's wire is on the list, and also
 * when the default wire is — primary prefixes still store `bash` while a
 * gpt worker prefix stores `shell`. */
export function nameMatchesAdvertisedListing(
  name: string,
  isListed: (candidate: string) => boolean,
  profile: ToolProfile = "default",
): boolean {
  if (isListed(name)) return true;
  const engine = engineToolName(name);
  if (engine !== name && isListed(engine)) return true;
  const wires =
    profile === "default"
      ? [profileWireName(engine, profile)]
      : [profileWireName(engine, profile), profileWireName(engine, "default")];
  return wires.some((wire) => wire !== name && isListed(wire));
}

// update_plan dispatches through translateUpdatePlanArgs, so advertising
// manage_tasks's schema under that name sends the model into a rejected-call
// loop.
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

/** Authz parity: the reactor authz snapshot is keyed by parked wire name,
 * so without per-alias copies an ask-tier `bash`/`shell` call throws a
 * wiring-defect error instead of suspending. `update_plan` is never
 * snapshotted (its grant is create-only narrow); non-aliased defs (MCP,
 * leaf-only) pass through. */
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

/** Tool bundle wrapper (e.g. DynamicToolRunner): identical except the
 * `definitions` getter returns `authzParityDefinitions` over the live set. */
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

/** Codex `shell` sends `command` as a string or argv array, while
 * `run_shell` takes a single shell string. */
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

/** Coerce hidden Codex-shaped arguments onto the engine tool. Callers pass
 * the already-resolved engine. gpt advertises `shell` with run_shell's own
 * arguments (`cwd`, `timeout`, `background`, `stop`); those pass through.
 * Only Codex argv, `workdir`, and `timeout_ms` are rewritten. */
export function prepareDispatchedToolCall(
  call: ToolCall,
  engine: string,
): ToolCall {
  const incoming = incomingAlias(call.name);
  let args = call.arguments;
  if (engine === "run_shell" && looksLikeCodexShellArgs(args)) {
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
