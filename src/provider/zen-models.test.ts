import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ZEN_MODEL_IDS } from "../../packages/zen/src/index.js";
import {
  discoverZenModels,
  MAX_ZEN_CATALOG_BYTES,
  MAX_ZEN_CATALOG_MODELS,
  prefetchZenModels,
  resetZenModelDiscoveryForTests,
  selectableZenModelIds,
  type ZenDiscoveryState,
} from "./zen-models.js";

const originalFetch = globalThis.fetch;
const LIVE_ONLY_ID = "live-only-zen-fixture-model";
const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";

beforeEach(() => {
  resetZenModelDiscoveryForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetZenModelDiscoveryForTests();
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

describe("discoverZenModels", () => {
  test("GETs the public models URL without auth and does not write the snapshot", async () => {
    const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(ZEN_MODELS_URL);
      expect(init?.method).toBe("GET");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBeNull();
      return Response.json({
        data: [{ id: "gpt-6-astra" }, { id: LIVE_ONLY_ID }],
      });
    };
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(discoverZenModels()).resolves.toEqual({
      status: "models",
      models: ["gpt-6-astra", LIVE_ONLY_ID],
    });
    expect(selectableZenModelIds()).toEqual(ZEN_MODEL_IDS);
    expect(selectableZenModelIds()).not.toContain(LIVE_ONLY_ID);
  });

  test("distinguishes empty, HTTP unavailable, malformed, and transport failures", async () => {
    const cases: {
      response: () => Promise<Response>;
      expected: ZenDiscoveryState["status"];
    }[] = [
      { response: async () => Response.json({ data: [] }), expected: "empty" },
      {
        response: async () => new Response("no", { status: 503 }),
        expected: "unavailable",
      },
      {
        response: async () => Response.json({ models: [] }),
        expected: "malformed",
      },
    ];

    for (const item of cases) {
      globalThis.fetch = item.response as unknown as typeof fetch;
      expect((await discoverZenModels()).status).toBe(item.expected);
    }

    globalThis.fetch = (async () =>
      new Response("no", { status: 503 })) as unknown as typeof fetch;
    await expect(discoverZenModels()).resolves.toEqual({
      status: "unavailable",
      message: "OpenCode Zen returned HTTP 503",
    });

    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    await expect(discoverZenModels()).resolves.toEqual({
      status: "unavailable",
      message: "connection refused",
    });
  });

  test("rejects an oversized catalog body without treating it as models", async () => {
    globalThis.fetch = (async () =>
      oversizedCatalogResponse(
        MAX_ZEN_CATALOG_BYTES + 1,
      )) as unknown as typeof fetch;

    const state = await discoverZenModels();
    expect(state.status).toBe("malformed");
    if (state.status !== "malformed") throw new Error("expected malformed");
    expect(state.message).toContain(String(MAX_ZEN_CATALOG_BYTES));
    expect(selectableZenModelIds()).toEqual(ZEN_MODEL_IDS);
  });

  test("rejects a declared Content-Length over the byte cap without reading the body as models", async () => {
    globalThis.fetch = (async () =>
      new Response('{"data":[{"id":"gpt-6-astra"}]}', {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(MAX_ZEN_CATALOG_BYTES + 1),
        },
      })) as unknown as typeof fetch;

    const state = await discoverZenModels();
    expect(state.status).toBe("malformed");
    if (state.status !== "malformed") throw new Error("expected malformed");
    expect(state.message).toContain(String(MAX_ZEN_CATALOG_BYTES));
    expect(state).not.toEqual({
      status: "models",
      models: ["gpt-6-astra"],
    });
  });

  test("rejects a parsed catalog over the model-count cap instead of taking a prefix", async () => {
    const data = Array.from({ length: MAX_ZEN_CATALOG_MODELS + 1 }, (_, i) => ({
      id: `zen-model-${String(i)}`,
    }));
    globalThis.fetch = (async () =>
      Response.json({ data })) as unknown as typeof fetch;

    const state = await discoverZenModels();
    expect(state.status).toBe("malformed");
    if (state.status !== "malformed") throw new Error("expected malformed");
    expect(state.message).toContain(String(MAX_ZEN_CATALOG_MODELS));
    expect(selectableZenModelIds()).toEqual(ZEN_MODEL_IDS);
  });
});

