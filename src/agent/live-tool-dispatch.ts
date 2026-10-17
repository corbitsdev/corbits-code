import {
  createAgent,
  type Agent,
  type AgentDefinition,
  type BaseEnv,
} from "@intx/agent";

import { createApprovalProvenanceGate } from "../session/approval-provenance.js";

// @intx/agent resolveTools snapshots `byName` from each bundle's definitions
// at createAgent and never consults a live getter, so a miss returns
// `unknown tool` for a name only DynamicToolRunner can resolve. Two callers
// still depend on reaching it: exec builds once and mounts MCP tools after
// (it never rebuilds), and harness-namespaced spellings (`default.mcp__*`)
// resolve only through the runner's own name lookup. The TUI no longer does
// for late MCP tools: it pins the tool set per build and rebuilds when it
// changes (see pinToolSetAtBuild in session/assemble-runtime.ts).
//
// resolveTools is not exported. During its synchronous walk it does
// `new Map()` for that snapshot; we install a Map whose get() falls back to
// the single live tool bundle so late names reach DynamicToolRunner.run.
// Restore Map before createAgent awaits so only that snapshot is live. Drop
// this wrapper when @intx/agent dispatches through the bundle's current
// definitions (e2e/mcp-late-dispatch.test.ts will fail first).

const OriginalMap = globalThis.Map;

export function isLiveToolBundle(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.addTools === "function" &&
    typeof candidate.currentDefinitions === "function" &&
    typeof candidate.run === "function"
  );
}

export function fallbackLiveToolBundle<V>(map: Map<unknown, V>): V | undefined {
  let found: V | undefined;
  for (const value of map.values()) {
    if (!isLiveToolBundle(value)) continue;
    if (found !== undefined && found !== value) return undefined;
    found = value;
  }
  return found;
}

function createLiveDispatchMap<K, V>(
  iterable?: Iterable<readonly [K, V]> | null,
): Map<K, V> {
  const map = new OriginalMap<K, V>(iterable ?? undefined);
  const protoGet = OriginalMap.prototype.get.bind(map);
  map.get = (key: K) => {
    const hit = protoGet(key);
    if (hit !== undefined || typeof key !== "string") return hit;
    return fallbackLiveToolBundle(map) ?? hit;
  };
  return map;
}

// Compatible with `new Map()` inside published @intx/agent. Not a class —
// we only need a constructable that returns a Map with a live get().
const LiveDispatchMap = Object.assign(
  function LiveDispatchMap<K, V>(
    iterable?: Iterable<readonly [K, V]> | null,
  ): Map<K, V> {
    return createLiveDispatchMap(iterable);
  },
  { prototype: OriginalMap.prototype },
) as unknown as MapConstructor;

export function withLiveToolDispatchMap<T>(fn: () => T): T {
  const previous = globalThis.Map;
  globalThis.Map = LiveDispatchMap;
  try {
    return fn();
  } finally {
    globalThis.Map = previous;
  }
}

export function createAgentWithLiveToolDispatch<EnvReq extends BaseEnv>(
  def: AgentDefinition<EnvReq>,
  env: EnvReq,
): Promise<Agent> {
  return withLiveToolDispatchMap(async () =>
    // The vendored @intx/agent forwards no correlationValidator into the
    // reactor assembly, so approval provenance is enforced at the app's
    // inbound-delivery boundary (see src/session/approval-provenance.ts).
    createApprovalProvenanceGate(await createAgent(def, env)),
  );
}
