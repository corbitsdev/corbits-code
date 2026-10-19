import { describe, test, expect } from "bun:test";
import type { AuthorizeFn } from "@intx/agent";
import type { AuthzCallResult } from "@intx/inference";
import { defined } from "../../testkit/defined.js";
import {
  collectToolPlugins,
  isToolPluginActive,
  resolveToolPlugins,
  type ToolPluginCandidate,
} from "./tool-plugins.js";
import type { PluginModule } from "./loader.js";

function authzResult(
  effect: AuthzCallResult["effect"],
  reason?: string,
): AuthzCallResult {
  return {
    effect,
    matchingGrants: [],
    resolvedBy: null,
    ...(reason !== undefined ? { reason } : {}),
  };
}

function authorizingCandidate(
  id: string,
  authorize: AuthorizeFn,
): ToolPluginCandidate {
  return {
    id,
    name: id,
    credentials: [],
    factory: () => ({ authorize }),
  };
}

function toolModule(id: string): PluginModule {
  return {
    manifest: {
      id,
      name: id,
      kind: "tool",
      credentials: [{ key: "apiKey", label: "Key", secret: true }],
    },
    createToolPlugin: ((opts: { apiKey?: string }) => ({
      tools: [
        {
          definition: {
            name: `${id}_tool`,
            description: "d",
            inputSchema: { type: "object", properties: {} },
          },
          handler: async () => ({ callId: "c", content: opts.apiKey ?? "" }),
        },
      ],
    })) as unknown,
  };
}

describe("collectToolPlugins", () => {
  test("keeps only tool-kind modules with a factory", () => {
    const mods: PluginModule[] = [
      toolModule("t1"),
      {
        manifest: { id: "w", name: "w", kind: "web" },
        createWebProvider: (() => ({})) as unknown,
      },
      { manifest: { id: "broken", name: "b", kind: "tool" } }, // no factory
    ];
    expect(collectToolPlugins(mods).map((c) => c.id)).toEqual(["t1"]);
  });
});

describe("isToolPluginActive", () => {
  test("requires both enabled and consented", () => {
    expect(
      isToolPluginActive({ t: { enabled: true, consented: true } }, "t"),
    ).toBe(true);
    expect(isToolPluginActive({ t: { enabled: true } }, "t")).toBe(false);
    expect(isToolPluginActive({ t: { consented: true } }, "t")).toBe(false);
    expect(isToolPluginActive({}, "t")).toBe(false);
  });
});

