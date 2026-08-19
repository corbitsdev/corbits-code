import { describe, expect, test } from "bun:test";

import { createDynamicToolRunner } from "../tui/dynamic-tool-runner.js";
import {
  fallbackLiveToolBundle,
  isLiveToolBundle,
  withLiveToolDispatchMap,
} from "./live-tool-dispatch.js";

const stringTool = (name: string, reply: string) => ({
  kind: "string" as const,
  definition: {
    name,
    description: name,
    inputSchema: { type: "object" as const, properties: {}, required: [] as string[] },
  },
  handler: async () => reply,
});

describe("live tool dispatch fallback", () => {
  test("recognizes a DynamicToolRunner as the live bundle", () => {
    const runner = createDynamicToolRunner([stringTool("tool_search", "ok")]);
    expect(isLiveToolBundle(runner)).toBe(true);
    expect(isLiveToolBundle({ run: () => undefined })).toBe(false);
    expect(isLiveToolBundle(null)).toBe(false);
  });

  test("falls back to the single live bundle and refuses to guess among several", () => {
    const live = createDynamicToolRunner([stringTool("tool_search", "ok")]);
    const other = createDynamicToolRunner([stringTool("present", "no")]);

    const one = new Map<unknown, unknown>([["tool_search", live]]);
    expect(fallbackLiveToolBundle(one)).toBe(live);

    const many = new Map<unknown, unknown>([
      ["tool_search", live],
      ["present", other],
    ]);
    expect(fallbackLiveToolBundle(many)).toBeUndefined();

    const none = new Map<unknown, unknown>([["read_file", { run: () => undefined }]]);
    expect(fallbackLiveToolBundle(none)).toBeUndefined();
  });

  test("Map.get installed for createAgent resolves a late MCP name to the live bundle", () => {
    const runner = createDynamicToolRunner([stringTool("tool_search", "ok")]);

    withLiveToolDispatchMap(() => {
      const byName = new Map<string, unknown>();
      byName.set("tool_search", runner);
      expect(byName.get("tool_search")).toBe(runner);
      expect(byName.get("mcp__linear__list_issues")).toBe(runner);
      expect(byName.get("read_file")).toBe(runner);
    });

    const after = new Map<string, unknown>();
    after.set("tool_search", runner);
    expect(after.get("mcp__linear__list_issues")).toBeUndefined();
  });

  test("restores Map even when the wrapped call throws", () => {
    const before = globalThis.Map;
    expect(() =>
      withLiveToolDispatchMap(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(globalThis.Map).toBe(before);
  });
});
