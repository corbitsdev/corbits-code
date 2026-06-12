import type { InboundMessage } from "@intx/types/runtime";

// Builds the InboundMessage delivered to the agent after an inference turn
// completes. The [USER INTERRUPTION] marker tells the model to orient itself
// before incorporating the message.
export function buildInjectionMessage(text: string): InboundMessage {
  const body =
    `[USER INTERRUPTION]\n\n` +
    `The user sent the following message while you were working. ` +
    `Briefly summarise what you were doing, assess whether this is a course-correction ` +
    `(requires changing direction) or a nudge (minor adjustment), then incorporate it ` +
    `and continue accordingly.\n\n` +
    `User message: ${text}`;

  return {
    ref: { uid: 1, mailbox: "INBOX" },
    headers: {
      from: "user@local",
      to: ["agent@local"],
      date: new Date().toISOString(),
      messageId: `<inject-${Date.now()}@local>`,
      interchangeType: "conversation.message",
    },
    flags: [],
    content: body,
    signatureStatus: "missing",
  };
}

export type InjectionQueue = {
  enqueue(text: string): void;
  dequeue(): string | undefined;
  peek(): string | undefined;
  size(): number;
};

export function createInjectionQueue(): InjectionQueue {
  const items: string[] = [];

  return {
    enqueue(text: string): void {
      items.push(text);
    },
    dequeue(): string | undefined {
      return items.shift();
    },
    peek(): string | undefined {
      return items[0];
    },
    size(): number {
      return items.length;
    },
  };
}
