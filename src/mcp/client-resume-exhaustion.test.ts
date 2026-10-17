import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  armResumeExhaustionSignal,
  disarmTransportDeathSignal,
  isStreamableResumeExhausted,
  type LiveHttpTransport,
} from "./client.js";

describe("isStreamableResumeExhausted", () => {
  test.each([
    "Maximum reconnection attempts (1000) exceeded.",
    "Maximum reconnection attempts (1) exceeded.",
    "Maximum reconnection attempts (999999) exceeded.",
  ])("matches the SDK exhaustion copy (%j)", (message) => {
    expect(isStreamableResumeExhausted(new Error(message))).toBe(true);
  });

  test.each([
    ["a transient stream error", new Error("Failed to open SSE stream")],
    ["a reconnect-loop error", new Error("Failed to reconnect SSE stream")],
    [
      "an exhaustion prefix without the tail",
      new Error("Maximum reconnection attempts (1000)"),
    ],
    [
      "an exhaustion copy without the count",
      new Error("Maximum reconnection attempts exceeded."),
    ],
    ["a non-error", "Maximum reconnection attempts (1000) exceeded."],
    ["nothing", undefined],
  ])("rejects %s", (_label, value) => {
    expect(isStreamableResumeExhausted(value)).toBe(false);
  });
});

describe("armResumeExhaustionSignal", () => {
  test("leaves the transport untouched without an owner hook", () => {
    const transport: Pick<{ onerror?: (error: Error) => void }, "onerror"> = {};
    armResumeExhaustionSignal(transport, () => true, undefined);
    expect(transport.onerror).toBeUndefined();
  });

  test("routes exhaustion to the owner hook and keeps the prior handler", () => {
    const seen: string[] = [];
    let disconnects = 0;
    const transport: { onerror?: (error: Error) => void } = {
      onerror: (error) => {
        seen.push(error.message);
      },
    };
    armResumeExhaustionSignal(
      transport,
      () => true,
      () => {
        disconnects += 1;
      },
    );
    transport.onerror?.(
      new Error("Maximum reconnection attempts (1000) exceeded."),
    );
    expect(seen).toEqual(["Maximum reconnection attempts (1000) exceeded."]);
    expect(disconnects).toBe(1);
  });

  test("ignores non-exhaustion transport errors", () => {
    let disconnects = 0;
    const transport: { onerror?: (error: Error) => void } = {};
    armResumeExhaustionSignal(
      transport,
      () => true,
      () => {
        disconnects += 1;
      },
    );
    transport.onerror?.(new Error("Failed to open SSE stream"));
    expect(disconnects).toBe(0);
  });

  test("stays silent for a transport superseded by a recovery redial", () => {
    let disconnects = 0;
    const seen: string[] = [];
    const transport: { onerror?: (error: Error) => void } = {
      onerror: (error) => {
        seen.push(error.message);
      },
    };
    armResumeExhaustionSignal(
      transport,
      () => false,
      () => {
        disconnects += 1;
      },
    );
    transport.onerror?.(
      new Error("Maximum reconnection attempts (1000) exceeded."),
    );
    expect(seen).toEqual(["Maximum reconnection attempts (1000) exceeded."]);
    expect(disconnects).toBe(0);
  });
});

describe("disarmTransportDeathSignal", () => {
  test("keeps protocol onclose and stays silent for the owner", () => {
    let disconnects = 0;
    let protocolCloses = 0;
    const live: LiveHttpTransport = {};
    const transport: {
      onclose?: () => void;
      onerror?: (error: Error) => void;
    } = {
      onclose: () => {
        protocolCloses += 1;
      },
    };
    live.current = transport;
    armResumeExhaustionSignal(
      transport,
      () => live.current === transport && live.disarmed !== true,
      () => {
        disconnects += 1;
      },
    );

    disarmTransportDeathSignal(live);

    live.current?.onclose?.();
    live.current?.onerror?.(
      new Error("Maximum reconnection attempts (1000) exceeded."),
    );
    expect(disconnects).toBe(0);
    expect(protocolCloses).toBe(1);
    expect(live.disarmed).toBe(true);
  });

  test("tolerates an empty handle", () => {
    expect(() => disarmTransportDeathSignal({})).not.toThrow();
  });
});

const RESUME_EXHAUSTED = "Maximum reconnection attempts (1000) exceeded.";

/** Transport that answers initialize and then never completes a request. */
class HungToolsTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  async start(): Promise<void> {
    return undefined;
  }

  async close(): Promise<void> {
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!("method" in message) || !("id" in message)) return;
    if (message.method !== "initialize") return;
    this.onmessage?.({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "hung", version: "0" },
      },
    });
  }
}

describe("resume exhaustion closes in-flight SDK requests", () => {
  test("rejects listTools when the SDK reports resume exhaustion", async () => {
    const client = new Client({ name: "resume-exhaustion", version: "0" });
    const transport = new HungToolsTransport();
    const live: LiveHttpTransport = {};
    let disconnects = 0;
    armResumeExhaustionSignal(
      transport,
      () => live.current === transport && live.disarmed !== true,
      () => {
        disconnects += 1;
        // Owner redial: MCPClient.close disarms, then Protocol.close.
        disarmTransportDeathSignal(live);
        void client.close();
      },
    );
    live.current = transport;
    await client.connect(transport);

    const pending = client.listTools();
    transport.onerror?.(new Error(RESUME_EXHAUSTED));

    const outcome = await Promise.race([
      pending.then(
        () => "resolved" as const,
        (err: unknown) => err,
      ),
      new Promise<"pending">((resolve) => {
        setTimeout(() => resolve("pending"), 500);
      }),
    ]);

    expect(disconnects).toBe(1);
    expect(outcome).not.toBe("pending");
    expect(outcome).not.toBe("resolved");
    expect(outcome).toBeInstanceOf(Error);
    if (!(outcome instanceof Error)) return;
    expect(outcome.message).toBe("MCP error -32000: Connection closed");
    expect("code" in outcome && outcome.code).toBe(-32000);
    expect(client.transport).toBeUndefined();
  });
});
