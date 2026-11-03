import { getLogger } from "@intx/log";
import { LOG_NAMESPACE_ROOT } from "../branding.js";
import {
  endpointErrorMessage,
  type ModelsEndpointDiscoveryState,
} from "./models-endpoint.js";

const catalogLogger = getLogger([LOG_NAMESPACE_ROOT, "provider", "catalog"]);

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
  | {
      readonly ok: false;
      readonly message: string;
      readonly transport: boolean;
    }
> {
  const declared = declaredCatalogBytes(response);
  if (declared !== undefined && declared > args.maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, message: args.oversizeMessage, transport: false };
  }

  try {
    const body = response.body;
    if (body === null) {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > args.maxBytes) {
        return { ok: false, message: args.oversizeMessage, transport: false };
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
        return { ok: false, message: args.oversizeMessage, transport: false };
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
    return {
      ok: false,
      message: endpointErrorMessage(error),
      transport: true,
    };
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

  async function readCatalogJson(response: Response): Promise<
    | { readonly ok: true; readonly value: unknown }
    | {
        readonly ok: false;
        readonly message: string;
        readonly transport: boolean;
      }
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
      return {
        ok: false,
        message: endpointErrorMessage(error),
        transport: false,
      };
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
      // A connection that drops or times out mid-body never delivered an
      // answer; only a body that arrived and fails the contract is malformed.
      return {
        status: body.transport ? "unavailable" : "malformed",
        message: body.message,
      };
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
    } else {
      logFallback(state);
    }
    return selectableModelIds();
  }

  // An unreachable catalog is routine (offline, transient outage), so it
  // stays at debug. An empty or malformed answer means the endpoint's
  // contract moved, which only shows up here, so it warns.
  function logFallback(
    state: Exclude<CatalogDiscoveryState, { status: "models" }>,
  ): void {
    const fallback =
      snapshot === undefined ? "the built-in list" : "the last live list";
    // HTTP and size failures already name the catalog; transport and parse
    // errors do not, so the catalog is named exactly once either way.
    const reason = (message: string): string =>
      message.startsWith(catalogLabel)
        ? message
        : `${catalogLabel}: ${message}`;
    switch (state.status) {
      case "unavailable":
        catalogLogger.debug(
          "Model catalog unavailable ({reason}); keeping {fallback}",
          { reason: reason(state.message), fallback },
        );
        return;
      case "empty":
        catalogLogger.warn(
          "Model catalog listed no models ({catalog}); keeping {fallback}",
          { catalog: catalogLabel, fallback },
        );
        return;
      case "malformed":
        catalogLogger.warn(
          "Model catalog response rejected ({reason}); keeping {fallback}",
          { reason: reason(state.message), fallback },
        );
        return;
    }
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
