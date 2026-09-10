import { createBlobReader } from "@intx/types/runtime";
import { describe, expect, test } from "bun:test";
import type { Task } from "../agent/tasks.js";
import { createFleetMailbox } from "./agent-fleet.js";
import {
  buildFleetDryContinuationPrompt,
  collectUncollectedTerminals,
  driveOpenTasksAfterFleetDry,
  FLEET_DRY_CONTINUATION_PREFIX,
  FLEET_DRY_REPORT_CHARS,
  fleetDrySpillKey,
  shouldDriveOpenTasks,
  type FleetDryMailbox,
  type FleetDryMailboxRecord,
} from "./fleet-dry-drive.js";
import { createSubAgentSessionStore } from "./session-store.js";

const openTask: Task = { id: "t1", title: "keep going", status: "todo" };

function peekMailbox(
  records: Map<string, FleetDryMailboxRecord>,
): FleetDryMailbox {
  return {
    ids: () => [...records.keys()],
    peek: (id) => records.get(id),
    take: (id) => records.get(id),
  };
}

function fakeBlobStore() {
  const blobs = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    blobs,
    writeBlob: (key: string, bytes: Uint8Array, contentType: string) => {
      blobs.set(key, { bytes, contentType });
    },
    readBlob: async (key: string) => {
      const entry = blobs.get(key);
      if (entry === undefined) throw new Error(`Blob not found: ${key}`);
      return entry.bytes;
    },
  };
}

function reportsJSONFromPrompt(prompt: string): unknown {
  const header =
    "Collected worker reports (already collected — do not call wait_agents for these agent_ids):\n";
  const start = prompt.indexOf(header);
  expect(start).toBeGreaterThanOrEqual(0);
  const jsonStart = start + header.length;
  const jsonEnd = prompt.indexOf("\n", jsonStart);
  return JSON.parse(
    prompt.slice(jsonStart, jsonEnd === -1 ? undefined : jsonEnd),
  );
}

describe("shouldDriveOpenTasks", () => {
  test("is true only on wentDry && open tasks && !parentProcessing", () => {
    expect(
      shouldDriveOpenTasks({
        previousRunning: 1,
        running: 0,
        hasOpenTasks: true,
        parentProcessing: false,
      }),
    ).toBe(true);
  });

  test("is false for dry+terminal, live+open, parentProcessing, and already-dry", () => {
    expect(
      shouldDriveOpenTasks({
        previousRunning: 1,
        running: 0,
        hasOpenTasks: false,
        parentProcessing: false,
      }),
    ).toBe(false);
    expect(
      shouldDriveOpenTasks({
        previousRunning: 2,
        running: 1,
        hasOpenTasks: true,
        parentProcessing: false,
      }),
    ).toBe(false);
    expect(
      shouldDriveOpenTasks({
        previousRunning: 1,
        running: 0,
        hasOpenTasks: true,
        parentProcessing: true,
      }),
    ).toBe(false);
    expect(
      shouldDriveOpenTasks({
        previousRunning: 0,
        running: 0,
        hasOpenTasks: true,
        parentProcessing: false,
      }),
    ).toBe(false);
  });

  test("deferred dry edge fires once when still dry+open and parent is idle", () => {
    expect(
      shouldDriveOpenTasks({
        previousRunning: 0,
        running: 0,
        hasOpenTasks: true,
        parentProcessing: false,
        deferredDryEdge: true,
      }),
    ).toBe(true);
    expect(
      shouldDriveOpenTasks({
        hasOpenTasks: true,
        parentProcessing: false,
        deferredDryEdge: true,
      }),
    ).toBe(true);
    expect(
      shouldDriveOpenTasks({
        previousRunning: 0,
        running: 0,
        hasOpenTasks: true,
        parentProcessing: true,
        deferredDryEdge: true,
      }),
    ).toBe(false);
    expect(
      shouldDriveOpenTasks({
        previousRunning: 0,
        running: 0,
        hasOpenTasks: false,
        parentProcessing: false,
        deferredDryEdge: true,
      }),
    ).toBe(false);
    expect(
      shouldDriveOpenTasks({
        previousRunning: 0,
        running: 1,
        hasOpenTasks: true,
        parentProcessing: false,
        deferredDryEdge: true,
      }),
    ).toBe(false);
  });
});

