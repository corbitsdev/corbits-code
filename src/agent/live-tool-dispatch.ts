import {
  createAgent,
  type Agent,
  type AgentDefinition,
  type BaseEnv,
} from "@intx/agent";

// XXX — @intx/agent resolveTools snapshots `byName` from each bundle's
// definitions at createAgent and never consults a live getter. MCP tools
// arrive later via DynamicToolRunner.addTools (servers connect after the TUI
// is up; one OAuth-blocked server can also stall the post-connect reload
// that would rebuild the snapshot). A miss then returns `unknown tool`
// even though tool_search already listed the name from the live runner.
//
// resolveTools is not exported. During its synchronous walk it does
// `new Map()` for that snapshot; we install a Map whose get() falls back
// to the single live tool bundle so late names reach DynamicToolRunner.run.
// Restore Map before createAgent awaits so only that snapshot is live.
// Drop this wrapper when @intx/agent dispatches through the bundle's
// current definitions (the characterization test in
// tests/integration/mcp-late-dispatch.test.ts will fail first).

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

function createLiveDispatchMap<K, V>(iterable?: Iterable<readonly [K, V]> | null): Map<K, V> {
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
  function LiveDispatchMap<K, V>(iterable?: Iterable<readonly [K, V]> | null): Map<K, V> {
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
  return withLiveToolDispatchMap(() => createAgent(def, env));
}
