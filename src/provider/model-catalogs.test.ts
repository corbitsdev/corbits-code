import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { OPENCODE_GO_MODEL_IDS } from "../../packages/opencode-go/src/index.js";
import { ZEN_MODEL_IDS } from "../../packages/zen/src/index.js";
import type { CatalogDiscoveryState } from "./bounded-model-catalog.js";
import {
  discoverGoModels,
  discoverZenModels,
  MAX_GO_CATALOG_BYTES,
  MAX_GO_CATALOG_MODELS,
  MAX_ZEN_CATALOG_BYTES,
  MAX_ZEN_CATALOG_MODELS,
  prefetchGoModels,
  prefetchZenModels,
  resetGoModelDiscoveryForTests,
  resetZenModelDiscoveryForTests,
  selectableGoModelIds,
  selectableZenModelIds,
} from "./model-catalogs.js";

const originalFetch = globalThis.fetch;

type CatalogHarness = {
  readonly modelsURL: string;
  readonly catalogLabel: string;
  readonly otherLabel: string;
  readonly seedIds: readonly string[];
  readonly maxBytes: number;
  readonly maxModels: number;
  readonly sampleId: string;
  readonly liveOnlyId: string;
  readonly modelPrefix: string;
  readonly discoverName: string;
  readonly prefetchName: string;
  readonly resetName: string;
  readonly discover: (args?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }) => Promise<CatalogDiscoveryState>;
  readonly selectable: () => readonly string[];
  readonly prefetch: () => Promise<readonly string[]>;
  readonly reset: () => void;
};

const harnesses: readonly CatalogHarness[] = [
  {
    modelsURL: "https://opencode.ai/zen/go/v1/models",
    catalogLabel: "OpenCode Go",
    otherLabel: "OpenCode Zen",
    seedIds: OPENCODE_GO_MODEL_IDS,
    maxBytes: MAX_GO_CATALOG_BYTES,
    maxModels: MAX_GO_CATALOG_MODELS,
    sampleId: "grok-4.5",
    liveOnlyId: "live-only-fixture-model",
    modelPrefix: "go-model-",
    discoverName: "discoverGoModels",
    prefetchName: "prefetchGoModels",
    resetName: "resetGoModelDiscoveryForTests",
    discover: discoverGoModels,
    selectable: selectableGoModelIds,
    prefetch: prefetchGoModels,
    reset: resetGoModelDiscoveryForTests,
  },
  {
    modelsURL: "https://opencode.ai/zen/v1/models",
    catalogLabel: "OpenCode Zen",
    otherLabel: "OpenCode Go",
    seedIds: ZEN_MODEL_IDS,
    maxBytes: MAX_ZEN_CATALOG_BYTES,
    maxModels: MAX_ZEN_CATALOG_MODELS,
    sampleId: "gpt-6-astra",
    liveOnlyId: "live-only-zen-fixture-model",
    modelPrefix: "zen-model-",
    discoverName: "discoverZenModels",
    prefetchName: "prefetchZenModels",
    resetName: "resetZenModelDiscoveryForTests",
    discover: discoverZenModels,
    selectable: selectableZenModelIds,
    prefetch: prefetchZenModels,
    reset: resetZenModelDiscoveryForTests,
  },
];

