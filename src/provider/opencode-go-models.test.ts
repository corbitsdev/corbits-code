import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { OPENCODE_GO_MODEL_IDS } from "../../packages/opencode-go/src/index.js";
import {
  discoverGoModels,
  MAX_GO_CATALOG_BYTES,
  MAX_GO_CATALOG_MODELS,
  prefetchGoModels,
  resetGoModelDiscoveryForTests,
  selectableGoModelIds,
  type GoDiscoveryState,
} from "./opencode-go-models.js";

const originalFetch = globalThis.fetch;
const LIVE_ONLY_ID = "muse-spark-1.2-contributor";
const GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";

beforeEach(() => {
  resetGoModelDiscoveryForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetGoModelDiscoveryForTests();
});

function oversizedCatalogResponse(byteLength: number): Response {
  const chunk = new Uint8Array(64 * 1024).fill(0x61);
  let remaining = byteLength;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }
      const n = Math.min(remaining, chunk.byteLength);
      controller.enqueue(n === chunk.byteLength ? chunk : chunk.subarray(0, n));
      remaining -= n;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("discoverGoModels", () => {
  test("GETs the public models URL without auth and does not write the snapshot", async () => {
    const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(GO_MODELS_URL);
      expect(init?.method).toBe("GET");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBeNull();
      return Response.json({
        data: [{ id: "grok-4.5" }, { id: LIVE_ONLY_ID }],
      });
    };
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(discoverGoModels()).resolves.toEqual({
      status: "models",
      models: ["grok-4.5", LIVE_ONLY_ID],
    });
    expect(selectableGoModelIds()).toEqual(OPENCODE_GO_MODEL_IDS);
    expect(selectableGoModelIds()).not.toContain(LIVE_ONLY_ID);
  });

  test("distinguishes empty, HTTP unavailable, malformed, and transport failures", async () => {
    const cases: {
      response: () => Promise<Response>;
      expected: GoDiscoveryState["status"];
    }[] = [
      { response: async () => Response.json({ data: [] }), expected: "empty" },
      { response: async () => new Response("no", { status: 503 }), expected: "unavailable" },
      { response: async () => Response.json({ models: [] }), expected: "malformed" },
    ];

    for (const item of cases) {
      globalThis.fetch = item.response as unknown as typeof fetch;
      expect((await discoverGoModels()).status).toBe(item.expected);
    }

    globalThis.fetch = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    await expect(discoverGoModels()).resolves.toEqual({
      status: "unavailable",
      message: "OpenCode Go returned HTTP 503",
    });

    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    await expect(discoverGoModels()).resolves.toEqual({
      status: "unavailable",
      message: "connection refused",
    });
  });

  test("rejects an oversized catalog body without treating it as models", async () => {
    globalThis.fetch = (async () =>
      oversizedCatalogResponse(MAX_GO_CATALOG_BYTES + 1)) as unknown as typeof fetch;

    const state = await discoverGoModels();
    expect(state.status).toBe("malformed");
    if (state.status !== "malformed") throw new Error("expected malformed");
    expect(state.message).toContain(String(MAX_GO_CATALOG_BYTES));
    expect(selectableGoModelIds()).toEqual(OPENCODE_GO_MODEL_IDS);
  });

  test("rejects a declared Content-Length over the byte cap without reading the body as models", async () => {
    globalThis.fetch = (async () =>
      new Response('{"data":[{"id":"grok-4.5"}]}', {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(MAX_GO_CATALOG_BYTES + 1),
        },
      })) as unknown as typeof fetch;

    const state = await discoverGoModels();
    expect(state.status).toBe("malformed");
    if (state.status !== "malformed") throw new Error("expected malformed");
    expect(state.message).toContain(String(MAX_GO_CATALOG_BYTES));
    expect(state).not.toEqual({ status: "models", models: ["grok-4.5"] });
  });

  test("rejects a parsed catalog over the model-count cap instead of taking a prefix", async () => {
    const data = Array.from({ length: MAX_GO_CATALOG_MODELS + 1 }, (_, i) => ({
      id: `go-model-${String(i)}`,
    }));
    globalThis.fetch = (async () => Response.json({ data })) as unknown as typeof fetch;

    const state = await discoverGoModels();
    expect(state.status).toBe("malformed");
    if (state.status !== "malformed") throw new Error("expected malformed");
    expect(state.message).toContain(String(MAX_GO_CATALOG_MODELS));
    expect(selectableGoModelIds()).toEqual(OPENCODE_GO_MODEL_IDS);
  });
});

