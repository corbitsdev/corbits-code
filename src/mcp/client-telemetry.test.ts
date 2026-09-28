import { beforeEach, describe, expect, test } from "bun:test";
import { NOOP_TELEMETRY, type Telemetry } from "../telemetry/index.js";
import { withMockedModule } from "../../tests/helpers/mock-module.js";

let connectCalls = 0;
let failOnCall = -1;
const connectError = new Error("spawn ENOENT");

await withMockedModule(
  import.meta.resolve("@modelcontextprotocol/sdk/client/index.js"),
  (real: typeof import("@modelcontextprotocol/sdk/client/index.js")) => ({
    ...real,
    Client: class {
      async connect(): Promise<void> {
        connectCalls += 1;
        if (connectCalls === failOnCall) throw connectError;
      }
      async listTools(): Promise<{ tools: [] }> {
        return { tools: [] };
      }
      async close(): Promise<void> {
        return undefined;
      }
    },
  }),
);

const { connectMCPServers, connectMCPServer } = await import("./client.js");

function recordingTelemetry(events: Record<string, unknown>[]): Telemetry {
  return {
    enabled: true,
    installationId: "test",
    capture: (event, properties) => {
      if (event === "mcp_connect") events.push({ ...(properties ?? {}) });
    },
    captureIntentional: () => false,
    flush: async () => undefined,
    discard: () => undefined,
  };
}

describe("connectMCPServers telemetry", () => {
  beforeEach(() => {
    connectCalls = 0;
    failOnCall = -1;
  });

  test("a mixed multi-config run emits exactly one mcp_connect per config", async () => {
    failOnCall = 2;
    const events: Record<string, unknown>[] = [];
    const warnings: string[] = [];
    const clients = await connectMCPServers(
      [
        { name: "a", type: "stdio", command: "test-server-a" },
        { name: "b", type: "stdio", command: "test-server-b" },
      ],
      (message) => warnings.push(message),
      { telemetry: recordingTelemetry(events) },
    );
    try {
      expect(clients).toHaveLength(1);
      expect(warnings).toHaveLength(1);
      expect(events).toHaveLength(2);
      // Order-insensitive: the batch fans out over Promise.all, and each
      // singular connect captures its own event on completion, so arrival
      // order follows settle order, not config order.
      expect(events.map((event) => event.transport).sort()).toEqual([
        "stdio",
        "stdio",
      ]);
      expect(events.map((event) => event.result).sort()).toEqual([
        "fail",
        "ok",
      ]);
    } finally {
      for (const client of clients) await client.close();
    }
  });

  test("omitted telemetry stays silent on the dropping default", async () => {
    // The omitted path routes capture calls into NOOP_TELEMETRY, whose
    // capture drops everything — the gate lives in the Telemetry handle,
    // not at the call site. This keeper pins that contract: the default
    // handle is disabled, and connecting without telemetry resolves
    // normally with nothing to flush or send.
    expect(NOOP_TELEMETRY.enabled).toBe(false);
    const warnings: string[] = [];
    const clients = await connectMCPServers(
      [{ name: "a", type: "stdio", command: "test-server-a" }],
      (message) => warnings.push(message),
    );
    try {
      expect(clients).toHaveLength(1);
      expect(warnings).toHaveLength(0);
    } finally {
      for (const client of clients) await client.close();
    }
  });
});

describe("connectMCPServer telemetry", () => {
  beforeEach(() => {
    connectCalls = 0;
    failOnCall = -1;
  });

  test("singular ok + fail emits one mcp_connect each, exactly once per attempt", async () => {
    const events: Record<string, unknown>[] = [];
    const telemetry = recordingTelemetry(events);
    const ok = await connectMCPServer(
      { name: "a", type: "stdio", command: "test-server-a" },
      { telemetry },
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) await ok.client.close();
    failOnCall = 2;
    const failed = await connectMCPServer(
      { name: "b", type: "stdio", command: "test-server-b" },
      { telemetry },
    );
    expect(failed.ok).toBe(false);
    expect(connectCalls).toBe(2);
    expect(events).toHaveLength(connectCalls);
    expect(events.map((event) => event.transport)).toEqual(["stdio", "stdio"]);
    expect(events.map((event) => event.result)).toEqual(["ok", "fail"]);
  });
});
