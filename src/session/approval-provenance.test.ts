import { describe, expect, mock, test } from "bun:test";
import { createInboundMessage } from "@intx/mime";
import type { InboundMessage } from "@intx/types/runtime";
import { configureSync, getConfig, resetSync } from "@intx/log";

import {
  createApprovalCorrelationValidator,
  createApprovalProvenanceGate,
  isForeignApprovalIngress,
  LOCAL_APPROVAL_FROM,
  LOCAL_APPROVAL_MAILBOX,
} from "./approval-provenance.js";
import { redactedCorrelationId } from "./redacted-correlation.js";

interface MessageInput {
  from: string;
  mailbox?: string;
  correlationId?: string;
}

function approvalMessage(
  args: MessageInput = {
    from: LOCAL_APPROVAL_FROM,
    mailbox: LOCAL_APPROVAL_MAILBOX,
  },
  outcome: "approved" | "rejected" = "approved",
): InboundMessage {
  const message = createInboundMessage({
    from: args.from,
    to: "agent@local",
    correlationId: args.correlationId ?? "corr-1",
    content: JSON.stringify({ outcome }),
    ...(args.mailbox === undefined ? {} : { ref: { mailbox: args.mailbox } }),
  });
  message.headers.interchangeType =
    outcome === "approved" ? "approval.granted" : "approval.denied";
  return message;
}

describe("isForeignApprovalIngress", () => {
  test("the local approval-delivery path is not foreign", () => {
    expect(isForeignApprovalIngress(approvalMessage())).toBe(false);
  });
  test("a foreign sender is foreign even on the local mailbox", () => {
    expect(
      isForeignApprovalIngress(
        approvalMessage({ from: "watchdog@foreign", mailbox: "approval" }),
      ),
    ).toBe(true);
  });
  test("mailbox ingress is foreign even with the local sender", () => {
    expect(
      isForeignApprovalIngress(
        approvalMessage({ from: LOCAL_APPROVAL_FROM, mailbox: "INBOX" }),
      ),
    ).toBe(true);
  });
  test("a typed approval with no mailbox fails closed as foreign", () => {
    // The declared MessageRef always names a mailbox, but the gate must still
    // fail closed when a ref arrives without one (upstream transport parses
    // external bytes before this type guarantees anything).
    const { mailbox: _omitted, ...refWithoutMailbox } = approvalMessage().ref;
    const message = {
      ...approvalMessage(),
      ref: refWithoutMailbox,
    } as unknown as InboundMessage;
    expect(isForeignApprovalIngress(message)).toBe(true);
  });
  test("a typed approval with no ref at all fails closed as foreign", () => {
    // What fail-closed is for: a type-illegal shape the declared ref cannot
    // produce must not flip the default to trusted merely by existing.
    const message = {
      ...approvalMessage({ from: "webhook@foreign" }),
      ref: undefined,
    } as unknown as InboundMessage;
    expect(isForeignApprovalIngress(message)).toBe(true);
  });
});

describe("createApprovalCorrelationValidator", () => {
  test("authenticates only local approval-delivery provenance", async () => {
    const validator = createApprovalCorrelationValidator();
    expect(await validator.validate({} as never, approvalMessage())).toBe(true);
    expect(
      await validator.validate(
        {} as never,
        approvalMessage({ from: "watchdog@foreign", mailbox: "INBOX" }),
      ),
    ).toBe(false);
  });
  test("authenticates foreign ingress for denied decisions too", async () => {
    const validator = createApprovalCorrelationValidator();
    expect(
      await validator.validate(
        {} as never,
        approvalMessage({ from: "user@local", mailbox: "INBOX" }, "rejected"),
      ),
    ).toBe(false);
  });
});

