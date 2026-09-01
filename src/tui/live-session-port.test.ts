import { describe, expect, test } from "bun:test";
import { createLiveSessionPort } from "./live-session-port";
import type { PendingImageAttachment } from "./image-attachments.js";
import type { QueueItem, QueueKind } from "./session-queue";

type Call =
  | { op: "send"; text: string }
  | { op: "interrupt" }
  | { op: "deliver"; text: string; kind: QueueKind };

function fakeDeps() {
  const calls: Call[] = [];
  const deps = {
    send: (text: string) => {
      calls.push({ op: "send", text });
    },
    interrupt: () => {
      calls.push({ op: "interrupt" });
    },
    deliver: (text: string, kind: QueueKind) => {
      calls.push({ op: "deliver", text, kind });
    },
  };
  return { calls, deps };
}

function item(text: string, kind: QueueKind, id = "q1"): QueueItem {
  return { id, text, kind, enqueuedAt: 0 };
}

describe("createLiveSessionPort", () => {
  test("classifySubmit defaults to agent and forwards an override", () => {
    const { deps } = fakeDeps();
    const defaultPort = createLiveSessionPort(deps);
    expect(defaultPort.classifySubmit?.("hello")).toBe("agent");
    expect(defaultPort.classifySubmit?.("/feedback")).toBe("agent");

    const localPort = createLiveSessionPort({
      ...deps,
      classifySubmit: (text) => (text.startsWith("/") ? "local" : "agent"),
    });
    expect(localPort.classifySubmit?.("/feedback")).toBe("local");
    expect(localPort.classifySubmit?.("hello")).toBe("agent");
  });

  test("sendImmediate forwards to deps.send", () => {
    const { calls, deps } = fakeDeps();
    const port = createLiveSessionPort(deps);
    port.sendImmediate("hello");
    expect(calls).toEqual([{ op: "send", text: "hello" }]);
  });

  test("enqueue does not send or interrupt (shell owns queue)", () => {
    const { calls, deps } = fakeDeps();
    const port = createLiveSessionPort(deps);
    port.enqueue("later", "queue");
    port.enqueue("asap", "steer");
    expect(calls).toEqual([]);
  });

  test("interrupt forwards to deps.interrupt", () => {
    const { calls, deps } = fakeDeps();
    const port = createLiveSessionPort(deps);
    port.interrupt();
    expect(calls).toEqual([{ op: "interrupt" }]);
  });

  test("deliver never calls send for steer or queue", () => {
    const { calls, deps } = fakeDeps();
    const port = createLiveSessionPort(deps);
    port.deliver(item("queued msg", "queue"));
    port.deliver(item("steer msg", "steer", "q2"));
    expect(calls.some((c) => c.op === "send")).toBe(false);
    expect(calls).toEqual([
      { op: "deliver", text: "queued msg", kind: "queue" },
      { op: "deliver", text: "steer msg", kind: "steer" },
    ]);
  });

  test("full wiring: immediate → enqueue → deliver → interrupt", () => {
    const { calls, deps } = fakeDeps();
    const port = createLiveSessionPort(deps);

    port.sendImmediate("start");
    port.enqueue("mid", "queue");
    port.deliver(item("mid", "queue"));
    port.interrupt();

    expect(calls).toEqual([
      { op: "send", text: "start" },
      { op: "deliver", text: "mid", kind: "queue" },
      { op: "interrupt" },
    ]);
  });
});

describe("attachment passthrough", () => {
  const image: PendingImageAttachment = {
    id: "img-1",
    name: "clipboard.png",
    contentType: "image/png",
    data: new Uint8Array([1]),
    contentHash: "hash-1",
  };

  test("sendImmediate forwards attachments to the host send", () => {
    const seen: (readonly PendingImageAttachment[] | undefined)[] = [];
    const port = createLiveSessionPort({
      send: (_text, attachments) => seen.push(attachments),
      interrupt: () => {},
      deliver: () => {},
    });
    port.sendImmediate("look", [image]);
    expect(seen).toEqual([[image]]);
  });

  test("a queued item delivers its attachments at the boundary", () => {
    const seen: (readonly PendingImageAttachment[] | undefined)[] = [];
    const port = createLiveSessionPort({
      send: () => {},
      interrupt: () => {},
      deliver: (_text, _kind, attachments) => seen.push(attachments),
    });
    port.deliver({ ...item("later", "queue"), attachments: [image] });
    expect(seen).toEqual([[image]]);
  });
});
