import { describe, expect, test } from "bun:test";
import { createFleetMailbox } from "./agent-fleet.js";
import {
  buildMailboxMailPrompt,
  driveMailboxMail,
  latchMailboxMailDrive,
  MAILBOX_MAIL_WAKE_PREFIX,
  mailboxMailWakeLine,
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
    expect(prompt).toContain(mailboxMailWakeLine());
    expect(prompt).not.toContain("already collected");
  });
});

describe("driveMailboxMail", () => {
  test("idle parent with one terminal drives even while siblings run", async () => {
    const records = new Map<string, FleetDryMailboxRecord>([
      ["done", { status: "done", report: "ok", description: "lane" }],
      ["live", { status: "running" }],
    ]);
    const order: string[] = [];
    const sent: string[] = [];
    const driven = await driveMailboxMail({
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

  test("fail path is the same terminal collect", async () => {
    const records = new Map<string, FleetDryMailboxRecord>([
      ["fail", { status: "failed", error: "boom" }],
    ]);
    const sent: string[] = [];
    const driven = await driveMailboxMail({
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

  test("parentProcessing or empty mailbox is a no-op", async () => {
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
      await driveMailboxMail({
        parentProcessing: false,
        mailbox: mapMailbox(new Map()),
        lanes: [],
        ...noop,
      }),
    ).toBe(false);
    expect(records.get("done")?.collected).not.toBe(true);
  });

  test("already-collected terminals are not driven again", async () => {
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
      await driveMailboxMail({
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

  test("send failure leaves reports waitable", async () => {
    const records = new Map<string, FleetDryMailboxRecord>([
      ["w1", { status: "done", report: "ok" }],
    ]);
    const driven = await driveMailboxMail({
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
    const driven = await driveMailboxMail({
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
    let resolveSend: ((ok: boolean) => void) | undefined;
    const driven = await driveMailboxMail({
      parentProcessing: false,
      mailbox: mapMailbox(records),
      lanes: [],
      beginSystemContinuation: () => undefined,
      send: () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    });
    expect(driven).toBe(true);
    expect(records.get("w1")?.collected).not.toBe(true);
    resolveSend?.(true);
    await Promise.resolve();
    expect(records.get("w1")?.collected).toBe(true);
  });

  test("two flushes while send is pending deliver once", async () => {
    const records = new Map<string, FleetDryMailboxRecord>([
      ["w1", { status: "done", report: "ok" }],
    ]);
    const mailbox = mapMailbox(records);
    const sends: string[] = [];
    let resolveSend: ((ok: boolean) => void) | undefined;
    const driven = await driveMailboxMail({
      parentProcessing: false,
      mailbox,
      lanes: [],
      beginSystemContinuation: () => undefined,
      send: (prompt) => {
        sends.push(prompt);
        return new Promise<boolean>((resolve) => {
          resolveSend = resolve;
        });
      },
    });
    expect(driven).toBe(true);
    expect(sends).toHaveLength(1);
    expect(records.get("w1")?.collected).not.toBe(true);
    expect(
      await driveMailboxMail({
        parentProcessing: false,
        mailbox,
        lanes: [],
        beginSystemContinuation: () => {
          throw new Error("must not begin");
        },
        send: () => {
          throw new Error("must not send");
        },
      }),
    ).toBe(false);
    expect(sends).toHaveLength(1);
    resolveSend?.(true);
    await Promise.resolve();
    expect(records.get("w1")?.collected).toBe(true);
  });

  test("failed send can retry once", async () => {
    const records = new Map<string, FleetDryMailboxRecord>([
      ["w1", { status: "done", report: "ok" }],
    ]);
    const mailbox = mapMailbox(records);
    const sends: string[] = [];
    expect(
      await driveMailboxMail({
        parentProcessing: false,
        mailbox,
        lanes: [],
        beginSystemContinuation: () => undefined,
        send: () => {
          throw new Error("send failed");
        },
      }),
    ).toBe(false);
    expect(records.get("w1")?.collected).not.toBe(true);
    expect(
      await driveMailboxMail({
        parentProcessing: false,
        mailbox,
        lanes: [],
        beginSystemContinuation: () => undefined,
        send: (prompt) => {
          sends.push(prompt);
        },
      }),
    ).toBe(true);
    expect(sends).toHaveLength(1);
    expect(records.get("w1")?.collected).toBe(true);
  });

  test("awaiting_director is not mailbox mail", async () => {
    const records = new Map<string, FleetDryMailboxRecord>([
      ["ask", { status: "awaiting_director" }],
      ["live", { status: "running" }],
    ]);
    expect(
      await driveMailboxMail({
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

describe("latchMailboxMailDrive", () => {
  test("overlapping flushes send once until the in-flight collect settles", async () => {
    const records = new Map<string, FleetDryMailboxRecord>([
      ["done", { status: "done", report: "ok", description: "lane" }],
    ]);
    const sends: string[] = [];
    let resolveSend: (() => void) | undefined;
    const sent = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const driver = latchMailboxMailDrive(() =>
      driveMailboxMail({
        parentProcessing: false,
        mailbox: mapMailbox(records),
        lanes: [],
        beginSystemContinuation: () => undefined,
        send: (prompt) => {
          sends.push(prompt);
          resolveSend?.();
        },
      }),
    );
    expect(driver()).toBe(true);
    expect(driver()).toBe(false);
    expect(driver()).toBe(false);
    await sent;
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain(MAILBOX_MAIL_WAKE_PREFIX);
  });

  test("a false drive does not latch the next flush", () => {
    let calls = 0;
    const driver = latchMailboxMailDrive(() => {
      calls += 1;
      return false;
    });
    expect(driver()).toBe(false);
    expect(driver()).toBe(false);
    expect(calls).toBe(2);
  });

  test("after the in-flight drive settles, a new terminal can send", async () => {
    const records = new Map<string, FleetDryMailboxRecord>([
      ["first", { status: "done", report: "one" }],
    ]);
    const mailbox = mapMailbox(records);
    const sends: string[] = [];
    let sawSend: (() => void) | undefined;
    const waitForSend = (): Promise<void> =>
      new Promise<void>((resolve) => {
        sawSend = resolve;
      });
    const driver = latchMailboxMailDrive(() =>
      driveMailboxMail({
        parentProcessing: false,
        mailbox,
        lanes: [],
        beginSystemContinuation: () => undefined,
        send: (prompt) => {
          sends.push(prompt);
          sawSend?.();
        },
      }),
    );
    const first = waitForSend();
    expect(driver()).toBe(true);
    await first;
    expect(sends).toHaveLength(1);
    records.set("second", { status: "done", report: "two" });
    const second = waitForSend();
    let retried = false;
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      if (driver()) {
        retried = true;
        break;
      }
    }
    expect(retried).toBe(true);
    await second;
    expect(sends).toHaveLength(2);
    expect(sends[1]).toContain("second");
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