describe("createApprovalProvenanceGate", () => {
  test("drops a foreign typed approval before the agent can correlate it", () => {
    const deliver = mock((_message: InboundMessage): void => undefined);
    const gate = createApprovalProvenanceGate({ deliver });
    gate.deliver(
      approvalMessage({ from: "webhook@foreign", mailbox: "INBOX" }),
    );
    expect(deliver).not.toHaveBeenCalled();
  });
  test("passes the local approval-delivery path through unchanged", () => {
    const deliver = mock((_message: InboundMessage): void => undefined);
    const gate = createApprovalProvenanceGate({ deliver });
    const message = approvalMessage();
    gate.deliver(message);
    expect(deliver).toHaveBeenCalledWith(message);
  });
  test("leaves nonapproval inbound routing untouched", () => {
    const deliver = mock((_message: InboundMessage): void => undefined);
    const gate = createApprovalProvenanceGate({ deliver });
    const message = createInboundMessage({
      from: "user@local",
      to: "agent@local",
      content: "hello",
    });
    gate.deliver(message);
    expect(deliver).toHaveBeenCalledWith(message);
  });
  test("a type-illegal ref-less foreign approval is discarded, not thrown", () => {
    // The gate must not convert a forge probe into a deliver() throw: the
    // receipt path dereferences the same optional ref the policy checked.
    const deliver = mock((_message: InboundMessage): void => undefined);
    const gate = createApprovalProvenanceGate({ deliver });
    const message = {
      ...approvalMessage({ from: "webhook@foreign" }),
      ref: undefined,
    } as unknown as InboundMessage;
    gate.deliver(message);
    expect(deliver).not.toHaveBeenCalled();
  });
  test("discarded forgeries get a structured receipt naming provenance", () => {
    const records: { level: string; text: string }[] = [];
    const previous = getConfig();
    configureSync({
      reset: true,
      sinks: {
        test: (record) => {
          records.push({
            level: record.level,
            text: record.message.map(String).join(""),
          });
        },
      },
      loggers: [
        { category: [], lowestLevel: "warning", sinks: ["test"] },
        {
          category: ["logtape", "meta"],
          lowestLevel: "error",
          sinks: ["test"],
        },
      ],
    });
    try {
      const deliver = mock((_message: InboundMessage): void => undefined);
      const gate = createApprovalProvenanceGate({ deliver });
      gate.deliver(
        approvalMessage({
          from: "watchdog@foreign",
          mailbox: "INBOX",
        }),
      );
      // The same probe, but with the ref missing entirely: the receipt must
      // render the missing mailbox as <none> instead of throwing.
      gate.deliver({
        ...approvalMessage({ from: "webhook@foreign" }),
        ref: undefined,
      } as unknown as InboundMessage);
      const receipts = records.filter(
        (record) =>
          record.level === "warning" &&
          record.text.includes("forged approval discarded"),
      );
      expect(receipts).toHaveLength(2);
      // The warn receipt carries the truncated-and-hashed form, never the
      // live bearer capability (see src/session/redacted-correlation.ts).
      expect(receipts[0]?.text).toContain(
        `correlationId=${redactedCorrelationId("corr-1")}`,
      );
      expect(receipts[0]?.text).not.toContain("correlationId=corr-1 type");
      expect(receipts[0]?.text).toContain("from=watchdog@foreign");
      expect(receipts[0]?.text).toContain("mailbox=INBOX");
      expect(receipts[0]?.text).toContain("type=approval.granted");
      expect(receipts[1]?.text).toContain("from=webhook@foreign");
      expect(receipts[1]?.text).toContain("mailbox=<none>");
      const uuid = "6f4f7c16-2e21-4a2d-9f4b-7c1e93a88b41";
      gate.deliver(
        approvalMessage({
          from: "probe@foreign",
          mailbox: "INBOX",
          correlationId: uuid,
        }),
      );
      const longReceipts = records.filter(
        (record) =>
          record.level === "warning" &&
          record.text.includes("forged approval discarded") &&
          record.text.includes("probe@foreign"),
      );
      expect(longReceipts).toHaveLength(1);
      // A full-length ID never appears in the receipt: only its prefix and
      // the hash suffix do.
      expect(longReceipts[0]?.text).toContain(
        `correlationId=${redactedCorrelationId(uuid)}`,
      );
      expect(longReceipts[0]?.text).not.toContain(uuid);
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      if (previous === null) resetSync();
      else configureSync({ ...previous, reset: true });
    }
  });
  test("wraps deliver without disturbing the rest of the surface", async () => {
    const deliver = mock((_message: InboundMessage): void => undefined);
    const send = mock(async (_content: string) => undefined);
    const gate = createApprovalProvenanceGate({ deliver, send });
    gate.deliver(approvalMessage({ from: "watchdog@foreign" }));
    expect(deliver).not.toHaveBeenCalled();
    await gate.send("continue");
    expect(send).toHaveBeenCalledWith("continue");
  });
});
