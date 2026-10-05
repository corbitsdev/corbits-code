import { describe, expect, test } from "bun:test";
import { composeMiddleware } from "@intx/tools-posix";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { buildCorePosixToolPlugins } from "../agent/posix-tool-plugins.js";
import { createPermissionGate } from "../permission/gate.js";
import type { PluginModule } from "./loader.js";
import {
  applyAfterToolHooks,
  applyBeforeModelHooks,
  applyBeforePromptHooks,
  collectInterceptHooks,
  interceptHookPlugin,
  normalizeInterceptHooks,
} from "./intercept-hooks.js";

const signal = (): AbortSignal => new AbortController().signal;

const call = (overrides: Partial<ToolCall> = {}): ToolCall => ({
  id: "call-1",
  name: "read_file",
  arguments: { path: "src/index.ts" },
  ...overrides,
});

const okResult = (callId = "call-1", content = "base-ok"): ToolResult => ({
  callId,
  content,
});

function warnings() {
  const messages: string[] = [];
  return {
    messages,
    onWarning: (msg: string): void => {
      messages.push(msg);
    },
  };
}

function baseHandler(seen: ToolCall[]) {
  return async (c: ToolCall): Promise<ToolResult> => {
    seen.push(c);
    return okResult(c.id);
  };
}

describe("applyBeforePromptHooks", () => {
  test("threads prompt replacements in order (sync and async)", async () => {
    const result = await applyBeforePromptHooks(
      [
        ({ prompt }) => ({ prompt: `${prompt} [a]` }),
        async ({ prompt }) => ({ prompt: `${prompt}[b]` }),
        () => undefined,
      ],
      "hello",
    );
    expect(result).toBe("hello [a][b]");
  });

  test("a throwing hook is reported and skipped", async () => {
    const sink = warnings();
    const result = await applyBeforePromptHooks(
      [
        () => {
          throw new Error("boom");
        },
        ({ prompt }) => ({ prompt: `${prompt}!` }),
      ],
      "hello",
      sink,
    );
    expect(result).toBe("hello!");
    expect(sink.messages).toHaveLength(1);
    expect(sink.messages[0]).toMatch(/beforePrompt hook 0 failed/);
  });
});

describe("interceptHookPlugin middleware", () => {
  test("beforeModel skip answers without executing", async () => {
    const seen: ToolCall[] = [];
    const afterSeen: string[] = [];
    const plugin = interceptHookPlugin({
      beforeModel: () => ({ skip: okResult("call-1", "skipped") }),
      afterTool: ({ result }) => {
        afterSeen.push(String(result.content));
        return undefined;
      },
    });
    const handler = plugin.middleware?.(baseHandler(seen)) ?? baseHandler(seen);
    const result = await handler(call(), signal());
    expect(result.content).toBe("skipped");
    expect(seen).toHaveLength(0);
    // Skip results still flow through afterTool for observability.
    expect(afterSeen).toEqual(["skipped"]);
  });

  test("beforeModel call replacement reaches the handler", async () => {
    const seen: ToolCall[] = [];
    const plugin = interceptHookPlugin({
      beforeModel: ({ call: c }) => ({
        call: { ...c, arguments: { path: "src/rewritten.ts" } },
      }),
    });
    const handler = plugin.middleware?.(baseHandler(seen)) ?? baseHandler(seen);
    const result = await handler(call(), signal());
    expect(result.content).toBe("base-ok");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.arguments).toEqual({ path: "src/rewritten.ts" });
  });

  test("afterTool replaces the result", async () => {
    const seen: ToolCall[] = [];
    const plugin = interceptHookPlugin({
      afterTool: ({ result }) => ({
        result: { ...result, content: `${result.content}+annotated` },
      }),
    });
    const handler = plugin.middleware?.(baseHandler(seen)) ?? baseHandler(seen);
    const result = await handler(call(), signal());
    expect(result.content).toBe("base-ok+annotated");
    expect(seen).toHaveLength(1);
  });

  test("hook failure is logged, not thrown; last good value wins", async () => {
    const seen: ToolCall[] = [];
    const sink = warnings();
    const plugin = interceptHookPlugin(
      {
        beforeModel: [
          () => {
            throw new Error("pre-boom");
          },
          ({ call: c }) => ({
            call: { ...c, arguments: { path: "src/kept.ts" } },
          }),
        ],
        afterTool: [
          () => {
            throw new Error("post-boom");
          },
        ],
      },
      sink,
    );
    const handler = plugin.middleware?.(baseHandler(seen)) ?? baseHandler(seen);
    const result = await handler(call(), signal());
    expect(result.content).toBe("base-ok");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.arguments).toEqual({ path: "src/kept.ts" });
    expect(sink.messages).toHaveLength(2);
    expect(sink.messages[0]).toMatch(/beforeModel hook 0 failed/);
    expect(sink.messages[1]).toMatch(/afterTool hook 0 failed/);
  });
});

