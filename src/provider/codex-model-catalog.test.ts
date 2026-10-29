import { afterEach, describe, expect, test } from "bun:test";
import { configureSync, getConfig, resetSync } from "@intx/log";

import { defined } from "../../testkit/defined.js";
import { withMockedModule } from "../../testkit/mock-module.js";
import {
  CODEX_CLIENT_VERSION,
  CODEX_DEFAULT_MODELS,
} from "../auth/codex/constants.js";
import type { CodexProfile } from "../auth/codex/store.js";
import type * as CodexSession from "../auth/codex/session.js";
import type * as OAuthStores from "../config/oauth-stores.js";
import { codexProfilesToCatalogEntries } from "../config/codex-providers.js";
import {
  discoverStagedCodexModels,
  prefetchCodexModels,
  resetCodexModelDiscoveryForTests,
  selectableCodexModelIds,
} from "./codex-model-catalog.js";

// GET /codex/models for a Plus account at client_version 0.165.0 on
// 2026-10-28, trimmed to the fields the catalog reads plus two it ignores.
const RECORDED_MODELS = [
  {
    slug: "gpt-6.1-sol",
    visibility: "list",
    priority: 1,
    context_window: 500000,
    minimal_client_version: "0.153.0",
  },
  {
    slug: "gpt-6-astra",
    visibility: "list",
    priority: 2,
    context_window: 272000,
    minimal_client_version: "0.153.0",
  },
  {
    slug: "gpt-6-chat-thinking",
    visibility: "hide",
    priority: 2,
    context_window: 272000,
    minimal_client_version: "0.144.0",
  },
  {
    slug: "gpt-6.1-terra",
    visibility: "list",
    priority: 3,
    context_window: 500000,
    minimal_client_version: "0.153.0",
  },
  {
    slug: "gpt-6-sol",
    visibility: "list",
    priority: 4,
    context_window: 272000,
    minimal_client_version: "0.155.0",
  },
  {
    slug: "gpt-reserve",
    visibility: "hide",
    priority: 4,
    context_window: 272000,
    minimal_client_version: "0.144.0",
  },
  {
    slug: "gpt-6-luna",
    visibility: "list",
    priority: 5,
    context_window: 272000,
    minimal_client_version: "0.155.0",
  },
  {
    slug: "gpt-5.6-sol",
    visibility: "list",
    priority: 6,
    context_window: 272000,
    minimal_client_version: "0.144.0",
  },
  {
    slug: "gpt-5.6-terra",
    visibility: "list",
    priority: 8,
    context_window: 272000,
    minimal_client_version: "0.144.0",
  },
  {
    slug: "gpt-5.6-luna",
    visibility: "list",
    priority: 9,
    context_window: 272000,
    minimal_client_version: "0.144.0",
  },
  {
    slug: "codex-auto-review",
    visibility: "hide",
    priority: 43,
    context_window: 272000,
    minimal_client_version: "0.98.0",
  },
];

const RECORDED_LISTED_IDS = [
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6.1-terra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
];

function profile(name: string, accountId?: string): CodexProfile {
  return {
    name,
    createdAt: 0,
    tokens: {
      access: `stored-${name}`,
      refresh: "r",
      expiresAt: 1,
      ...(accountId !== undefined ? { accountId } : {}),
    },
  };
}

let storedProfiles: CodexProfile[] = [];
let tokenFailure: Error | undefined;
// Simulates a token refresh that learns the account id and writes it back to
// the stored profile.
let accountLearnedOnRefresh: string | undefined;

await withMockedModule(
  import.meta.resolve("../config/oauth-stores.js"),
  (real: typeof OAuthStores) => ({
    ...real,
    listCodexProfiles: async () => storedProfiles,
  }),
);
await withMockedModule(
  import.meta.resolve("../auth/codex/session.js"),
  (real: typeof CodexSession) => ({
    ...real,
    getValidCodexToken: async (name: string) => {
      if (tokenFailure !== undefined) throw tokenFailure;
      const stored = storedProfiles.find((p) => p.name === name);
      if (stored === undefined) throw new Error(`no profile ${name}`);
      const learned = accountLearnedOnRefresh;
      if (learned !== undefined) {
        storedProfiles = storedProfiles.map((p) =>
          p.name === name ? profile(name, learned) : p,
        );
      }
      return {
        access: `fresh-${name}`,
        accountId: learned ?? stored.tokens.accountId,
      };
    },
  }),
);

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  storedProfiles = [];
  tokenFailure = undefined;
  accountLearnedOnRefresh = undefined;
  resetCodexModelDiscoveryForTests();
});

function serve(
  body: (url: URL, headers: Headers) => Response | Promise<Response>,
): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    body(new URL(String(input)), new Headers(init?.headers))) as typeof fetch;
}

function serveModels(models: unknown): void {
  serve(() => Response.json({ models }));
}

