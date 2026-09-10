import { describe, expect, test } from "bun:test";
import { createFleetMailbox } from "./agent-fleet.js";
import {
  buildMailboxMailPrompt,
  driveMailboxMail,
  MAILBOX_MAIL_WAKE_PREFIX,
  occupancyShouldYieldWait,
} from "./mailbox-mail-drive.js";
import { createSubAgentSessionStore } from "./session-store.js";
import type {
  FleetDryMailbox,
  FleetDryMailboxRecord,
} from "./fleet-dry-drive.js";

function mapMailbox(
  records: Map<string, FleetDryMailboxRecord>,
): FleetDryMailbox {
  return {
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
}

describe("buildMailboxMailPrompt", () => {
  test("prefixes collected JSON and tells the parent not to wait_agents", () => {
    const prompt = buildMailboxMailPrompt([
      {
        agent_id: "worker-1",
        status: "done",
        report: "shipped",
        description: "lane",
      },
    ]);
    expect(prompt.startsWith(MAILBOX_MAIL_WAKE_PREFIX)).toBe(true);
    expect(prompt).toContain("worker-1");
    expect(prompt).toContain("shipped");
    expect(prompt).toContain(
      "already collected — do not call wait_agents for these agent_ids",
    );
  });
});

describe("driveMailboxMail", () => {
  test("idle parent with one terminal drives even while siblings run", () => {
    const records = new Map<string, FleetDryMailboxRecord>([
      ["done", { status: "done", report: "ok", description: "lane" }],
      ["live", { status: "running" }],
    ]);
    const order: string[] = [];
    const sent: string[] = [];
    const driven = driveMailboxMail({
      parentProcessing: false,
      mailbox: mapMailbox(records),
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
    expect(sent[0]).toContain(MAILBOX_MAIL_WAKE_PREFIX);
    expect(sent[0]).toContain("done");
    expect(sent[0]).not.toContain('"live"');
    expect(records.get("done")?.collected).toBe(true);
    expect(records.get("live")?.collected).not.toBe(true);
  });

  test("fail path is the same terminal collect", () => {
    const records = new Map<string, FleetDryMailboxRecord>([
      ["fail", { status: "failed", error: "boom" }],
    ]);
    const sent: string[] = [];
    const driven = driveMailboxMail({
      parentProcessing: false,
      mailbox: mapMailbox(records),
      lanes: [],
      beginSystemContinuation: () => undefined,
      send: (prompt) => {
        sent.push(prompt);
      },
    });
    expect(driven).toBe(true);
    expect(sent[0]).toContain("fail");
    expect(sent[0]).toContain("boom");
    expect(records.get("fail")?.collected).toBe(true);
  });

  test("parentProcessing or empty mailbox is a no-op", () => {
    const records = new Map<string, FleetDryMailboxRecord>([
      ["done", { status: "done", report: "ok" }],
    ]);
    const noop = {
      beginSystemContinuation: () => {
        throw new Error("must not begin");
      },
      send: () => {
        throw new Error("must not send");
      },
    };
    expect(
      driveMailboxMail({
        parentProcessing: true,
        mailbox: mapMailbox(records),
        lanes: [],
        ...noop,
      }),
    ).toBe(false);
    expect(
      driveMailboxMail({
        parentProcessing: false,
        mailbox: mapMailbox(new Map()),
        lanes: [],
        ...noop,
      }),
    ).toBe(false);
    expect(records.get("done")?.collected).not.toBe(true);
  });

  test("already-collected terminals are not driven again", () => {
    const sessions = createSubAgentSessionStore();
    const mailbox = createFleetMailbox(sessions);
    const session = sessions.start({
      id: "coll",
      description: "already collected",
      agentId: "builder",
      brief: "brief",
    });
    mailbox.register(session.id);
    sessions.complete("coll", "already taken");
    mailbox.take("coll");
    expect(
      driveMailboxMail({
        parentProcessing: false,
        mailbox,
        lanes: sessions.list(),
        beginSystemContinuation: () => {
          throw new Error("must not begin");
        },
        send: () => {
          throw new Error("must not send");
        },
      }),
    ).toBe(false);
  });

  test("send failure leaves reports waitable", () => {
    const records = new Map<string, FleetDryMailboxRecord>([
      ["w1", { status: "done", report: "ok" }],
    ]);
    const driven = driveMailboxMail({
      parentProcessing: false,
      mailbox: mapMailbox(records),
      lanes: [],
      beginSystemContinuation: () => undefined,
      send: () => {
        throw new Error("send failed");
      },
    });
    expect(driven).toBe(false);
    expect(records.get("w1")?.collected).not.toBe(true);
  });

  test("async send false after begin leaves mailbox uncollected", async () => {
    const records = new Map<string, FleetDryMailboxRecord>([
      ["w1", { status: "done", report: "ok" }],
    ]);
    const driven = driveMailboxMail({
      parentProcessing: false,
      mailbox: mapMailbox(records),
      lanes: [],
      beginSystemContinuation: () => undefined,
      send: () => Promise.resolve(false),
    });
    expect(driven).toBe(true);
    expect(records.get("w1")?.collected).not.toBe(true);
    await Promise.resolve();
    expect(records.get("w1")?.collected).not.toBe(true);
  });

  test("async send success takes after the promise resolves", async () => {
    const records = new Map<string, FleetDryMailboxRecord>([
      ["w1", { status: "done", report: "ok" }],
    ]);
    const driven = driveMailboxMail({
      parentProcessing: false,
      mailbox: mapMailbox(records),
      lanes: [],
      beginSystemContinuation: () => undefined,
      send: () => Promise.resolve(true),
    });
    expect(driven).toBe(true);
    expect(records.get("w1")?.collected).not.toBe(true);
    await Promise.resolve();
    expect(records.get("w1")?.collected).toBe(true);
  });

  test("awaiting_director is not mailbox mail", () => {
    const records = new Map<string, FleetDryMailboxRecord>([
      ["ask", { status: "awaiting_director" }],
      ["live", { status: "running" }],
    ]);
    expect(
      driveMailboxMail({
        parentProcessing: false,
        mailbox: mapMailbox(records),
        lanes: [],
        beginSystemContinuation: () => {
          throw new Error("must not begin");
        },
        send: () => {
          throw new Error("must not send");
        },
      }),
    ).toBe(false);
  });
});

describe("occupancyShouldYieldWait", () => {
  test("yields on uncollected terminal, fail, or ask; not on live or collected", () => {
    expect(occupancyShouldYieldWait(undefined)).toBe(false);
    expect(occupancyShouldYieldWait(mapMailbox(new Map()))).toBe(false);
    expect(
      occupancyShouldYieldWait(
        mapMailbox(new Map([["live", { status: "running" }]])),
      ),
    ).toBe(false);
    expect(
      occupancyShouldYieldWait(
        mapMailbox(new Map([["done", { status: "done", report: "ok" }]])),
      ),
    ).toBe(true);
    expect(
      occupancyShouldYieldWait(
        mapMailbox(new Map([["fail", { status: "failed", error: "boom" }]])),
      ),
    ).toBe(true);
    expect(
      occupancyShouldYieldWait(
        mapMailbox(new Map([["ask", { status: "awaiting_director" }]])),
      ),
    ).toBe(true);
    const collected = new Map<string, FleetDryMailboxRecord>([
      ["done", { status: "done", report: "ok", collected: true }],
    ]);
    expect(occupancyShouldYieldWait(mapMailbox(collected))).toBe(false);
  });
});