describe("buildFleetDryContinuationPrompt", () => {
  test("contains the prefix, open-task ids, and collected JSON", () => {
    const prompt = buildFleetDryContinuationPrompt(
      [openTask, { id: "t2", title: "done already", status: "done" }],
      [
        {
          agent_id: "worker-1",
          status: "done",
          report: "shipped",
          description: "lane",
        },
      ],
    );
    expect(prompt.startsWith(FLEET_DRY_CONTINUATION_PREFIX)).toBe(true);
    expect(prompt).toContain("- t1: keep going (todo)");
    expect(prompt).not.toContain("t2:");
    expect(prompt).toContain("worker-1");
    expect(prompt).toContain("shipped");
    expect(prompt).toContain(
      "already collected — do not call wait_agents for these agent_ids",
    );
  });

  test("empty reports still produce the prefix and an empty JSON array", () => {
    const prompt = buildFleetDryContinuationPrompt([openTask], []);
    expect(prompt.startsWith(FLEET_DRY_CONTINUATION_PREFIX)).toBe(true);
    expect(prompt).toContain("- t1: keep going (todo)");
    expect(prompt).toContain("[]");
  });
});

describe("collectUncollectedTerminals", () => {
  test("take()s terminals and leaves live / awaiting_director / already-collected", async () => {
    const sessions = createSubAgentSessionStore();
    const mailbox = createFleetMailbox(sessions);
    const start = (id: string, description: string) => {
      const session = sessions.start({
        id,
        description,
        agentId: "builder",
        brief: "brief",
      });
      mailbox.register(session.id);
      return session;
    };

    start("live", "still running");
    start("done", "finished lane");
    sessions.complete("done", "worker finished");
    start("fail", "failed lane");
    sessions.fail("fail", "boom");
    start("coll", "already collected");
    sessions.complete("coll", "already taken");
    mailbox.take("coll");
    start("ask", "waiting on director");
    sessions.markRunning("ask");
    expect(
      sessions.registerAsk("ask", {
        question: "which path?",
        questionId: "q1",
        resolve: () => undefined,
        reject: () => undefined,
      }),
    ).toBe(true);

    const reports = await collectUncollectedTerminals(
      mailbox,
      sessions.list(),
      true,
    );
    expect(reports.map((r) => r.agent_id).sort()).toEqual(["done", "fail"]);
    expect(reports.find((r) => r.agent_id === "done")).toEqual({
      agent_id: "done",
      status: "done",
      description: "finished lane",
      report: "worker finished",
    });
    expect(reports.find((r) => r.agent_id === "fail")).toEqual({
      agent_id: "fail",
      status: "failed",
      description: "failed lane",
      error: "boom",
    });
    expect(mailbox.peek("done")?.collected).toBe(true);
    expect(mailbox.peek("fail")?.collected).toBe(true);
    expect(mailbox.peek("live")?.collected).not.toBe(true);
    expect(mailbox.peek("live")?.status).toBe("running");
    expect(mailbox.peek("ask")?.status).toBe("awaiting_director");
    expect(mailbox.peek("ask")?.collected).not.toBe(true);
    expect(mailbox.peek("coll")?.collected).toBe(true);
  });

  test("fills report/error from the session-store lane when the mailbox snapshot is empty", async () => {
    const records = new Map<string, FleetDryMailboxRecord>([
      ["ghost", { status: "done" }],
    ]);
    const mailbox: FleetDryMailbox = {
      ids: () => [...records.keys()],
      peek: (id) => records.get(id),
      take: (id) => {
        const existing = records.get(id);
        if (existing === undefined) return undefined;
        const taken = { ...existing, collected: true };
        records.set(id, taken);
        return taken;
      },
    };
    const reports = await collectUncollectedTerminals(
      mailbox,
      [{ id: "ghost", description: "from store", report: "store report" }],
      true,
    );
    expect(reports).toEqual([
      {
        agent_id: "ghost",
        status: "done",
        description: "from store",
        report: "store report",
      },
    ]);
    expect(records.get("ghost")?.collected).toBe(true);
  });

  test("projects mailbox stopReason as stop_reason", async () => {
    const records = new Map<string, FleetDryMailboxRecord>([
      [
        "w1",
        { status: "interrupted", report: "salvage", stopReason: "interrupted" },
      ],
    ]);
    const mailbox: FleetDryMailbox = {
      ids: () => [...records.keys()],
      peek: (id) => records.get(id),
      take: (id) => records.get(id),
    };
    expect(await collectUncollectedTerminals(mailbox, [], true)).toEqual([
      {
        agent_id: "w1",
        status: "interrupted",
        report: "salvage",
        stop_reason: "interrupted",
      },
    ]);
  });

  test("clips oversized reports with an honest not-retrievable notice when no writer is provided", async () => {
    const original = "x".repeat(FLEET_DRY_REPORT_CHARS + 40);
    const records = new Map<string, FleetDryMailboxRecord>([
      ["big", { status: "done", report: original }],
    ]);
    const reports = await collectUncollectedTerminals(
      peekMailbox(records),
      [],
      true,
    );
    const clipped = reports[0]?.report ?? "";
    expect(clipped.length).toBeLessThanOrEqual(FLEET_DRY_REPORT_CHARS);
    expect(clipped.length).toBeLessThan(original.length);
    expect(clipped).toContain("[output truncated");
    expect(clipped).toContain("NOT retrievable");
    expect(clipped).not.toContain("tool-output:///");
    expect(clipped.endsWith("…") && !clipped.includes("truncated")).toBe(false);
  });

  test("spills oversized reports to a tool-output URI when a writer is provided", async () => {
    const original = `head-${"x".repeat(FLEET_DRY_REPORT_CHARS)}TAIL-MARKER`;
    const records = new Map<string, FleetDryMailboxRecord>([
      ["big", { status: "done", report: original }],
    ]);
    const store = fakeBlobStore();
    const reports = await collectUncollectedTerminals(
      peekMailbox(records),
      [],
      true,
      store.writeBlob,
    );
    const clipped = reports[0]?.report ?? "";
    expect(clipped.length).toBeLessThanOrEqual(FLEET_DRY_REPORT_CHARS);
    expect(clipped).not.toContain("TAIL-MARKER");
    expect(clipped).toContain("[output truncated");
    expect(clipped).not.toContain("NOT retrievable");
    const key = fleetDrySpillKey("big", "report");
    const uri = `tool-output:///${key}`;
    expect(clipped).toContain(uri);
    expect(clipped).toContain("read_file");
    const entry = store.blobs.get(key);
    expect(entry).toBeDefined();
    expect(new TextDecoder().decode(entry?.bytes ?? new Uint8Array())).toBe(
      original,
    );

    const recovered = new TextDecoder().decode(
      await createBlobReader(store).read(uri),
    );
    expect(recovered).toBe(original);

    const parsed = reportsJSONFromPrompt(
      buildFleetDryContinuationPrompt([openTask], reports),
    );
    expect(parsed).toEqual(reports);
  });

  test("leaves under-budget reports unchanged even when a writer is provided", async () => {
    const report = "short enough";
    const records = new Map<string, FleetDryMailboxRecord>([
      ["w1", { status: "done", report }],
    ]);
    const store = fakeBlobStore();
    const reports = await collectUncollectedTerminals(
      peekMailbox(records),
      [],
      true,
      store.writeBlob,
    );
    expect(reports[0]?.report).toBe(report);
    expect(store.blobs.size).toBe(0);
  });

  test("spills oversized error fields under a distinct key", async () => {
    const original = "e".repeat(FLEET_DRY_REPORT_CHARS + 20);
    const records = new Map<string, FleetDryMailboxRecord>([
      ["boom", { status: "failed", error: original }],
    ]);
    const store = fakeBlobStore();
    const reports = await collectUncollectedTerminals(
      peekMailbox(records),
      [],
      true,
      store.writeBlob,
    );
    const clipped = reports[0]?.error ?? "";
    const key = fleetDrySpillKey("boom", "error");
    expect(clipped).toContain(`tool-output:///${key}`);
    expect(store.blobs.has(fleetDrySpillKey("boom", "report"))).toBe(false);
    expect(
      new TextDecoder().decode(store.blobs.get(key)?.bytes ?? new Uint8Array()),
    ).toBe(original);
  });

  test("consume false peeks without take", async () => {
    const records = new Map<string, FleetDryMailboxRecord>([
      ["w1", { status: "done", report: "ok" }],
    ]);
    const mailbox: FleetDryMailbox = {
      ids: () => [...records.keys()],
      peek: (id) => records.get(id),
      take: (id) => {
        const existing = records.get(id);
        if (existing === undefined) return undefined;
        const taken = { ...existing, collected: true };
        records.set(id, taken);
        return taken;
      },
    };
    const reports = await collectUncollectedTerminals(mailbox, [], false);
    expect(reports).toEqual([{ agent_id: "w1", status: "done", report: "ok" }]);
    expect(records.get("w1")?.collected).not.toBe(true);
  });

  test("names a tool-output URI only after an async writeBlob resolves", async () => {
    const original = `head-${"x".repeat(FLEET_DRY_REPORT_CHARS)}TAIL-MARKER`;
    const records = new Map<string, FleetDryMailboxRecord>([
      ["big", { status: "done", report: original }],
    ]);
    const store = fakeBlobStore();
    let resolveWrite: (() => void) | undefined;
    const writeBlob = (key: string, bytes: Uint8Array, contentType: string) =>
      new Promise<void>((resolve) => {
        resolveWrite = () => {
          store.writeBlob(key, bytes, contentType);
          resolve();
        };
      });
    const reportsP = collectUncollectedTerminals(
      peekMailbox(records),
      [],
      true,
      writeBlob,
    );
    let settled = false;
    void reportsP.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(store.blobs.size).toBe(0);
    resolveWrite?.();
    const reports = await reportsP;
    expect(settled).toBe(true);
    const clipped = reports[0]?.report ?? "";
    const key = fleetDrySpillKey("big", "report");
    const uri = `tool-output:///${key}`;
    expect(clipped).toContain(uri);
    expect(clipped).not.toContain("NOT retrievable");
    const recovered = new TextDecoder().decode(
      await createBlobReader(store).read(uri),
    );
    expect(recovered).toBe(original);
  });

  test("rejected writeBlob yields NOT retrievable with no URI and no unhandled rejection", async () => {
    const original = "x".repeat(FLEET_DRY_REPORT_CHARS + 40);
    const records = new Map<string, FleetDryMailboxRecord>([
      ["big", { status: "done", report: original }],
    ]);
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const reports = await collectUncollectedTerminals(
        peekMailbox(records),
        [],
        true,
        async () => {
          throw new Error("disk full");
        },
      );
      await Promise.resolve();
      const clipped = reports[0]?.report ?? "";
      expect(clipped.length).toBeLessThanOrEqual(FLEET_DRY_REPORT_CHARS);
      expect(clipped).toContain("[output truncated");
      expect(clipped).toContain("NOT retrievable");
      expect(clipped).not.toContain("tool-output:///");
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("driveOpenTasksAfterFleetDry", () => {
  test("dry+open collects, begins continuation, then sends", async () => {
    const order: string[] = [];
    const records = new Map<string, FleetDryMailboxRecord>([
      ["w1", { status: "done", report: "ok", description: "lane" }],
    ]);
    const mailbox: FleetDryMailbox = {
      ids: () => [...records.keys()],
      peek: (id) => records.get(id),
      take: (id) => {
        const existing = records.get(id);
        if (existing === undefined) return undefined;
        const taken = { ...existing, collected: true };
        records.set(id, taken);
        return taken;
      },
    };
    const sent: string[] = [];
    const driven = await driveOpenTasksAfterFleetDry({
      previousRunning: 1,
      running: 0,
      openTasks: [openTask],
      parentProcessing: false,
      mailbox,
      lanes: [],
      beginSystemContinuation: (prompt) => {
        order.push("begin");
        sent.push(prompt);
      },
      send: (prompt) => {
        order.push("send");
        sent.push(prompt);
      },
    });
    expect(driven).toBe(true);
    expect(order).toEqual(["begin", "send"]);
    expect(sent[0]).toContain(FLEET_DRY_CONTINUATION_PREFIX);
    expect(sent[0]).toContain("w1");
    expect(records.get("w1")?.collected).toBe(true);
  });

  test("dry+open continuation JSON includes a spill URI for oversized reports", async () => {
    const original = `head-${"x".repeat(FLEET_DRY_REPORT_CHARS)}TAIL-MARKER`;
    const records = new Map<string, FleetDryMailboxRecord>([
      ["big", { status: "done", report: original }],
    ]);
    const store = fakeBlobStore();
    const sent: string[] = [];
    const driven = await driveOpenTasksAfterFleetDry({
      previousRunning: 1,
      running: 0,
      openTasks: [openTask],
      parentProcessing: false,
      mailbox: peekMailbox(records),
      lanes: [],
      writeBlob: store.writeBlob,
      beginSystemContinuation: (prompt) => {
        sent.push(prompt);
      },
      send: () => undefined,
    });
    expect(driven).toBe(true);
    const parsed = reportsJSONFromPrompt(sent[0] ?? "");
    expect(Array.isArray(parsed)).toBe(true);
    const report = (parsed as { report?: string }[])[0]?.report ?? "";
    expect(report).toContain(
      `tool-output:///${fleetDrySpillKey("big", "report")}`,
    );
    expect(report).not.toContain("TAIL-MARKER");
    expect(
      new TextDecoder().decode(
        store.blobs.get(fleetDrySpillKey("big", "report"))?.bytes ??
          new Uint8Array(),
      ),
    ).toBe(original);
  });

  test("dry+terminal, live+open, and parentProcessing only skip", () => {
    const noop = {
      mailbox: undefined,
      lanes: [],
      beginSystemContinuation: () => {
        throw new Error("must not begin");
      },
      send: () => {
        throw new Error("must not send");
      },
    };
    expect(
      driveOpenTasksAfterFleetDry({
        previousRunning: 1,
        running: 0,
        openTasks: [{ id: "t1", title: "done", status: "done" }],
        parentProcessing: false,
        ...noop,
      }),
    ).toBe(false);
    expect(
      driveOpenTasksAfterFleetDry({
        previousRunning: 2,
        running: 2,
        openTasks: [openTask],
        parentProcessing: false,
        ...noop,
      }),
    ).toBe(false);
    expect(
      driveOpenTasksAfterFleetDry({
        previousRunning: 1,
        running: 0,
        openTasks: [openTask],
        parentProcessing: true,
        ...noop,
      }),
    ).toBe(false);
  });

  test("deferred dry edge after parentProcessing still collects and sends", async () => {
    const records = new Map<string, FleetDryMailboxRecord>([
      ["w1", { status: "done", report: "ok" }],
    ]);
    const mailbox: FleetDryMailbox = {
      ids: () => [...records.keys()],
      peek: (id) => records.get(id),
      take: (id) => {
        const existing = records.get(id);
        if (existing === undefined) return undefined;
        const taken = { ...existing, collected: true };
        records.set(id, taken);
        return taken;
      },
    };
    const sent: string[] = [];
    const driven = await driveOpenTasksAfterFleetDry({
      previousRunning: 0,
      running: 0,
      deferredDryEdge: true,
      openTasks: [openTask],
      parentProcessing: false,
      mailbox,
      lanes: [],
      beginSystemContinuation: () => undefined,
      send: (prompt) => {
        sent.push(prompt);
      },
    });
    expect(driven).toBe(true);
    expect(sent[0]).toContain("w1");
    expect(records.get("w1")?.collected).toBe(true);
  });

  test("send failure after take leaves reports waitable", async () => {
    const records = new Map<string, FleetDryMailboxRecord>([
      ["w1", { status: "done", report: "ok" }],
    ]);
    const mailbox: FleetDryMailbox = {
      ids: () => [...records.keys()],
      peek: (id) => records.get(id),
      take: (id) => {
        const existing = records.get(id);
        if (existing === undefined) return undefined;
        const taken = { ...existing, collected: true };
        records.set(id, taken);
        return taken;
      },
    };
    const driven = await driveOpenTasksAfterFleetDry({
      previousRunning: 1,
      running: 0,
      openTasks: [openTask],
      parentProcessing: false,
      mailbox,
      lanes: [],
      beginSystemContinuation: () => undefined,
      send: () => {
        throw new Error("send failed");
      },
    });
    expect(driven).toBe(false);
    expect(records.get("w1")?.collected).not.toBe(true);
  });

  test("TUI sendWithAttemptIdentity rejection leaves mailbox uncollected", async () => {
    const records = new Map<string, FleetDryMailboxRecord>([
      ["w1", { status: "done", report: "ok" }],
    ]);
    const mailbox: FleetDryMailbox = {
      ids: () => [...records.keys()],
      peek: (id) => records.get(id),
      take: (id) => {
        const existing = records.get(id);
        if (existing === undefined) return undefined;
        const taken = { ...existing, collected: true };
        records.set(id, taken);
        return taken;
      },
    };
    const sendWithAttemptIdentity = async (): Promise<boolean> => {
      await Promise.resolve();
      throw new Error("agentProxy.send failed");
    };
    const driven = await driveOpenTasksAfterFleetDry({
      deferredDryEdge: true,
      openTasks: [openTask],
      parentProcessing: false,
      mailbox,
      lanes: [],
      beginSystemContinuation: () => undefined,
      send: () => sendWithAttemptIdentity(),
    });
    expect(driven).toBe(true);
    expect(records.get("w1")?.collected).not.toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(records.get("w1")?.collected).not.toBe(true);
  });

  test("TUI sendWithAttemptIdentity false after handleSendFailure leaves mailbox uncollected", async () => {
    const records = new Map<string, FleetDryMailboxRecord>([
      ["w1", { status: "done", report: "ok" }],
    ]);
    const mailbox: FleetDryMailbox = {
      ids: () => [...records.keys()],
      peek: (id) => records.get(id),
      take: (id) => {
        const existing = records.get(id);
        if (existing === undefined) return undefined;
        const taken = { ...existing, collected: true };
        records.set(id, taken);
        return taken;
      },
    };
    const sendWithAttemptIdentity = async (): Promise<boolean> => {
      await Promise.resolve();
      return false;
    };
    const driven = await driveOpenTasksAfterFleetDry({
      deferredDryEdge: true,
      openTasks: [openTask],
      parentProcessing: false,
      mailbox,
      lanes: [],
      beginSystemContinuation: () => undefined,
      send: () => sendWithAttemptIdentity(),
    });
    expect(driven).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(records.get("w1")?.collected).not.toBe(true);
  });

  test("TUI sendWithAttemptIdentity true takes mailbox after send resolves", async () => {
    const records = new Map<string, FleetDryMailboxRecord>([
      ["w1", { status: "done", report: "ok" }],
    ]);
    const mailbox: FleetDryMailbox = {
      ids: () => [...records.keys()],
      peek: (id) => records.get(id),
      take: (id) => {
        const existing = records.get(id);
        if (existing === undefined) return undefined;
        const taken = { ...existing, collected: true };
        records.set(id, taken);
        return taken;
      },
    };
    let resolveSend: ((ok: boolean) => void) | undefined;
    const sendWithAttemptIdentity = (): Promise<boolean> =>
      new Promise((resolve) => {
        resolveSend = resolve;
      });
    const driven = await driveOpenTasksAfterFleetDry({
      deferredDryEdge: true,
      openTasks: [openTask],
      parentProcessing: false,
      mailbox,
      lanes: [],
      beginSystemContinuation: () => undefined,
      send: () => sendWithAttemptIdentity(),
    });
    expect(driven).toBe(true);
    expect(records.get("w1")?.collected).not.toBe(true);
    resolveSend?.(true);
    await Promise.resolve();
    expect(records.get("w1")?.collected).toBe(true);
  });

  test("sync send false returns false, calls onSendFailure, and leaves mailbox uncollected", async () => {
    const records = new Map<string, FleetDryMailboxRecord>([
      ["w1", { status: "done", report: "ok" }],
    ]);
    const mailbox: FleetDryMailbox = {
      ids: () => [...records.keys()],
      peek: (id) => records.get(id),
      take: (id) => {
        const existing = records.get(id);
        if (existing === undefined) return undefined;
        const taken = { ...existing, collected: true };
        records.set(id, taken);
        return taken;
      },
    };
    let failures = 0;
    const driven = await driveOpenTasksAfterFleetDry({
      previousRunning: 1,
      running: 0,
      openTasks: [openTask],
      parentProcessing: false,
      mailbox,
      lanes: [],
      beginSystemContinuation: () => undefined,
      send: () => false,
      onSendFailure: () => {
        failures += 1;
      },
    });
    expect(driven).toBe(false);
    expect(failures).toBe(1);
    expect(records.get("w1")?.collected).not.toBe(true);
  });

  test("sync send throw calls onSendFailure", async () => {
    let failures = 0;
    const driven = await driveOpenTasksAfterFleetDry({
      previousRunning: 1,
      running: 0,
      openTasks: [openTask],
      parentProcessing: false,
      mailbox: undefined,
      lanes: [],
      beginSystemContinuation: () => undefined,
      send: () => {
        throw new Error("send failed");
      },
      onSendFailure: () => {
        failures += 1;
      },
    });
    expect(driven).toBe(false);
    expect(failures).toBe(1);
  });

  test("TUI send false after handleSendFailure calls onSendFailure", async () => {
    let failures = 0;
    const driven = driveOpenTasksAfterFleetDry({
      deferredDryEdge: true,
      openTasks: [openTask],
      parentProcessing: false,
      mailbox: undefined,
      lanes: [],
      beginSystemContinuation: () => undefined,
      send: async () => false,
      onSendFailure: () => {
        failures += 1;
      },
    });
    expect(failures).toBe(0);
    expect(await driven).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toBe(1);
  });

  test("TUI send rejection calls onSendFailure", async () => {
    let failures = 0;
    const driven = await driveOpenTasksAfterFleetDry({
      deferredDryEdge: true,
      openTasks: [openTask],
      parentProcessing: false,
      mailbox: undefined,
      lanes: [],
      beginSystemContinuation: () => undefined,
      send: async () => {
        await Promise.resolve();
        throw new Error("agentProxy.send failed");
      },
      onSendFailure: () => {
        failures += 1;
      },
    });
    expect(driven).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toBe(1);
  });
});
