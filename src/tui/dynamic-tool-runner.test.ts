import { describe, test, expect } from "bun:test";
import type { AgentTool } from "@intx/agent";
import { createDynamicToolRunner } from "./dynamic-tool-runner.js";
import { advertisedTools } from "../agent/tool-search.js";

const stringTool = (name: string, reply: string): AgentTool => ({
  kind: "string",
  definition: {
    name,
    description: name,
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  handler: async () => reply,
});

describe("blind tool dispatch", () => {
  test("a registered-but-unadvertised tool is still callable without a gate", async () => {
    const runner = createDynamicToolRunner([
      stringTool("read_file", "core"),
      stringTool("mcp__acme__do", "blind-result"),
    ]);

    // The on-demand tool is intentionally absent from the advertised wire set,
    // yet dispatch resolves it — this is how tool_search discovery stays usable
    // without growing the cached tools prefix.
    const advertised = advertisedTools(runner.currentDefinitions()).map(
      (d) => d.name,
    );
    expect(advertised).not.toContain("mcp__acme__do");

    const result = await runner.run(
      { id: "1", name: "mcp__acme__do", arguments: {} },
      new AbortController().signal,
    );
    expect(result.content).toBe("blind-result");
    expect(result.isError).toBeUndefined();
  });
});

describe("call gate", () => {
  test("a registered tool off the wire errors toward tool_search", async () => {
    const runner = createDynamicToolRunner([
      stringTool("read_file", "core"),
      stringTool("mcp__acme__do", "blind-result"),
    ]);
    const advertised = new Set(["read_file"]);
    runner.setCallGate((name) => advertised.has(name));

    const result = await runner.run(
      { id: "1", name: "mcp__acme__do", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("mcp__acme__do");
    expect(result.content).toContain("tool_search");
  });

  test("a name absent from the registry still reports unknown tool", async () => {
    const runner = createDynamicToolRunner([stringTool("read_file", "core")]);
    runner.setCallGate(() => true);

    const result = await runner.run(
      { id: "1", name: "mcp__gone__tool", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("unknown tool: mcp__gone__tool");
  });

  test("a gate that later admits the name (activation) dispatches it", async () => {
    const runner = createDynamicToolRunner([
      stringTool("read_file", "core"),
      stringTool("mcp__acme__do", "blind-result"),
    ]);
    const advertised = new Set(["read_file"]);
    runner.setCallGate((name) => advertised.has(name));

    const blocked = await runner.run(
      { id: "1", name: "mcp__acme__do", arguments: {} },
      new AbortController().signal,
    );
    expect(blocked.isError).toBe(true);

    // tool_search promotion grows the wire set; the same call then dispatches.
    advertised.add("mcp__acme__do");
    const result = await runner.run(
      { id: "2", name: "mcp__acme__do", arguments: {} },
      new AbortController().signal,
    );
    expect(result.content).toBe("blind-result");
    expect(result.isError).toBeUndefined();
  });
});

describe("mangled dispatch names", () => {
  const catalog = "mcp__linear__get_release";

  test("strips a leading default. prefix at call time without advertising it", async () => {
    const runner = createDynamicToolRunner([stringTool(catalog, "ok")]);

    expect(runner.currentDefinitions().map((d) => d.name)).toEqual([catalog]);
    expect(runner.currentDefinitions().map((d) => d.name)).not.toContain(
      `default.${catalog}`,
    );

    const result = await runner.run(
      { id: "1", name: `default.${catalog}`, arguments: {} },
      new AbortController().signal,
    );
    expect(result.content).toBe("ok");
    expect(result.isError).toBeUndefined();
  });

  test("resolves a duplicated name.name suffix when both halves match a known tool", async () => {
    const runner = createDynamicToolRunner([stringTool(catalog, "ok")]);

    const result = await runner.run(
      { id: "1", name: `${catalog}.${catalog}`, arguments: {} },
      new AbortController().signal,
    );
    expect(result.content).toBe("ok");
    expect(result.isError).toBeUndefined();
  });

  test("resolves default. plus a duplicated suffix without advertising either alias", async () => {
    const runner = createDynamicToolRunner([stringTool(catalog, "ok")]);
    const names = runner.currentDefinitions().map((d) => d.name);
    expect(names).toEqual([catalog]);
    expect(names).not.toContain(`default.${catalog}`);
    expect(names).not.toContain(`${catalog}.${catalog}`);

    const result = await runner.run(
      {
        id: "1",
        name: `default.${catalog}.${catalog}`,
        arguments: {},
      },
      new AbortController().signal,
    );
    expect(result.content).toBe("ok");
    expect(result.isError).toBeUndefined();
  });

  test("bare default stays unknown", async () => {
    const runner = createDynamicToolRunner([stringTool(catalog, "ok")]);

    const result = await runner.run(
      { id: "1", name: "default", arguments: {} },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("unknown tool: default");
  });

  test("a prefixed name still honors the call gate on the catalog name", async () => {
    const runner = createDynamicToolRunner([
      stringTool("read_file", "core"),
      stringTool(catalog, "ok"),
    ]);
    const advertised = new Set(["read_file"]);
    runner.setCallGate((name) => advertised.has(name));

    const blocked = await runner.run(
      { id: "1", name: `default.${catalog}`, arguments: {} },
      new AbortController().signal,
    );
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain(catalog);
    expect(blocked.content).toContain("tool_search");

    advertised.add(catalog);
    const result = await runner.run(
      { id: "2", name: `default.${catalog}`, arguments: {} },
      new AbortController().signal,
    );
    expect(result.content).toBe("ok");
    expect(result.isError).toBeUndefined();
  });
});

describe("activated-but-unmounted registry miss", () => {
  test("a gate-activated name missing from the registry reports reconnecting, not unknown tool", async () => {
    const runner = createDynamicToolRunner([
      stringTool("read_file", "core"),
      stringTool("mcp__acme__do", "blind-result"),
    ]);
    const activated = new Set(["mcp__acme__do"]);
    runner.setCallGate((name) => name === "read_file" || activated.has(name), {
      isActivated: (name) => activated.has(name),
    });

    // The tool was promoted (gate open) but its server disconnected before the
    // call, so removeTools dropped it from the registry mid-window.
    runner.removeTools(["mcp__acme__do"]);
    const result = await runner.run(
      { id: "1", name: "mcp__acme__do", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("mcp__acme__do");
    expect(result.content).toContain("reconnecting");
    expect(result.content).toContain("Retry the call shortly");
    expect(result.content).not.toBe("unknown tool: mcp__acme__do");
  });

  test("a never-activated miss keeps the exact unknown tool string", async () => {
    const runner = createDynamicToolRunner([stringTool("read_file", "core")]);
    runner.setCallGate((name) => name === "read_file", {
      isActivated: () => false,
    });

    const result = await runner.run(
      { id: "1", name: "mcp__gone__tool", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("unknown tool: mcp__gone__tool");
  });
});

describe("harness namespace prefix", () => {
  test("a default.-prefixed call dispatches the registered bare tool", async () => {
    const runner = createDynamicToolRunner([
      stringTool("read_file", "core"),
      stringTool("mcp__acme__do", "blind-result"),
    ]);
    const advertised = new Set(["read_file", "mcp__acme__do"]);
    runner.setCallGate((name) => advertised.has(name));

    const result = await runner.run(
      { id: "1", name: "default.mcp__acme__do", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("blind-result");
  });

  test("a prefixed miss keeps the exact unknown tool string with the original name", async () => {
    const runner = createDynamicToolRunner([stringTool("read_file", "core")]);
    runner.setCallGate((name) => name === "read_file", {
      isActivated: () => false,
    });

    const result = await runner.run(
      { id: "1", name: "default.mcp__gone__tool", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("unknown tool: default.mcp__gone__tool");
  });

  test("an exact dotted registration wins over the bare suffix (anti-misrouting)", async () => {
    const runner = createDynamicToolRunner([
      stringTool("mcp__acme__do", "bare"),
      stringTool("default.mcp__acme__do", "dotted"),
    ]);
    runner.setCallGate(() => true);

    const result = await runner.run(
      { id: "1", name: "default.mcp__acme__do", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("dotted");
  });

  test("a prefixed miss for an activated-but-unmounted stripped tool reports reconnecting under the original name", async () => {
    const runner = createDynamicToolRunner([
      stringTool("read_file", "core"),
      stringTool("mcp__acme__do", "blind-result"),
    ]);
    const activated = new Set(["mcp__acme__do"]);
    runner.setCallGate((name) => name === "read_file" || activated.has(name), {
      isActivated: (name) => activated.has(name),
    });

    // The server dropped between search and call, so the bare tool left the
    // registry; the model still emits the harness-namespaced form.
    runner.removeTools(["mcp__acme__do"]);
    const result = await runner.run(
      { id: "1", name: "default.mcp__acme__do", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("default.mcp__acme__do");
    expect(result.content).toContain("reconnecting");
    expect(result.content).toContain("Retry the call shortly");
  });

  test("a normalized call rejected by the gate reports the stripped name", async () => {
    const runner = createDynamicToolRunner([
      stringTool("read_file", "core"),
      stringTool("mcp__acme__do", "blind-result"),
    ]);
    runner.setCallGate((name) => name === "read_file");

    const result = await runner.run(
      { id: "1", name: "default.mcp__acme__do", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("mcp__acme__do");
    expect(result.content).toContain("tool_search");
    expect(result.content).not.toContain("default.mcp__acme__do");
  });
});

describe("terminal control stripping", () => {
  test("strips escape sequences from any tool's result, including MCP", async () => {
    const payload = "before\x1b]52;c;ZXZpbA==\x07\x1b[31mred\x1b[0m\x07after";
    const runner = createDynamicToolRunner([
      stringTool("mcp__acme__do", payload),
    ]);

    const result = await runner.run(
      { id: "1", name: "mcp__acme__do", arguments: {} },
      new AbortController().signal,
    );

    expect(result.content).toBe("beforeredafter");
  });
});
