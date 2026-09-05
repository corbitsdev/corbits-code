import { type } from "arktype";

import {
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_MODEL_IDS,
} from "../../packages/opencode-go/src/index.js";
import { requestModelsEndpoint } from "./models-endpoint.js";

const GoModelsResponse = type({
  data: type({ id: "string" }).array(),
});

// Bound live /models so a huge or hostile catalog cannot blow process memory.
export const MAX_GO_CATALOG_BYTES = 256 * 1024;
export const MAX_GO_CATALOG_MODELS = 1024;

export type GoDiscoveryState =
  | { readonly status: "models"; readonly models: readonly string[] }
  | { readonly status: "empty" }
  | { readonly status: "unavailable"; readonly message: string }
  | { readonly status: "malformed"; readonly message: string };

let inflight: Promise<readonly string[]> | undefined;
let snapshot: readonly string[] | undefined;

function declaredCatalogBytes(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (raw === null || raw.length === 0) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

function oversizeMessage(kind: "bytes" | "models"): string {
  if (kind === "bytes") {
    return `OpenCode Go catalog exceeds ${String(MAX_GO_CATALOG_BYTES)} bytes`;
  }
  return `OpenCode Go catalog exceeds ${String(MAX_GO_CATALOG_MODELS)} models`;
}

async function readCatalogJson(
  response: Response,
): Promise<
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string }
> {
  const declared = declaredCatalogBytes(response);
  if (declared !== undefined && declared > MAX_GO_CATALOG_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, message: oversizeMessage("bytes") };
  }

  const body = response.body;
  if (body === null) {
    try {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > MAX_GO_CATALOG_BYTES) {
        return { ok: false, message: oversizeMessage("bytes") };
      }
      const value: unknown = JSON.parse(text);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_GO_CATALOG_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, message: oversizeMessage("bytes") };
      }
      chunks.push(value);
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(buffer));
    return { ok: true, value };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

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

  const body = await readCatalogJson(response);
  if (!body.ok) {
    return { status: "malformed", message: body.message };
  }
  const parsed = GoModelsResponse(body.value);
  if (parsed instanceof type.errors) {
    return { status: "malformed", message: parsed.summary };
  }
  if (parsed.data.length > MAX_GO_CATALOG_MODELS) {
    return { status: "malformed", message: oversizeMessage("models") };
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
