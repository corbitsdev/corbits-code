import { type } from "arktype";

import { requestModelsEndpoint } from "./models-endpoint.js";

const CatalogModelsResponse = type({
  data: type({ id: "string" }).array(),
});

export type CatalogDiscoveryState =
  | { readonly status: "models"; readonly models: readonly string[] }
  | { readonly status: "empty" }
  | { readonly status: "unavailable"; readonly message: string }
  | { readonly status: "malformed"; readonly message: string };

function catalogErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
    return { ok: false, message: catalogErrorMessage(error) };
  }
}

export function createBoundedModelCatalog(args: {
  baseURL: string;
  seedIds: readonly string[];
  catalogLabel: string;
  maxBytes: number;
  maxModels: number;
}): {
  discoverModels: (args?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }) => Promise<CatalogDiscoveryState>;
  selectableModelIds: () => readonly string[];
  prefetchModels: () => Promise<readonly string[]>;
  resetDiscoveryForTests: () => void;
} {
  const { baseURL, seedIds, catalogLabel, maxBytes, maxModels } = args;

  let inflight: Promise<readonly string[]> | undefined;
  let snapshot: readonly string[] | undefined;

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
      return { ok: false, message: catalogErrorMessage(error) };
    }
  }

  async function discoverModels(args?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<CatalogDiscoveryState> {
    let response: Response;
    try {
      response = await requestModelsEndpoint({
        baseURL,
        ...(args?.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        ...(args?.signal !== undefined ? { signal: args.signal } : {}),
      });
    } catch (error) {
      return {
        status: "unavailable",
        message: catalogErrorMessage(error),
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
    const parsed = CatalogModelsResponse(body.value);
    if (parsed instanceof type.errors) {
      return { status: "malformed", message: parsed.summary };
    }
    if (parsed.data.length > maxModels) {
      return { status: "malformed", message: oversizeMessage("models") };
    }
    const models = [
      ...new Set(
        parsed.data.map(({ id }) => id.trim()).filter((id) => id.length > 0),
      ),
    ];
    return models.length > 0
      ? { status: "models", models }
      : { status: "empty" };
  }

  function selectableModelIds(): readonly string[] {
    return snapshot ?? seedIds;
  }

  async function runPrefetch(): Promise<readonly string[]> {
    const state = await discoverModels();
    // Empty/unavailable/malformed leave a successful snapshot in place:
    // stale-but-live beats empty, and a cold failure still falls through
    // to the packaged seed.
    if (state.status === "models") {
      snapshot = state.models;
    }
    return selectableModelIds();
  }

  function prefetchModels(): Promise<readonly string[]> {
    if (inflight !== undefined) return inflight;

    const pending = runPrefetch();
    inflight = pending;
    // Clear inflight on settle so a later prefetch can recover instead of
    // replaying the first settlement forever. .then(cleanup, cleanup)
    // instead of .finally() avoids an abandoned promise chain whose
    // pass-through rejection could become an unhandled rejection — callers
    // await the original pending promise.
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