beforeEach(() => {
  resetGoModelDiscoveryForTests();
  resetZenModelDiscoveryForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetGoModelDiscoveryForTests();
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

for (const harness of harnesses) {
  const {
    catalogLabel,
    discover,
    discoverName,
    liveOnlyId,
    maxBytes,
    maxModels,
    modelPrefix,
    modelsURL,
    otherLabel,
    prefetch,
    prefetchName,
    reset,
    resetName,
    sampleId,
    seedIds,
    selectable,
  } = harness;

  describe(discoverName, () => {
    test("GETs the public models URL without auth and does not write the snapshot", async () => {
      const fetchMock = async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        expect(String(input)).toBe(modelsURL);
        expect(init?.method).toBe("GET");
        const headers = new Headers(init?.headers);
        expect(headers.get("Authorization")).toBeNull();
        return Response.json({
          data: [{ id: sampleId }, { id: liveOnlyId }],
        });
      };
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(discover()).resolves.toEqual({
        status: "models",
        models: [sampleId, liveOnlyId],
      });
      expect(selectable()).toEqual(seedIds);
      expect(selectable()).not.toContain(liveOnlyId);
    });

    test("distinguishes empty, HTTP unavailable, malformed, and transport failures", async () => {
      const cases: {
        response: () => Promise<Response>;
        expected: CatalogDiscoveryState["status"];
      }[] = [
        {
          response: async () => Response.json({ data: [] }),
          expected: "empty",
        },
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
        expect((await discover()).status).toBe(item.expected);
      }

      globalThis.fetch = (async () =>
        new Response("no", { status: 503 })) as unknown as typeof fetch;
      await expect(discover()).resolves.toEqual({
        status: "unavailable",
        message: `${catalogLabel} returned HTTP 503`,
      });

      globalThis.fetch = (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch;
      await expect(discover()).resolves.toEqual({
        status: "unavailable",
        message: "connection refused",
      });
    });

    test(`labels every catalog failure as ${catalogLabel}, never ${otherLabel}`, async () => {
      globalThis.fetch = (async () =>
        new Response("no", { status: 503 })) as unknown as typeof fetch;
      const http = await discover();
      expect(http.status).toBe("unavailable");
      if (http.status !== "unavailable")
        throw new Error("expected unavailable");
      expect(http.message.startsWith(catalogLabel)).toBe(true);
      expect(http.message).not.toContain(otherLabel);

      globalThis.fetch = (async () =>
        oversizedCatalogResponse(maxBytes + 1)) as unknown as typeof fetch;
      const oversize = await discover();
      expect(oversize.status).toBe("malformed");
      if (oversize.status !== "malformed")
        throw new Error("expected malformed");
      expect(oversize.message.startsWith(catalogLabel)).toBe(true);
      expect(oversize.message).not.toContain(otherLabel);
    });

    test("rejects an oversized catalog body without treating it as models", async () => {
      globalThis.fetch = (async () =>
        oversizedCatalogResponse(maxBytes + 1)) as unknown as typeof fetch;

      const state = await discover();
      expect(state.status).toBe("malformed");
      if (state.status !== "malformed") throw new Error("expected malformed");
      expect(state.message).toContain(String(maxBytes));
      expect(selectable()).toEqual(seedIds);
    });

    test("rejects a declared Content-Length over the byte cap without reading the body as models", async () => {
      globalThis.fetch = (async () =>
        new Response(`{"data":[{"id":"${sampleId}"}]}`, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(maxBytes + 1),
          },
        })) as unknown as typeof fetch;

      const state = await discover();
      expect(state.status).toBe("malformed");
      if (state.status !== "malformed") throw new Error("expected malformed");
      expect(state.message).toContain(String(maxBytes));
      expect(state).not.toEqual({ status: "models", models: [sampleId] });
    });

    test("rejects a parsed catalog over the model-count cap instead of taking a prefix", async () => {
      const data = Array.from({ length: maxModels + 1 }, (_, i) => ({
        id: `${modelPrefix}${String(i)}`,
      }));
      globalThis.fetch = (async () =>
        Response.json({ data })) as unknown as typeof fetch;

      const state = await discover();
      expect(state.status).toBe("malformed");
      if (state.status !== "malformed") throw new Error("expected malformed");
      expect(state.message).toContain(String(maxModels));
      expect(selectable()).toEqual(seedIds);
    });
  });

  describe(prefetchName, () => {
    test("writes the live snapshot; later selectable reads are sync and skip fetch", async () => {
      let fetchCount = 0;
      globalThis.fetch = (async () => {
        fetchCount += 1;
        return Response.json({
          data: [{ id: sampleId }, { id: liveOnlyId }],
        });
      }) as unknown as typeof fetch;

      const ids = await prefetch();
      expect(ids).toEqual([sampleId, liveOnlyId]);
      expect(ids).toContain(liveOnlyId);
      expect(fetchCount).toBe(1);

      expect(selectable()).toEqual([sampleId, liveOnlyId]);
      expect(fetchCount).toBe(1);
    });

    test("keeps the live snapshot when a later prefetch fails", async () => {
      globalThis.fetch = (async () =>
        Response.json({
          data: [{ id: liveOnlyId }],
        })) as unknown as typeof fetch;
      await prefetch();
      expect(selectable()).toEqual([liveOnlyId]);

      globalThis.fetch = (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch;
      const ids = await prefetch();
      expect(ids).toEqual([liveOnlyId]);
      expect(selectable()).toEqual([liveOnlyId]);
    });

    test("cold failing prefetch falls back to the packaged seed", async () => {
      globalThis.fetch = (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch;

      const ids = await prefetch();
      expect(ids).toEqual(seedIds);
      expect(ids.length).toBeGreaterThan(0);
      expect(selectable()).toEqual(seedIds);
    });

    test("oversized live catalog does not replace the seed with a truncated prefix", async () => {
      globalThis.fetch = (async () =>
        oversizedCatalogResponse(maxBytes + 1)) as unknown as typeof fetch;

      const ids = await prefetch();
      expect(ids).toEqual(seedIds);
      expect(selectable()).toEqual(seedIds);
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
        return Response.json({ data: [{ id: liveOnlyId }] });
      }) as unknown as typeof fetch;

      const first = prefetch();
      const second = prefetch();
      expect(fetchCount).toBe(1);

      release(Response.json({ data: [{ id: liveOnlyId }] }));
      await expect(Promise.all([first, second])).resolves.toEqual([
        [liveOnlyId],
        [liveOnlyId],
      ]);
      expect(fetchCount).toBe(1);

      await prefetch();
      expect(fetchCount).toBe(2);
    });

    test(`an aborted ${discoverName} does not coalesce with ${prefetchName}`, async () => {
      let fetchCount = 0;
      globalThis.fetch = (async (
        _input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        fetchCount += 1;
        if (init?.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        return Response.json({ data: [{ id: liveOnlyId }] });
      }) as unknown as typeof fetch;

      const controller = new AbortController();
      controller.abort();
      const [discoverState, prefetched] = await Promise.all([
        discover({ signal: controller.signal }),
        prefetch(),
      ]);

      expect(discoverState.status).toBe("unavailable");
      expect(prefetched).toEqual([liveOnlyId]);
      expect(selectable()).toEqual([liveOnlyId]);
      expect(fetchCount).toBe(2);
    });

    test(`${resetName} isolates the snapshot between tests`, async () => {
      globalThis.fetch = (async () =>
        Response.json({
          data: [{ id: liveOnlyId }],
        })) as unknown as typeof fetch;
      await prefetch();
      expect(selectable()).toEqual([liveOnlyId]);

      reset();
      expect(selectable()).toEqual(seedIds);

      globalThis.fetch = (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch;
      expect(await prefetch()).toEqual(seedIds);
    });
  });
}