describe("prefetchZenModels", () => {
  test("writes the live snapshot; later selectable reads are sync and skip fetch", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return Response.json({
        data: [{ id: "gpt-6-astra" }, { id: LIVE_ONLY_ID }],
      });
    }) as unknown as typeof fetch;

    const ids = await prefetchZenModels();
    expect(ids).toEqual(["gpt-6-astra", LIVE_ONLY_ID]);
    expect(ids).toContain(LIVE_ONLY_ID);
    expect(fetchCount).toBe(1);

    expect(selectableZenModelIds()).toEqual(["gpt-6-astra", LIVE_ONLY_ID]);
    expect(fetchCount).toBe(1);
  });

  test("keeps the live snapshot when a later prefetch fails", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        data: [{ id: LIVE_ONLY_ID }],
      })) as unknown as typeof fetch;
    await prefetchZenModels();
    expect(selectableZenModelIds()).toEqual([LIVE_ONLY_ID]);

    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const ids = await prefetchZenModels();
    expect(ids).toEqual([LIVE_ONLY_ID]);
    expect(selectableZenModelIds()).toEqual([LIVE_ONLY_ID]);
  });

  test("cold failing prefetch falls back to the packaged seed", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const ids = await prefetchZenModels();
    expect(ids).toEqual(ZEN_MODEL_IDS);
    expect(ids.length).toBeGreaterThan(0);
    expect(selectableZenModelIds()).toEqual(ZEN_MODEL_IDS);
  });

  test("oversized live catalog does not replace the seed with a truncated prefix", async () => {
    globalThis.fetch = (async () =>
      oversizedCatalogResponse(
        MAX_ZEN_CATALOG_BYTES + 1,
      )) as unknown as typeof fetch;

    const ids = await prefetchZenModels();
    expect(ids).toEqual(ZEN_MODEL_IDS);
    expect(selectableZenModelIds()).toEqual(ZEN_MODEL_IDS);
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

    const first = prefetchZenModels();
    const second = prefetchZenModels();
    expect(fetchCount).toBe(1);

    release(Response.json({ data: [{ id: LIVE_ONLY_ID }] }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      [LIVE_ONLY_ID],
      [LIVE_ONLY_ID],
    ]);
    expect(fetchCount).toBe(1);

    await prefetchZenModels();
    expect(fetchCount).toBe(2);
  });

  test("an aborted discoverZenModels does not coalesce with prefetchZenModels", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      fetchCount += 1;
      if (init?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return Response.json({ data: [{ id: LIVE_ONLY_ID }] });
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    controller.abort();
    const [discoverState, prefetched] = await Promise.all([
      discoverZenModels({ signal: controller.signal }),
      prefetchZenModels(),
    ]);

    expect(discoverState.status).toBe("unavailable");
    expect(prefetched).toEqual([LIVE_ONLY_ID]);
    expect(selectableZenModelIds()).toEqual([LIVE_ONLY_ID]);
    expect(fetchCount).toBe(2);
  });

  test("resetZenModelDiscoveryForTests isolates the snapshot between tests", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        data: [{ id: LIVE_ONLY_ID }],
      })) as unknown as typeof fetch;
    await prefetchZenModels();
    expect(selectableZenModelIds()).toEqual([LIVE_ONLY_ID]);

    resetZenModelDiscoveryForTests();
    expect(selectableZenModelIds()).toEqual(ZEN_MODEL_IDS);

    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    expect(await prefetchZenModels()).toEqual(ZEN_MODEL_IDS);
  });
});
