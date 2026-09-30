import { describe, expect, test } from "bun:test";
import { createFleetMailbox } from "./agent-fleet.js";
import {
  buildMailboxMailPrompt,
  driveMailboxMail,
  latchMailboxMailDrive,
  MAILBOX_MAIL_WAKE_PREFIX,
  mailboxMailErrorUriHint,
  mailboxMailReportUriHint,
  mailboxMailWakeLine,
  occupancyShouldYieldWait,
} from "./mailbox-mail-drive.js";
import { createSubAgentSessionStore } from "./session-store.js";
import {
  digestCollectedReports,
  fleetDrySpillKey,
  FLEET_DRY_REPORT_CHARS,
  MAILBOX_DIGEST_SECTION_CHARS,
  type FleetDryMailboxRecord,
} from "./fleet-dry-drive.js";
import {
  ACCEPTED_DELIVERY,
  collectingMailbox,
  driveFixture,
  orderingDrive,
  NOT_DELIVERED_RESULT,
  UNCERTAIN_DELIVERY,
} from "./fleet-test-harness.js";

function recordsOf(
  entries: Record<string, FleetDryMailboxRecord>,
): Map<string, FleetDryMailboxRecord> {
  return new Map(Object.entries(entries));
}

function fakeBlobStore() {
  const blobs = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    blobs,
    writeBlob: (key: string, bytes: Uint8Array, contentType: string) => {
      blobs.set(key, { bytes, contentType });
    },
  };
}

function mailboxReportsFromPrompt(prompt: string): Record<string, unknown>[] {
  const line = mailboxMailWakeLine();
  const start = prompt.indexOf(line);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = prompt.slice(start + line.length);
  const jsonStart = rest.indexOf("[");
  expect(jsonStart).toBeGreaterThanOrEqual(0);
  const jsonEnd = rest.indexOf("\n", jsonStart);
  return JSON.parse(
    rest.slice(jsonStart, jsonEnd === -1 ? undefined : jsonEnd),
  ) as Record<string, unknown>[];
}

const ENVELOPE_REPORT = [
  "## Summary",
  "Shipped the digest.",
  "",
  "## Findings",
  "SECRET_FINDINGS_BODY",
  "",
  "## Blockers",
  "Need a follow-up.",
  "",
  "## Paths",
  "src/subagent/mailbox-mail-drive.ts",
].join("\n");

const NOOP_DRIVE = {
  beginSystemContinuation: () => {
    throw new Error("must not begin");
  },
  send: () => {
    throw new Error("must not send");
  },
};

async function driveMailNotDelivered(): Promise<
  Map<string, FleetDryMailboxRecord>
> {
  const records = recordsOf({ w1: { status: "done", report: "ok" } });
  const driven = await driveMailboxMail({
    ...driveFixture(records, {
      send: () => Promise.resolve(NOT_DELIVERED_RESULT),
    }),
  });
  expect(driven).toBe(false);
  expect(records.get("w1")?.collected).not.toBe(true);
  return records;
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
    expect(prompt).not.toContain(mailboxMailReportUriHint());
  });

  test("names report_uri with a read_file truncation notice", () => {
    const uri = `tool-output:///${fleetDrySpillKey("worker-1", "report")}`;
    const prompt = buildMailboxMailPrompt([
      {
        agent_id: "worker-1",
        status: "done",
        report_uri: uri,
      },
    ]);
    expect(prompt).toContain(mailboxMailReportUriHint());
    expect(prompt).toContain(
      "use read_file with that URI (offset/limit supported)",
    );
    expect(prompt).toContain(uri);
  });

  test("names error_uri with a read_file truncation notice", () => {
    const uri = `tool-output:///${fleetDrySpillKey("worker-1", "error")}`;
    const prompt = buildMailboxMailPrompt([
      {
        agent_id: "worker-1",
        status: "failed",
        error_uri: uri,
      },
    ]);
    expect(prompt).toContain(mailboxMailErrorUriHint());
    expect(prompt).toContain(
      "use read_file with that URI (offset/limit supported)",
    );
    expect(prompt).toContain(uri);
  });

  test("does not paste a duplicate agent_id", () => {
    const prompt = buildMailboxMailPrompt([
      { agent_id: "w1", status: "done" },
      { agent_id: "w1", status: "failed" },
    ]);
    expect(prompt.match(/"agent_id":"w1"/g)?.length).toBe(1);
  });
});