describe("ChatGPT model catalog", () => {
  test("a ChatGPT profile lists the models its account serves, first by priority as default", async () => {
    const work = profile("work", "acct-work");
    storedProfiles = [work];
    serveModels(
      RECORDED_MODELS.filter((m) => m.slug.startsWith("gpt-5.6")).reverse(),
    );

    await prefetchCodexModels();

    const [entry] = codexProfilesToCatalogEntries([work]);
    expect(entry?.models).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(entry?.defaultModel).toBe("gpt-5.6-sol");
  });

  test("the recorded catalog lists its visible models in priority order", async () => {
    const work = profile("work", "acct-work");
    storedProfiles = [work];
    serveModels(RECORDED_MODELS);

    await prefetchCodexModels();

    expect([...selectableCodexModelIds(work)]).toEqual(RECORDED_LISTED_IDS);
  });

  test("an entry that breaks the per-model contract is skipped, not the whole catalog", async () => {
    const work = profile("work", "acct-work");
    storedProfiles = [work];
    serveModels([
      { slug: "gpt-6-sol", visibility: "list", priority: 1 },
      { slug: "gpt-6-luna", visibility: "list" },
      { slug: "gpt-6-astra", visibility: "beta", priority: 2 },
      { slug: "gpt-5.6-sol", visibility: "list", priority: 3 },
    ]);

    await prefetchCodexModels();

    expect(selectableCodexModelIds(work)).toEqual(["gpt-6-sol", "gpt-5.6-sol"]);
  });

  test("asks for the profile's catalog with a fresh token, its account and the pinned client version", async () => {
    const work = profile("work", "acct-work");
    storedProfiles = [work];
    const seen: { url: URL; headers: Headers }[] = [];
    serve((url, headers) => {
      seen.push({ url, headers });
      return Response.json({ models: RECORDED_MODELS });
    });

    await prefetchCodexModels();

    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request?.url.pathname).toBe("/backend-api/codex/models");
    expect(request?.url.searchParams.get("client_version")).toBe(
      CODEX_CLIENT_VERSION,
    );
    expect(request?.headers.get("authorization")).toBe("Bearer fresh-work");
    expect(request?.headers.get("chatgpt-account-id")).toBe("acct-work");
  });

  test("each profile keeps its own account's list", async () => {
    const work = profile("work", "acct-work");
    const home = profile("home", "acct-home");
    storedProfiles = [work, home];
    serve((_url, headers) =>
      Response.json({
        models:
          headers.get("chatgpt-account-id") === "acct-work"
            ? [{ slug: "gpt-6-sol", visibility: "list", priority: 1 }]
            : [{ slug: "gpt-5.6-luna", visibility: "list", priority: 1 }],
      }),
    );

    await prefetchCodexModels();

    expect(selectableCodexModelIds(work)).toEqual(["gpt-6-sol"]);
    expect(selectableCodexModelIds(home)).toEqual(["gpt-5.6-luna"]);
  });

  test("a profile name reconnected to another account does not inherit the old list", async () => {
    storedProfiles = [profile("work", "acct-old")];
    serveModels([{ slug: "gpt-6-sol", visibility: "list", priority: 1 }]);
    await prefetchCodexModels();

    expect(selectableCodexModelIds(profile("work", "acct-new"))).toEqual(
      CODEX_DEFAULT_MODELS,
    );
  });

  test("trims slugs, drops blank ones and keeps a duplicate at its best priority", async () => {
    const work = profile("work", "acct-work");
    storedProfiles = [work];
    serveModels([
      { slug: "gpt-6-luna", visibility: "list", priority: 5 },
      { slug: " gpt-6-sol ", visibility: "list", priority: 2 },
      { slug: "gpt-6-sol", visibility: "list", priority: 1 },
      { slug: "  ", visibility: "list", priority: 0 },
    ]);

    await prefetchCodexModels();

    expect(selectableCodexModelIds(work)).toEqual(["gpt-6-sol", "gpt-6-luna"]);
  });

  test("models with equal priority keep the server's order", async () => {
    const work = profile("work", "acct-work");
    storedProfiles = [work];
    serveModels([
      { slug: "gpt-6-luna", visibility: "list", priority: 1 },
      { slug: "gpt-6-sol", visibility: "list", priority: 1 },
      { slug: "gpt-6.1-sol", visibility: "list", priority: 0 },
    ]);

    await prefetchCodexModels();

    expect(selectableCodexModelIds(work)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-luna",
      "gpt-6-sol",
    ]);
  });

  test("a non-object entry is skipped like any other malformed entry", async () => {
    const work = profile("work", "acct-work");
    storedProfiles = [work];
    serveModels([null, { slug: "gpt-6-sol", visibility: "list", priority: 1 }]);

    await prefetchCodexModels();

    expect(selectableCodexModelIds(work)).toEqual(["gpt-6-sol"]);
  });

  test("a profile whose refresh learns its account keeps the live list", async () => {
    storedProfiles = [profile("legacy")];
    accountLearnedOnRefresh = "acct-legacy";
    serveModels([{ slug: "gpt-6-sol", visibility: "list", priority: 1 }]);

    await prefetchCodexModels();

    const reread = defined(storedProfiles[0]);
    expect(reread.tokens.accountId).toBe("acct-legacy");
    expect(selectableCodexModelIds(reread)).toEqual(["gpt-6-sol"]);
  });

  test("a reconnect whose first fetch fails does not show the previous account's list", async () => {
    storedProfiles = [profile("work", "acct-old")];
    serveModels([{ slug: "gpt-6-sol", visibility: "list", priority: 1 }]);
    await prefetchCodexModels();

    // The profile is listed under the old account, but by the time its token
    // is read the reconnect has stored the new one.
    accountLearnedOnRefresh = "acct-new";
    serve(() => new Response("no", { status: 503 }));
    await prefetchCodexModels();

    expect(selectableCodexModelIds(profile("work", "acct-new"))).toEqual(
      CODEX_DEFAULT_MODELS,
    );
  });

  describe("falls back to the built-in list", () => {
    const work = profile("work", "acct-work");

    const cases: { name: string; arrange: () => void }[] = [
      { name: "before any fetch", arrange: () => undefined },
      {
        name: "when the account lists no models",
        arrange: () => serveModels([]),
      },
      {
        name: "when every entry is hidden",
        arrange: () =>
          serveModels(RECORDED_MODELS.filter((m) => m.visibility === "hide")),
      },
      {
        name: "on an HTTP error",
        arrange: () => serve(() => new Response("no", { status: 401 })),
      },
      {
        name: "when no entry matches the per-model contract",
        arrange: () =>
          serveModels([
            { slug: "gpt-6-sol", visibility: "list", priority: "1" },
            { slug: "gpt-6-luna", visibility: "list", priority: "2" },
          ]),
      },
      {
        name: "when the body is not a model catalog",
        arrange: () => serve(() => Response.json({ data: [] })),
      },
      {
        name: "when the body exceeds the size cap",
        arrange: () =>
          serve(
            () =>
              new Response("{}", {
                status: 200,
                headers: { "Content-Length": String(64 * 1024 * 1024) },
              }),
          ),
      },
      {
        name: "when the token cannot be refreshed",
        arrange: () => {
          tokenFailure = new Error("refresh failed");
          serveModels(RECORDED_MODELS);
        },
      },
    ];

    for (const { name, arrange } of cases) {
      test(name, async () => {
        storedProfiles = [work];
        arrange();
        if (name !== "before any fetch") await prefetchCodexModels();

        expect(selectableCodexModelIds(work)).toEqual(CODEX_DEFAULT_MODELS);
        const [entry] = codexProfilesToCatalogEntries([work]);
        expect(entry?.defaultModel).toBe(CODEX_DEFAULT_MODELS[0]);
      });
    }
  });
});