describe("resolveToolPlugins", () => {
  test("instantiates only enabled+consented plugins with their credentials", async () => {
    const candidates = collectToolPlugins([toolModule("t1"), toolModule("t2")]);
    const resolved = await resolveToolPlugins({
      candidates,
      pluginConfig: {
        t1: { enabled: true, consented: true, credentials: { apiKey: "k1" } },
        t2: { enabled: true },
      },
    });
    expect(resolved.plugins.length).toBe(1);
    expect(
      defined(defined(defined(resolved.plugins[0]).tools)[0]).definition.name,
    ).toBe("t1_tool");
    expect(Object.hasOwn(resolved, "authorize")).toBe(false);
  });

  test("a throwing factory is skipped, not fatal", async () => {
    const candidates: ToolPluginCandidate[] = [
      {
        id: "bad",
        name: "bad",
        credentials: [],
        factory: () => {
          throw new Error("boom");
        },
      },
    ];
    const resolved = await resolveToolPlugins({
      candidates,
      pluginConfig: { bad: { enabled: true, consented: true } },
    });
    expect(resolved).toEqual({ plugins: [] });
  });

  test("materializes authorize once before registering a plugin", async () => {
    let authorizeReads = 0;
    const failedPlugin = {
      tools: [],
      get authorize() {
        authorizeReads += 1;
        if (authorizeReads === 1) return async () => authzResult("deny");
        throw new Error("accessor failed");
      },
    };
    const laterPlugin = {
      tools: [],
      authorize: async () => authzResult("allow"),
    };
    const diagnostics = { warnings: [] as string[] };
    const resolved = await resolveToolPlugins({
      candidates: [
        {
          id: "failed",
          name: "failed",
          credentials: [],
          factory: () => failedPlugin,
        },
        {
          id: "later",
          name: "later",
          credentials: [],
          factory: () => laterPlugin,
        },
      ],
      pluginConfig: {
        failed: { enabled: true, consented: true },
        later: { enabled: true, consented: true },
      },
      diagnostics,
    });

    expect(authorizeReads).toBe(1);
    expect(resolved.plugins).toEqual([failedPlugin, laterPlugin]);
    expect(await defined(resolved.authorize)("tool:x", "invoke", {})).toEqual(
      authzResult("deny"),
    );
    expect(diagnostics.warnings).toEqual([]);
  });

  test("an authorize accessor failure excludes the whole plugin", async () => {
    let authorizeReads = 0;
    let disposeCalls = 0;
    const failedPlugin = Object.defineProperty(
      {
        tools: [],
        async dispose() {
          disposeCalls += 1;
        },
      },
      "authorize",
      {
        get() {
          authorizeReads += 1;
          throw new Error("token=accessor-secret-value-123456789");
        },
      },
    );
    const laterPlugin = {
      tools: [],
      authorize: async () => authzResult("allow"),
    };
    const diagnostics = { warnings: [] as string[] };
    const resolved = await resolveToolPlugins({
      candidates: [
        {
          id: "failed",
          name: "failed",
          credentials: [],
          factory: () => failedPlugin,
        },
        {
          id: "later",
          name: "later",
          credentials: [],
          factory: () => laterPlugin,
        },
      ],
      pluginConfig: {
        failed: { enabled: true, consented: true },
        later: { enabled: true, consented: true },
      },
      diagnostics,
    });

    expect(authorizeReads).toBe(1);
    expect(disposeCalls).toBe(1);
    expect(resolved.plugins).toEqual([laterPlugin]);
    expect(await defined(resolved.authorize)("tool:x", "invoke", {})).toEqual(
      authzResult("allow"),
    );
    expect(diagnostics.warnings).toHaveLength(1);
    expect(defined(diagnostics.warnings[0])).not.toContain(
      "accessor-secret-value-123456789",
    );
  });

  test("a rejected plugin cleanup failure is reported without hiding startup failure", async () => {
    let disposeCalls = 0;
    const cleanupFailure = Object.defineProperty(new Error("safe"), "message", {
      value: {
        [Symbol.toPrimitive]() {
          throw new Error("token=cleanup-secret-value-123456789");
        },
      },
    });
    const rejectedPlugin = Object.defineProperty(
      {
        tools: [],
        async dispose() {
          disposeCalls += 1;
          throw cleanupFailure;
        },
      },
      "authorize",
      {
        get() {
          throw new Error("token=startup-secret-value-123456789");
        },
      },
    );
    const laterPlugin = { tools: [] };
    const diagnostics = { warnings: [] as string[] };
    const resolved = await resolveToolPlugins({
      candidates: [
        {
          id: "rejected",
          name: "rejected",
          credentials: [],
          factory: () => rejectedPlugin,
        },
        {
          id: "later",
          name: "later",
          credentials: [],
          factory: () => laterPlugin,
        },
      ],
      pluginConfig: {
        rejected: { enabled: true, consented: true },
        later: { enabled: true, consented: true },
      },
      diagnostics,
    });

    expect(disposeCalls).toBe(1);
    expect(resolved).toEqual({ plugins: [laterPlugin] });
    expect(diagnostics.warnings).toHaveLength(2);
    expect(defined(diagnostics.warnings[0])).toContain(
      'tool-plugin: failed to start "rejected"',
    );
    expect(defined(diagnostics.warnings[1])).toContain("rejected");
    expect(diagnostics.warnings.join("\n")).not.toContain(
      "startup-secret-value-123456789",
    );
    expect(diagnostics.warnings.join("\n")).not.toContain(
      "cleanup-secret-value-123456789",
    );
  });

  test.each([
    [
      "uncoercible thrown value",
      {
        [Symbol.toPrimitive]() {
          throw new Error("token=factory-secret-value-123456789");
        },
      },
    ],
    [
      "error with an uncoercible message",
      Object.defineProperty(new Error("safe"), "message", {
        value: {
          [Symbol.toPrimitive]() {
            throw new Error("token=factory-secret-value-123456789");
          },
        },
      }),
    ],
  ] as const)("skips a factory throwing an %s", async (_name, hostile) => {
    const laterPlugin = { tools: [] };
    const diagnostics = { warnings: [] as string[] };
    const resolved = await resolveToolPlugins({
      candidates: [
        {
          id: "hostile",
          name: "hostile",
          credentials: [],
          factory: () => {
            throw hostile;
          },
        },
        {
          id: "later",
          name: "later",
          credentials: [],
          factory: () => laterPlugin,
        },
      ],
      pluginConfig: {
        hostile: { enabled: true, consented: true },
        later: { enabled: true, consented: true },
      },
      diagnostics,
    });

    expect(resolved).toEqual({ plugins: [laterPlugin] });
    expect(diagnostics.warnings).toHaveLength(1);
    expect(defined(diagnostics.warnings[0])).toContain(
      'tool-plugin: failed to start "hostile"',
    );
    expect(defined(diagnostics.warnings[0])).not.toContain(
      "factory-secret-value-123456789",
    );
  });

  test("composes authorizers in candidate order with conservative effects", async () => {
    const calls: { id: string; args: unknown[] }[] = [];
    const candidate = (
      id: string,
      result: AuthzCallResult,
    ): ToolPluginCandidate =>
      authorizingCandidate(id, async (...args) => {
        calls.push({ id, args });
        return result;
      });
    const context = { id: "call-1", name: "read", arguments: { path: "x" } };
    const resolved = await resolveToolPlugins({
      candidates: [
        candidate("allow", authzResult("allow", "first allow")),
        candidate("ask", authzResult("ask", "first ask")),
        candidate("later-allow", authzResult("allow", "later allow")),
        candidate("deny", authzResult("deny", "first deny")),
        candidate("unreached", authzResult(null, "later block")),
      ],
      pluginConfig: {
        allow: { enabled: true, consented: true },
        ask: { enabled: true, consented: true },
        "later-allow": { enabled: true, consented: true },
        deny: { enabled: true, consented: true },
        unreached: { enabled: true, consented: true },
      },
    });

    expect(resolved.authorize).toBeDefined();
    expect(
      await defined(resolved.authorize)("tool:read", "invoke", context),
    ).toEqual(authzResult("deny", "first deny"));
    expect(calls).toEqual([
      { id: "allow", args: ["tool:read", "invoke", context] },
      { id: "ask", args: ["tool:read", "invoke", context] },
      { id: "later-allow", args: ["tool:read", "invoke", context] },
      { id: "deny", args: ["tool:read", "invoke", context] },
    ]);
  });

  test("preserves the first result at the strongest effect", async () => {
    const resolved = await resolveToolPlugins({
      candidates: [
        authorizingCandidate("first", async () =>
          authzResult("ask", "first ask"),
        ),
        authorizingCandidate("second", async () =>
          authzResult("ask", "second ask"),
        ),
        authorizingCandidate("allow", async () => authzResult("allow")),
      ],
      pluginConfig: {
        first: { enabled: true, consented: true },
        second: { enabled: true, consented: true },
        allow: { enabled: true, consented: true },
      },
    });

    expect(await defined(resolved.authorize)("tool:x", "invoke", {})).toEqual(
      authzResult("ask", "first ask"),
    );
  });

  test("treats null as a blocking effect", async () => {
    let laterInvoked = false;
    const resolved = await resolveToolPlugins({
      candidates: [
        authorizingCandidate("ask", async () => authzResult("ask")),
        authorizingCandidate("null", async () =>
          authzResult(null, "no matching grant"),
        ),
        authorizingCandidate("unreached", async () => {
          laterInvoked = true;
          return authzResult("deny");
        }),
      ],
      pluginConfig: {
        ask: { enabled: true, consented: true },
        null: { enabled: true, consented: true },
        unreached: { enabled: true, consented: true },
      },
    });

    expect(await defined(resolved.authorize)("tool:x", "invoke", {})).toEqual(
      authzResult(null, "no matching grant"),
    );
    expect(laterInvoked).toBe(false);
  });

  test("fails closed without exposing a thrown exception as a deny reason", async () => {
    const resolved = await resolveToolPlugins({
      candidates: [
        authorizingCandidate("guard", async () => {
          throw new Error("token=secret-value-123456789");
        }),
      ],
      pluginConfig: { guard: { enabled: true, consented: true } },
    });

    const result = await defined(resolved.authorize)("tool:x", "invoke", {});
    expect(result.effect).toBe("deny");
    expect(result).not.toHaveProperty("reason");
  });

  test("a malformed result after allow fails closed and stops composition", async () => {
    let laterInvoked = false;
    const resolved = await resolveToolPlugins({
      candidates: [
        authorizingCandidate("allow", async () => authzResult("allow")),
        authorizingCandidate("malformed", (async () => ({
          effect: "allow",
        })) as unknown as AuthorizeFn),
        authorizingCandidate("unreached", async () => {
          laterInvoked = true;
          return authzResult("deny", "unreached");
        }),
      ],
      pluginConfig: {
        allow: { enabled: true, consented: true },
        malformed: { enabled: true, consented: true },
        unreached: { enabled: true, consented: true },
      },
    });

    expect(await defined(resolved.authorize)("tool:x", "invoke", {})).toEqual(
      authzResult("deny"),
    );
    expect(laterInvoked).toBe(false);
  });

  test.each([
    [
      "missing matchingGrants after ask",
      authzResult("ask"),
      { effect: "allow", resolvedBy: null },
    ],
    [
      "non-array matchingGrants after allow",
      authzResult("allow"),
      { effect: "ask", matchingGrants: {}, resolvedBy: null },
    ],
  ] as const)("%s fails closed", async (_name, first, malformed) => {
    const resolved = await resolveToolPlugins({
      candidates: [
        authorizingCandidate("first", async () => first),
        authorizingCandidate(
          "malformed",
          (async () => malformed) as unknown as AuthorizeFn,
        ),
      ],
      pluginConfig: {
        first: { enabled: true, consented: true },
        malformed: { enabled: true, consented: true },
      },
    });

    expect(await defined(resolved.authorize)("tool:x", "invoke", {})).toEqual(
      authzResult("deny"),
    );
  });

  test("a throwing result getter fails closed without exposing its secret", async () => {
    let laterInvoked = false;
    const malicious = Object.defineProperty(
      { matchingGrants: [], resolvedBy: null },
      "effect",
      {
        get() {
          throw new Error("token=secret-value-123456789");
        },
      },
    );
    const resolved = await resolveToolPlugins({
      candidates: [
        authorizingCandidate(
          "malicious",
          (async () => malicious) as unknown as AuthorizeFn,
        ),
        authorizingCandidate("unreached", async () => {
          laterInvoked = true;
          return authzResult("allow");
        }),
      ],
      pluginConfig: {
        malicious: { enabled: true, consented: true },
        unreached: { enabled: true, consented: true },
      },
    });

    const result = await defined(resolved.authorize)("tool:x", "invoke", {});
    expect(result).toEqual(authzResult("deny"));
    expect(result).not.toHaveProperty("reason");
    expect(laterInvoked).toBe(false);
  });

  test("stateful effect and reason getters are read once", async () => {
    let effectReads = 0;
    let reasonReads = 0;
    const stateful = {
      matchingGrants: [],
      resolvedBy: null,
      get effect() {
        return ++effectReads === 1 ? "deny" : "allow";
      },
      get reason() {
        return ++reasonReads === 1 ? "first deny" : "substituted reason";
      },
    };
    const resolved = await resolveToolPlugins({
      candidates: [
        authorizingCandidate(
          "stateful",
          (async () => stateful) as unknown as AuthorizeFn,
        ),
      ],
      pluginConfig: { stateful: { enabled: true, consented: true } },
    });

    expect(await defined(resolved.authorize)("tool:x", "invoke", {})).toEqual(
      authzResult("deny", "first deny"),
    );
    expect(effectReads).toBe(1);
    expect(reasonReads).toBe(1);
  });

  test.each([
    [
      "uncoercible thrown value",
      {
        [Symbol.toPrimitive]() {
          throw new Error("coercion escaped");
        },
      },
    ],
    [
      "error with an uncoercible message",
      Object.defineProperty(new Error("safe"), "message", {
        value: {
          [Symbol.toPrimitive]() {
            throw new Error("message coercion escaped");
          },
        },
      }),
    ],
  ] as const)("%s fails closed", async (_name, hostile) => {
    const resolved = await resolveToolPlugins({
      candidates: [
        authorizingCandidate("hostile", async () => {
          throw hostile;
        }),
      ],
      pluginConfig: { hostile: { enabled: true, consented: true } },
    });

    expect(await defined(resolved.authorize)("tool:x", "invoke", {})).toEqual(
      authzResult("deny"),
    );
  });
});