describe("digestCollectedReports", () => {
  test("keeps Summary and Blockers and spills the full report", async () => {
    const store = fakeBlobStore();
    const [digest] = await digestCollectedReports(
      [
        {
          agent_id: "worker-1",
          status: "done",
          description: "lane",
          report: ENVELOPE_REPORT,
        },
        {
          agent_id: "worker-1",
          status: "done",
          report: "duplicate must drop",
        },
      ],
      store.writeBlob,
    );
    const reportUri = `tool-output:///${fleetDrySpillKey("worker-1", "report")}`;
    expect(digest?.summary).toBe("Shipped the digest.");
    expect(digest?.blockers).toBe("Need a follow-up.");
    expect(digest?.report_uri).toBe(reportUri);
    expect(digest?.report).toContain("[output truncated");
    expect(digest?.report).toContain(reportUri);
    expect(digest?.report).toContain(
      "use read_file with that URI (offset/limit supported)",
    );
    expect(digest?.report).not.toContain("SECRET_FINDINGS_BODY");
    expect(digest?.report).toContain(
      `${ENVELOPE_REPORT.length.toLocaleString()} more chars omitted here`,
    );
    expect(digest?.report).not.toMatch(/— 0 more chars omitted/);
    expect(
      new TextDecoder().decode(
        store.blobs.get(fleetDrySpillKey("worker-1", "report"))?.bytes ??
          new Uint8Array(),
      ),
    ).toBe(ENVELOPE_REPORT);
  });

  test("empty Summary still surfaces Findings", async () => {
    const store = fakeBlobStore();
    const report = [
      "## Summary",
      "",
      "## Findings",
      "SECRET_EMPTY_SUMMARY_FINDINGS",
      "",
      "## Blockers",
      "None.",
      "",
      "## Paths",
      "src/subagent/fleet-dry-drive.ts",
    ].join("\n");
    const [digest] = await digestCollectedReports(
      [{ agent_id: "empty-sum", status: "done", report }],
      store.writeBlob,
    );
    expect(digest?.summary).toBeUndefined();
    expect(digest?.findings).toBe("SECRET_EMPTY_SUMMARY_FINDINGS");
    expect(digest?.blockers).toBe("None.");
    expect(digest?.report_uri).toBe(
      `tool-output:///${fleetDrySpillKey("empty-sum", "report")}`,
    );
  });

  test("writeBlob failure inlines a truncated report with NOT retrievable", async () => {
    const original = `head-${"x".repeat(FLEET_DRY_REPORT_CHARS)}SECRET_FINDINGS_TAIL`;
    const [digest] = await digestCollectedReports(
      [{ agent_id: "boom", status: "done", report: original }],
      async () => {
        throw new Error("disk full");
      },
    );
    expect(digest?.report_uri).toBeUndefined();
    expect(digest?.report?.length).toBeLessThanOrEqual(FLEET_DRY_REPORT_CHARS);
    expect(digest?.report).toContain("[output truncated");
    expect(digest?.report).toContain("NOT retrievable");
    expect(digest?.report).not.toContain("tool-output:///");
    expect(digest?.report).not.toContain("SECRET_FINDINGS_TAIL");
  });

  test("missing writeBlob inlines the report instead of dropping Findings", async () => {
    const [digest] = await digestCollectedReports([
      { agent_id: "no-blob", status: "done", report: ENVELOPE_REPORT },
    ]);
    expect(digest?.report_uri).toBeUndefined();
    expect(digest?.report).toBe(ENVELOPE_REPORT);
    expect(digest?.report).toContain("SECRET_FINDINGS_BODY");
    expect(digest?.summary).toBe("Shipped the digest.");
  });

  test("spill notice remaining is the omitted body when no prefix is kept", async () => {
    const store = fakeBlobStore();
    const short = "short spilled body";
    const [digest] = await digestCollectedReports(
      [{ agent_id: "short", status: "done", report: short }],
      store.writeBlob,
    );
    expect(short.length).toBeLessThan(MAILBOX_DIGEST_SECTION_CHARS);
    expect(digest?.report).toContain(
      `${short.length.toLocaleString()} more chars omitted here`,
    );
    expect(digest?.report).not.toMatch(/— 0 more chars omitted/);
    expect(digest?.report).not.toContain(short);
    expect(digest?.report_uri).toBe(
      `tool-output:///${fleetDrySpillKey("short", "report")}`,
    );
  });

  test("oversized spilled report remaining is the full body, not length minus the digest cap", async () => {
    const store = fakeBlobStore();
    const original = "x".repeat(MAILBOX_DIGEST_SECTION_CHARS + 80);
    const [digest] = await digestCollectedReports(
      [{ agent_id: "long", status: "done", report: original }],
      store.writeBlob,
    );
    expect(digest?.report).toContain(
      `${original.length.toLocaleString()} more chars omitted here`,
    );
    expect(digest?.report).not.toContain(
      `${(original.length - MAILBOX_DIGEST_SECTION_CHARS).toLocaleString()} more chars omitted here`,
    );
  });

  test("spilled error names error_uri with truncation-notice language", async () => {
    const store = fakeBlobStore();
    const error = "provider boom";
    const [digest] = await digestCollectedReports(
      [{ agent_id: "fail", status: "failed", error }],
      store.writeBlob,
    );
    const errorUri = `tool-output:///${fleetDrySpillKey("fail", "error")}`;
    expect(digest?.error_uri).toBe(errorUri);
    expect(digest?.error).toContain("[output truncated");
    expect(digest?.error).toContain(errorUri);
    expect(digest?.error).toContain(
      `${error.length.toLocaleString()} more chars omitted here`,
    );
    expect(digest?.error).not.toMatch(/— 0 more chars omitted/);
    expect(digest?.error).not.toContain("provider boom");
    expect(
      new TextDecoder().decode(
        store.blobs.get(fleetDrySpillKey("fail", "error"))?.bytes ??
          new Uint8Array(),
      ),
    ).toBe(error);
  });
});

