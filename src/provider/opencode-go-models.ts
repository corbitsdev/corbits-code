import { type } from "arktype";

import {
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_MODEL_IDS,
} from "../../packages/opencode-go/src/index.js";
import { requestModelsEndpoint } from "./models-endpoint.js";

const GoModelsResponse = type({
  data: type({ id: "string" }).array(),
});

export type GoDiscoveryState =
  | { readonly status: "models"; readonly models: readonly string[] }
  | { readonly status: "empty" }
  | { readonly status: "unavailable"; readonly message: string }
  | { readonly status: "malformed"; readonly message: string };

let inflight: Promise<readonly string[]> | undefined;
let snapshot: readonly string[] | undefined;

/** Discover public OpenCode Go models without leaking transport or parsing failures. */
export async function discoverGoModels(args?: {
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<GoDiscoveryState> {
  let response: Response;
  try {
    response = await requestModelsEndpoint({
      baseURL: OPENCODE_GO_BASE_URL,
      ...(args?.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      ...(args?.signal !== undefined ? { signal: args.signal } : {}),
    });
  } catch (error) {
    return {
      status: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (!response.ok) {
    return {
      status: "unavailable",
      message: `OpenCode Go returned HTTP ${String(response.status)}`,
    };
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    return {
      status: "malformed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const parsed = GoModelsResponse(raw);
  if (parsed instanceof type.errors) {
    return { status: "malformed", message: parsed.summary };
  }
  const models = [...new Set(parsed.data.map(({ id }) => id.trim()).filter((id) => id.length > 0))];
  return models.length > 0 ? { status: "models", models } : { status: "empty" };
}

/** Sync picker ids: last successful live list, else the packaged seed. Never empty. */
export function selectableGoModelIds(): readonly string[] {
  return snapshot ?? OPENCODE_GO_MODEL_IDS;
}

async function runPrefetch(): Promise<readonly string[]> {
  const state = await discoverGoModels();
  // Empty/unavailable/malformed leave a successful snapshot in place: stale-but-live
  // beats empty, and a cold failure still falls through to the packaged seed.
  if (state.status === "models") {
    snapshot = state.models;
  }
  return selectableGoModelIds();
}

/** Join or start a live fetch; the snapshot is the cache, inflight is only a mutex. */
export function prefetchGoModels(): Promise<readonly string[]> {
  if (inflight !== undefined) return inflight;

  const pending = runPrefetch();
  inflight = pending;
  // Clear inflight on settle so a later prefetch can recover instead of replaying
  // the first settlement forever. .then(cleanup, cleanup) instead of .finally()
  // avoids an abandoned promise chain whose pass-through rejection could become
  // an unhandled rejection — callers await the original pending promise.
  const cleanup = (): void => {
    if (inflight === pending) {
      inflight = undefined;
    }
  };
  pending.then(cleanup, cleanup);
  return pending;
}

export function resetGoModelDiscoveryForTests(): void {
  inflight = undefined;
  snapshot = undefined;
}
