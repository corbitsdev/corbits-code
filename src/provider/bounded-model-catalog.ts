import {
  endpointErrorMessage,
  type ModelsEndpointDiscoveryState,
} from "./models-endpoint.js";

export type CatalogDiscoveryState = ModelsEndpointDiscoveryState;

function declaredCatalogBytes(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (raw === null || raw.length === 0) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

async function readBoundedCatalogText(
  response: Response,
  args: { readonly maxBytes: number; readonly oversizeMessage: string },
): Promise<
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly message: string }
> {
  const declared = declaredCatalogBytes(response);
  if (declared !== undefined && declared > args.maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, message: args.oversizeMessage };
  }

  try {
    const body = response.body;
    if (body === null) {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > args.maxBytes) {
        return { ok: false, message: args.oversizeMessage };
      }
      return { ok: true, text };
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > args.maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, message: args.oversizeMessage };
      }
      chunks.push(value);
    }

    const buffer = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, text: new TextDecoder().decode(buffer) };
  } catch (error) {
    return { ok: false, message: endpointErrorMessage(error) };
  }
}

type DiscoveredModels = Extract<
  CatalogDiscoveryState,
  { status: "models" }
>["models"];

export function createBoundedModelCatalog<
  Seed extends readonly string[],
>(args: {
  request: (opts: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }) => Promise<Response>;
  parse: (
    raw: unknown,
    cap: { readonly maxModels: number; readonly oversizeMessage: string },
  ) => CatalogDiscoveryState;
  seedIds: Seed;
  catalogLabel: string;
  maxBytes: number;
  maxModels: number;
}): {
  discoverModels: (opts?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }) => Promise<CatalogDiscoveryState>;
  selectableModelIds: () => Seed | DiscoveredModels;
  prefetchModels: () => Promise<Seed | DiscoveredModels>;
  resetDiscoveryForTests: () => void;
} {
  const { request, parse, seedIds, catalogLabel, maxBytes, maxModels } = args;

  let inflight: Promise<Seed | DiscoveredModels> | undefined;
  let snapshot: DiscoveredModels | undefined;

  function oversizeMessage(kind: "bytes" | "models"): string {
    if (kind === "bytes") {
      return `${catalogLabel} catalog exceeds ${String(maxBytes)} bytes`;
    }
    return `${catalogLabel} catalog exceeds ${String(maxModels)} models`;
  }

  async function readCatalogJson(
    response: Response,
  ): Promise<
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly message: string }
  > {
    const text = await readBoundedCatalogText(response, {
      maxBytes,
      oversizeMessage: oversizeMessage("bytes"),
    });
    if (!text.ok) return text;
    try {
      const value: unknown = JSON.parse(text.text);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, message: endpointErrorMessage(error) };
    }
  }

  async function discoverModels(opts?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<CatalogDiscoveryState> {
    let response: Response;
    try {
      // Forward only the transport knobs so a caller's extra keys can never
      // reach the request and override its URL or headers.
      response = await request({
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
      });
    } catch (error) {
      return {
        status: "unavailable",
        message: endpointErrorMessage(error),
      };
    }

    if (!response.ok) {
      return {
        status: "unavailable",
        message: `${catalogLabel} returned HTTP ${String(response.status)}`,
      };
    }

    const body = await readCatalogJson(response);
    if (!body.ok) {
      return { status: "malformed", message: body.message };
    }
    return parse(body.value, {
      maxModels,
      oversizeMessage: oversizeMessage("models"),
    });
  }

  function selectableModelIds(): Seed | DiscoveredModels {
    return snapshot ?? seedIds;
  }

  async function runPrefetch(): Promise<Seed | DiscoveredModels> {
    const state = await discoverModels();
    // Empty/unavailable/malformed leave the successful snapshot in place:
    // stale-but-live beats empty; a cold failure falls back to the seed.
    if (state.status === "models") {
      snapshot = state.models;
    }
    return selectableModelIds();
  }

  function prefetchModels(): Promise<Seed | DiscoveredModels> {
    if (inflight !== undefined) return inflight;

    const pending = runPrefetch();
    inflight = pending;
    // Clear inflight on settle so a later prefetch can recover instead of
    // replaying the first settlement forever. .then(cleanup, cleanup) rather
    // than .finally() avoids an abandoned chain whose pass-through rejection
    // could become unhandled — callers await the original pending promise.
    const cleanup = (): void => {
      if (inflight === pending) {
        inflight = undefined;
      }
    };
    pending.then(cleanup, cleanup);
    return pending;
  }

  function resetDiscoveryForTests(): void {
    inflight = undefined;
    snapshot = undefined;
  }

  return {
    discoverModels,
    selectableModelIds,
    prefetchModels,
    resetDiscoveryForTests,
  };
}