describe("driveMailboxMail", () => {
  test("idle parent with one terminal drives even while siblings run", async () => {
    const records = recordsOf({
      done: { status: "done", report: "ok", description: "lane" },
      live: { status: "running" },
    });
    const order: string[] = [];
    const sent: string[] = [];
    const driven = await driveMailboxMail({
      ...orderingDrive(records, order, sent),
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
    const records = recordsOf({
      fail: { status: "failed", error: "boom" },
    });
    const sent: string[] = [];
    const driven = await driveMailboxMail({
      ...driveFixture(records, {
        send: (prompt) => {
          sent.push(prompt);
          return ACCEPTED_DELIVERY;
        },
      }),
    });
    expect(driven).toBe(true);
    expect(sent[0]).toContain("fail");
    expect(sent[0]).toContain("boom");
    expect(records.get("fail")?.collected).toBe(true);
  });

  test("delivers a digest and blob pointer instead of the full report JSON", async () => {
    const records = recordsOf({
      done: { status: "done", report: ENVELOPE_REPORT, description: "lane" },
    });
    const store = fakeBlobStore();
    const sent: string[] = [];
    const driven = await driveMailboxMail({
      ...driveFixture(records, {
        send: (prompt) => {
          sent.push(prompt);
          return ACCEPTED_DELIVERY;
        },
      }),
      writeBlob: store.writeBlob,
    });
    expect(driven).toBe(true);
    const parsed = mailboxReportsFromPrompt(sent[0] ?? "");
    expect(parsed[0]?.agent_id).toBe("done");
    expect(parsed[0]?.status).toBe("done");
    expect(parsed[0]?.description).toBe("lane");
    expect(parsed[0]?.summary).toBe("Shipped the digest.");
    expect(parsed[0]?.blockers).toBe("Need a follow-up.");
    expect(parsed[0]?.report_uri).toBe(
      `tool-output:///${fleetDrySpillKey("done", "report")}`,
    );
    expect(String(parsed[0]?.report)).toContain("[output truncated");
    expect(String(parsed[0]?.report)).toContain(
      "use read_file with that URI (offset/limit supported)",
    );
    expect(sent[0]).toContain(mailboxMailReportUriHint());
    expect(sent[0]).not.toContain("SECRET_FINDINGS_BODY");
    expect(
      new TextDecoder().decode(
        store.blobs.get(fleetDrySpillKey("done", "report"))?.bytes ??
          new Uint8Array(),
      ),
    ).toBe(ENVELOPE_REPORT);
  });

  test("parentProcessing or empty mailbox is a no-op", async () => {
    const records = recordsOf({
      done: { status: "done", report: "ok" },
    });
    expect(
      driveMailboxMail({
        parentProcessing: true,
        mailbox: collectingMailbox(records),
        lanes: [],
        ...NOOP_DRIVE,
      }),
    ).toBe(false);
    expect(
      driveMailboxMail({
        parentProcessing: false,
        mailbox: collectingMailbox(new Map()),
        lanes: [],
        ...NOOP_DRIVE,
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
        ...NOOP_DRIVE,
      }),
    ).toBe(false);
  });

  test("send failure leaves reports waitable", async () => {
    const records = recordsOf({
      w1: { status: "done", report: "ok" },
    });
    const driven = await driveMailboxMail({
      ...driveFixture(records, {
        send: () => {
          throw new Error("send failed");
        },
      }),
    });
    expect(driven).toBe(false);
    expect(records.get("w1")?.collected).not.toBe(true);
  });

  test("async send not-delivered after begin leaves mailbox uncollected", async () => {
    await driveMailNotDelivered();
  });

  test("async send success takes after the promise resolves", async () => {
    const records = recordsOf({
      w1: { status: "done", report: "ok" },
    });
    let resolveSend: ((result: typeof ACCEPTED_DELIVERY) => void) | undefined;
    let sendStarted: (() => void) | undefined;
    const sendSeen = new Promise<void>((resolve) => {
      sendStarted = resolve;
    });
    const driven = driveMailboxMail({
      ...driveFixture(records, {
        send: () => {
          sendStarted?.();
          return new Promise((resolve) => {
            resolveSend = resolve;
          });
        },
      }),
    });
    await sendSeen;
    expect(records.get("w1")?.collected).not.toBe(true);
    resolveSend?.(ACCEPTED_DELIVERY);
    expect(await driven).toBe(true);
    expect(records.get("w1")?.collected).toBe(true);
  });

  test("two flushes while send is pending deliver once", async () => {
    const records = recordsOf({
      w1: { status: "done", report: "ok" },
    });
    const mailbox = collectingMailbox(records);
    const sends: string[] = [];
    let resolveSend: ((result: typeof ACCEPTED_DELIVERY) => void) | undefined;
    let sendStarted: (() => void) | undefined;
    const sendSeen = new Promise<void>((resolve) => {
      sendStarted = resolve;
    });
    const driven = driveMailboxMail({
      parentProcessing: false,
      mailbox,
      lanes: [],
      beginSystemContinuation: () => undefined,
      send: (prompt) => {
        sends.push(prompt);
        sendStarted?.();
        return new Promise<typeof ACCEPTED_DELIVERY>((resolve) => {
          resolveSend = resolve;
        });
      },
    });
    await sendSeen;
    expect(sends).toHaveLength(1);
    expect(records.get("w1")?.collected).not.toBe(true);
    expect(
      await driveMailboxMail({
        parentProcessing: false,
        mailbox,
        lanes: [],
        ...NOOP_DRIVE,
      }),
    ).toBe(false);
    expect(sends).toHaveLength(1);
    resolveSend?.(ACCEPTED_DELIVERY);
    expect(await driven).toBe(true);
    expect(records.get("w1")?.collected).toBe(true);
  });

  test("failed send can retry once", async () => {
    const records = recordsOf({
      w1: { status: "done", report: "ok" },
    });
    const mailbox = collectingMailbox(records);
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
          return ACCEPTED_DELIVERY;
        },
      }),
    ).toBe(true);
    expect(sends).toHaveLength(1);
    expect(records.get("w1")?.collected).toBe(true);
  });

  test("awaiting_director is not mailbox mail", async () => {
    const records = recordsOf({
      ask: { status: "awaiting_director" },
      live: { status: "running" },
    });
    expect(
      driveMailboxMail({
        parentProcessing: false,
        mailbox: collectingMailbox(records),
        lanes: [],
        ...NOOP_DRIVE,
      }),
    ).toBe(false);
  });

  test("does not begin if the parent starts processing during collect", async () => {
    const records = recordsOf({
      w1: { status: "done", report: "ok" },
    });
    let processing = false;
    const driven = driveMailboxMail({
      parentProcessing: false,
      isParentProcessing: () => processing,
      mailbox: collectingMailbox(records),
      lanes: [],
      ...NOOP_DRIVE,
    });
    processing = true;
    expect(await driven).toBe(false);
    expect(records.get("w1")?.collected).not.toBe(true);
  });

  test("not-delivered send leaves the wake retryable", async () => {
    const records = await driveMailNotDelivered();
    expect(
      await driveMailboxMail({
        parentProcessing: false,
        mailbox: collectingMailbox(records),
        lanes: [],
        beginSystemContinuation: () => undefined,
        send: () => ACCEPTED_DELIVERY,
      }),
    ).toBe(true);
    expect(records.get("w1")?.collected).toBe(true);
  });

  test("uncertain send leaves the wake retryable", async () => {
    const records = recordsOf({
      w1: { status: "done", report: "ok" },
    });
    expect(
      await driveMailboxMail({
        parentProcessing: false,
        mailbox: collectingMailbox(records),
        lanes: [],
        beginSystemContinuation: () => undefined,
        send: () => Promise.resolve(UNCERTAIN_DELIVERY),
      }),
    ).toBe(false);
    expect(records.get("w1")?.collected).not.toBe(true);
  });
});