describe("contract drift", () => {
  test("a catalog whose every entry breaks the per-model contract warns as rejected, not empty", async () => {
    const work = profile("work", "acct-work");
    storedProfiles = [work];
    serveModels([{ slug: "gpt-6-sol", visibility: "list", priority: "1" }]);
    const records: string[] = [];
    const previous = getConfig();
    configureSync({
      reset: true,
      sinks: {
        test: (record) => {
          records.push(record.message.map(String).join(""));
        },
      },
      loggers: [{ category: [], lowestLevel: "debug", sinks: ["test"] }],
    });
    try {
      await prefetchCodexModels();
    } finally {
      if (previous === null) resetSync();
      else configureSync({ ...previous, reset: true });
    }

    const misses = records.filter((text) => text.includes("ChatGPT profile"));
    expect(misses).toHaveLength(1);
    expect(defined(misses[0])).toContain("response rejected");
  });
});

describe("a sign-in not yet saved as a profile", () => {
  const staged = () => ({
    access: "staged-access",
    refresh: "staged-refresh",
    expiresAt: Date.now() + 3_600_000,
    accountId: "acct-new",
  });

  test("asks with the staged token and account and returns the listed models", async () => {
    const seen: Headers[] = [];
    serve((_url, headers) => {
      seen.push(headers);
      return Response.json({
        models: [
          { slug: "gpt-6-sol", visibility: "list", priority: 2 },
          { slug: "gpt-5.6-luna", visibility: "list", priority: 1 },
        ],
      });
    });

    expect(await discoverStagedCodexModels(staged())).toEqual({
      status: "models",
      models: ["gpt-5.6-luna", "gpt-6-sol"],
    });
    expect(seen[0]?.get("authorization")).toBe("Bearer staged-access");
    expect(seen[0]?.get("chatgpt-account-id")).toBe("acct-new");
  });

  test("reports an HTTP failure as unavailable instead of rejecting", async () => {
    serve(() => new Response("no", { status: 500 }));

    expect((await discoverStagedCodexModels(staged())).status).toBe(
      "unavailable",
    );
  });

  test("never fills a stored profile's list", async () => {
    serveModels([{ slug: "gpt-6-sol", visibility: "list", priority: 1 }]);

    await discoverStagedCodexModels(staged());

    expect(
      selectableCodexModelIds({
        name: "default",
        createdAt: 0,
        tokens: staged(),
      }),
    ).toEqual(CODEX_DEFAULT_MODELS);
  });
});
