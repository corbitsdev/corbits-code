import { engineToolName } from "./tool-aliases.js";

const DEFAULT_PREFIX = "default.";

// Muse Spark emits `default.<name>` and duplicated `<name>.<name>`. Dispatch
// strips those onto catalog keys; classify, grants, and the execution cache
// must use the same name so an alias cannot force a second ask/deny. Wire
// names and hidden aliases collapse onto the registry engine id so a grant
// stored as run_shell covers bash.
function baseToolName(requested: string): string {
  let name = requested;
  if (name.startsWith(DEFAULT_PREFIX)) {
    const stripped = name.slice(DEFAULT_PREFIX.length);
    if (stripped.length > 0) name = stripped;
  }
  return undoubledName(name) ?? name;
}

export function canonicalToolName(requested: string): string {
  return engineToolName(baseToolName(requested));
}

// Canonical comparison for tool names arriving on the wire. Either side may be
// an engine id, a profile wire name, a hidden alias, or a default./doubled
// prefixed form — both sides resolve through canonicalToolName first, so a
// rename or per-family projection only touches the alias tables, never the
// callsites.
export function isSameTool(a: string, b: string): boolean {
  return canonicalToolName(a) === canonicalToolName(b);
}

// Grant coverage across the alias→engine collapse. Comparisons run in native
// key space (both sides resolve onto the engine id first); a raw alias name is
// never compared against a native id. Pure renames are capability-identical,
// so a grant stored under either name covers the other. update_plan is the
// exception: it hidden-dispatches onto manage_tasks but only translates to
// action:"create" with todo/doing/done statuses, while manage_tasks spans the
// full lifecycle (create/update, including cancelled). Coverage is
// one-directional: a stored manage_tasks grant covers update_plan use, but a
// stored update_plan grant never covers a manage_tasks request, which may
// carry update/cancel payloads the operator never approved. The
// update_plan-presenting allowance is unreachable live; it exists only so
// direct match-API callers keep narrow-narrow coverage.
export function grantToolCovers(
  storedTool: string,
  requestTool: string,
): boolean {
  const storedBase = baseToolName(storedTool);
  const requestBase = baseToolName(requestTool);
  if (engineToolName(storedBase) !== engineToolName(requestBase)) return false;
  if (
    storedBase.toLowerCase() === "update_plan" &&
    requestBase.toLowerCase() !== "update_plan"
  ) {
    return false;
  }
  return true;
}

// Native key for a stored grant. Pure renames collapse onto the engine id
// (capability-identical, so the collapse is behavior-preserving). update_plan
// has no native key that preserves its narrow create-only capability:
// collapsing it onto manage_tasks would read a stored plan approval as full
// task lifecycle, so it maps to null and the seeder drops it fail-closed.
// Live update_plan use auto-allows and never mints, so no reachable flow
// needs the dropped key.
export function canonicalGrantTool(storedTool: string): string | null {
  const base = baseToolName(storedTool);
  if (base.toLowerCase() === "update_plan") return null;
  return engineToolName(base);
}

function undoubledName(requested: string): string | undefined {
  if (requested.length < 3 || requested.length % 2 === 0) return undefined;
  const name = requested.slice(0, (requested.length - 1) / 2);
  if (requested !== `${name}.${name}`) return undefined;
  return name;
}