describe("latchMailboxMailDrive", () => {
  test("overlapping flushes send once until the in-flight collect settles", async () => {
    const records = recordsOf({
      done: { status: "done", report: "ok", description: "lane" },
    });
    const sends: string[] = [];
    let resolveSend: (() => void) | undefined;
    const sent = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const driver = latchMailboxMailDrive(() =>
      driveMailboxMail({
        parentProcessing: false,
        mailbox: collectingMailbox(records),
        lanes: [],
        beginSystemContinuation: () => undefined,
        send: (prompt) => {
          sends.push(prompt);
          resolveSend?.();
          return ACCEPTED_DELIVERY;
        },
      }),
    );
    expect(driver()).toBe(true);
    expect(driver.claimed()).toBe(true);
    expect(driver()).toBe(false);
    expect(driver()).toBe(false);
    expect(driver.claimed()).toBe(true);
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
    expect(driver.claimed()).toBe(false);
    expect(calls).toBe(2);
  });

  test("an empty mailbox does not claim the occupancy slot", () => {
    const driver = latchMailboxMailDrive(() =>
      driveMailboxMail({
        parentProcessing: false,
        mailbox: collectingMailbox(new Map()),
        lanes: [],
        ...NOOP_DRIVE,
      }),
    );
    expect(driver()).toBe(false);
    expect(driver.claimed()).toBe(false);
  });

  test("after the in-flight drive settles, a new terminal can send", async () => {
    const records = recordsOf({
      first: { status: "done", report: "one" },
    });
    const mailbox = collectingMailbox(records);
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
          return ACCEPTED_DELIVERY;
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
    expect(occupancyShouldYieldWait(collectingMailbox(new Map()))).toBe(false);
    expect(
      occupancyShouldYieldWait(
        collectingMailbox(recordsOf({ live: { status: "running" } })),
      ),
    ).toBe(false);
    expect(
      occupancyShouldYieldWait(
        collectingMailbox(
          recordsOf({ done: { status: "done", report: "ok" } }),
        ),
      ),
    ).toBe(true);
    expect(
      occupancyShouldYieldWait(
        collectingMailbox(
          recordsOf({ fail: { status: "failed", error: "boom" } }),
        ),
      ),
    ).toBe(true);
    expect(
      occupancyShouldYieldWait(
        collectingMailbox(recordsOf({ ask: { status: "awaiting_director" } })),
      ),
    ).toBe(true);
    const collected = recordsOf({
      done: { status: "done", report: "ok", collected: true },
    });
    expect(occupancyShouldYieldWait(collectingMailbox(collected))).toBe(false);
  });
});