describe("applyBeforeModelHooks / applyAfterToolHooks", () => {
  test("beforeModel is callable directly with skip short-circuit", async () => {
    const outcome = await applyBeforeModelHooks(
      [() => ({ skip: okResult("call-1", "direct-skip") })],
      call(),
      signal(),
    );
    expect(outcome.skip?.content).toBe("direct-skip");
  });

  test("afterTool is callable directly with replacement", async () => {
    const c = call();
    const outcome = await applyAfterToolHooks(
      [({ result }) => ({ result: { ...result, content: "replaced" } })],
      c,
      okResult(),
      signal(),
    );
    expect(outcome.content).toBe("replaced");
  });
});

describe("collectInterceptHooks", () => {
  test("flattens single and list registrations in order", () => {
    const a = ({ prompt }: { prompt: string }) => ({ prompt: `${prompt}a` });
    const b = ({ prompt }: { prompt: string }) => ({ prompt: `${prompt}b` });
    const modules = [
      { interceptHooks: { beforePrompt: a } },
      { interceptHooks: { beforePrompt: [b] } },
      {},
    ] as PluginModule[];
    const registry = collectInterceptHooks(modules);
    expect(registry.beforePrompt).toEqual([a, b]);
    expect(registry.beforeModel).toEqual([]);
    expect(registry.afterTool).toEqual([]);
  });

  test("metadata-only (untrusted) modules contribute nothing", () => {
    const hook = () => ({ skip: okResult() });
    const modules = [
      { metadataOnly: true, interceptHooks: { beforeModel: hook } },
    ] as PluginModule[];
    const registry = collectInterceptHooks(modules);
    expect(registry.beforeModel).toEqual([]);
  });

  test("normalize accepts a registry as-is", () => {
    const registry = normalizeInterceptHooks({
      beforePrompt: [],
      beforeModel: [],
      afterTool: [],
    });
    expect(registry.beforeModel).toEqual([]);
  });
});

describe("gate still enforced (CL-9888 safety)", () => {
  function stackWithHook(cwd: string, hookCalls: string[]) {
    const gate = createPermissionGate({
      approvals: [],
      interactive: false,
      skipPermissions: false,
      reactorGated: false,
      auto: false,
      cwd,
    });
    const plugins = buildCorePosixToolPlugins({
      cwd,
      permissionGate: gate,
      interceptHooks: {
        beforeModel: ({ call: c }) => {
          hookCalls.push(c.name);
          return undefined;
        },
        afterTool: ({ result }) => ({
          result: { ...result, content: `${result.content}+hook` },
        }),
      },
    });
    const middlewares = plugins.flatMap((p) =>
      p.middleware !== undefined ? [p.middleware] : [],
    );
    return composeMiddleware(middlewares, async (c) => okResult(c.id));
  }

  test("secret-guard denial never reaches hooks", async () => {
    const hookCalls: string[] = [];
    const handler = stackWithHook(process.cwd(), hookCalls);
    const result = await handler(
      {
        id: "deny-1",
        name: "read_file",
        arguments: { path: ".env" },
      },
      signal(),
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/sensitive file blocked/);
    expect(hookCalls).toEqual([]);
    expect(String(result.content)).not.toContain("+hook");
  });

  test("permission-gate denial of a catastrophic shell never reaches hooks", async () => {
    const hookCalls: string[] = [];
    const handler = stackWithHook(process.cwd(), hookCalls);
    const result = await handler(
      {
        id: "deny-2",
        name: "run_shell",
        arguments: { command: "rm -rf /" },
      },
      signal(),
    );
    expect(result.isError).toBe(true);
    expect(hookCalls).toEqual([]);
    expect(String(result.content)).not.toContain("+hook");
  });

  test("an allowed call flows through hooks", async () => {
    const hookCalls: string[] = [];
    const handler = stackWithHook(process.cwd(), hookCalls);
    const result = await handler(
      {
        id: "allow-1",
        name: "read_file",
        arguments: { path: "src/index.ts" },
      },
      signal(),
    );
    expect(hookCalls).toEqual(["read_file"]);
    expect(String(result.content)).toContain("+hook");
  });
});
