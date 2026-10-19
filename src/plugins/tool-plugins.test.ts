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

  test("fails closed with a scrubbed plugin-attributed reason", async () => {
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
    expect(result.reason).toContain('tool-plugin "guard" authorization failed');
    expect(result.reason).toContain("[REDACTED]");
    expect(result.reason).not.toContain("secret-value-123456789");
  });
});