describe("prefetchGoModels", () => {
  test("writes the live snapshot; later selectable reads are sync and skip fetch", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return Response.json({ data: [{ id: "grok-4.5" }, { id: LIVE_ONLY_ID }] });
    }) as unknown as typeof fetch;

    const ids = await prefetchGoModels();
    expect(ids).toEqual(["grok-4.5", LIVE_ONLY_ID]);
    expect(ids).toContain(LIVE_ONLY_ID);
    expect(fetchCount).toBe(1);

    expect(selectableGoModelIds()).toEqual(["grok-4.5", LIVE_ONLY_ID]);
    expect(fetchCount).toBe(1);
  });

  test("keeps the live snapshot when a later prefetch fails", async () => {
    globalThis.fetch = (async () =>
      Response.json({ data: [{ id: LIVE_ONLY_ID }] })) as unknown as typeof fetch;
    await prefetchGoModels();
    expect(selectableGoModelIds()).toEqual([LIVE_ONLY_ID]);

    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const ids = await prefetchGoModels();
    expect(ids).toEqual([LIVE_ONLY_ID]);
    expect(selectableGoModelIds()).toEqual([LIVE_ONLY_ID]);
  });

  test("cold failing prefetch falls back to the packaged seed", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const ids = await prefetchGoModels();
    expect(ids).toEqual(OPENCODE_GO_MODEL_IDS);
    expect(ids.length).toBeGreaterThan(0);
    expect(selectableGoModelIds()).toEqual(OPENCODE_GO_MODEL_IDS);
  });

  test("oversized live catalog does not replace the seed with a truncated prefix", async () => {
    globalThis.fetch = (async () =>
      oversizedCatalogResponse(MAX_GO_CATALOG_BYTES + 1)) as unknown as typeof fetch;

    const ids = await prefetchGoModels();
    expect(ids).toEqual(OPENCODE_GO_MODEL_IDS);
    expect(selectableGoModelIds()).toEqual(OPENCODE_GO_MODEL_IDS);
  });

  test("overlapping prefetches share one GET; a later prefetch may GET again", async () => {
    let fetchCount = 0;
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });

    globalThis.fetch = (async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return held;
      }
      return Response.json({ data: [{ id: LIVE_ONLY_ID }] });
    }) as unknown as typeof fetch;

    const first = prefetchGoModels();
    const second = prefetchGoModels();
    expect(fetchCount).toBe(1);

    release(Response.json({ data: [{ id: LIVE_ONLY_ID }] }));
    await expect(Promise.all([first, second])).resolves.toEqual([[LIVE_ONLY_ID], [LIVE_ONLY_ID]]);
    expect(fetchCount).toBe(1);

    await prefetchGoModels();
    expect(fetchCount).toBe(2);
  });

  test("an aborted discoverGoModels does not coalesce with prefetchGoModels", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCount += 1;
      if (init?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return Response.json({ data: [{ id: LIVE_ONLY_ID }] });
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    controller.abort();
    const [discoverState, prefetched] = await Promise.all([
      discoverGoModels({ signal: controller.signal }),
      prefetchGoModels(),
    ]);

    expect(discoverState.status).toBe("unavailable");
    expect(prefetched).toEqual([LIVE_ONLY_ID]);
    expect(selectableGoModelIds()).toEqual([LIVE_ONLY_ID]);
    expect(fetchCount).toBe(2);
  });
});
