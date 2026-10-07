import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@intx/types/runtime";
import {
  createCredentialRecoveryState,
  type CredentialRecoveryAlternative,
  type PendingCredentialRecovery,
} from "./credential-recovery.js";
import {
  createReconnectRecoveryState,
  type PendingReconnectRecovery,
} from "./reconnect-recovery.js";
import { presentSendRecoveryOffer } from "./submit.js";

function operatorMessage(): InboundMessage {
  return {
    ref: { uid: 1, mailbox: "INBOX" },
    headers: {
      from: "user@local",
      to: ["agent@local"],
      date: "2026-09-26T00:00:00.000Z",
      messageId: "<original@local>",
      interchangeType: "conversation.message",
    },
    flags: ["operator-originated"],
    signatureStatus: "missing",
    content: "inspect this",
  };
}

function credentialRetry() {
  return {
    type: "inference.retry",
    data: {
      previousError: { category: "credential_failure", message: "401" },
    },
  };
}

function credentialFailure(providerId: string) {
  return {
    type: "inference.error",
    data: {
      error: { category: "credential_failure", message: "401", providerId },
    },
  };
}

const openAiAlternative: CredentialRecoveryAlternative = {
  id: "openai/gpt-5",
  label: "GPT-5 (openai)",
  provider: "openai",
  model: "gpt-5",
};

/** Drive a real credential state through one OAuth retry + terminal failure. */
function settleCredential(
  alternatives: readonly CredentialRecoveryAlternative[],
): PendingCredentialRecovery | null {
  const state = createCredentialRecoveryState();
  const attempt = state.begin(operatorMessage(), "xai");
  state.observe(attempt, credentialRetry());
  state.observe(attempt, credentialFailure("xai/default-2"));
  return state.settle(attempt, alternatives);
}

/** Drive a real reconnect state through one OAuth retry + terminal failure. */
function settleReconnectArmed(): {
  state: ReturnType<typeof createReconnectRecoveryState>;
  pending: PendingReconnectRecovery | null;
} {
  const state = createReconnectRecoveryState();
  const attempt = state.begin(operatorMessage(), "xai");
  state.observe(attempt, credentialRetry());
  state.observe(attempt, credentialFailure("xai/default-2"));
  return { state, pending: state.settle(attempt) };
}

function settleReconnectUnarmed(): PendingReconnectRecovery | null {
  const state = createReconnectRecoveryState();
  const attempt = state.begin(operatorMessage(), "xai");
  state.observe(attempt, credentialFailure("xai/default-2"));
  return state.settle(attempt);
}

describe("presentSendRecoveryOffer precedence", () => {
  test("reconnect wins when both offers arm; credential never presents", () => {
    const credential = settleCredential([openAiAlternative]);
    const { pending: reconnect } = settleReconnectArmed();
    expect(credential).not.toBeNull();
    expect(reconnect).not.toBeNull();
    const presented: string[] = [];
    presentSendRecoveryOffer({
      credential,
      reconnect,
      presentCredentialRecovery: () => {
        presented.push("credential");
      },
      presentReconnectRecovery: () => {
        presented.push("reconnect");
      },
    });
    expect(presented).toEqual(["reconnect"]);
  });

  test("falls through to the credential picker when reconnect does not arm", () => {
    const credential = settleCredential([openAiAlternative]);
    const reconnect = settleReconnectUnarmed();
    expect(credential).not.toBeNull();
    expect(reconnect).toBeNull();
    const presented: string[] = [];
    presentSendRecoveryOffer({
      credential,
      reconnect,
      presentCredentialRecovery: () => {
        presented.push("credential");
      },
      presentReconnectRecovery: () => {
        presented.push("reconnect");
      },
    });
    expect(presented).toEqual(["credential"]);
  });

  test("falls through to credential when reconnect arms but its presenter is absent", () => {
    const credential = settleCredential([openAiAlternative]);
    const { pending: reconnect } = settleReconnectArmed();
    expect(credential).not.toBeNull();
    expect(reconnect).not.toBeNull();
    const presented: string[] = [];
    presentSendRecoveryOffer({
      credential,
      reconnect,
      presentCredentialRecovery: () => {
        presented.push("credential");
      },
    // No presentReconnectRecovery: an unwired presenter must not swallow the
    // credential fallback.
    });
    expect(presented).toEqual(["credential"]);
  });

  test("presents reconnect when the credential picker has no alternatives", () => {
    const credential = settleCredential([]);
    const { pending: reconnect } = settleReconnectArmed();
    expect(credential).toBeNull();
    expect(reconnect).not.toBeNull();
    const presented: string[] = [];
    presentSendRecoveryOffer({
      credential,
      reconnect,
      presentCredentialRecovery: () => {
        presented.push("credential");
      },
      presentReconnectRecovery: () => {
        presented.push("reconnect");
      },
    });
    expect(presented).toEqual(["reconnect"]);
  });

  test("dismissing the reconnect offer does not cascade to the credential picker", () => {
    const credential = settleCredential([openAiAlternative]);
    const { state, pending: reconnect } = settleReconnectArmed();
    expect(credential).not.toBeNull();
    expect(reconnect).not.toBeNull();
    const presented: string[] = [];
    presentSendRecoveryOffer({
      credential,
      reconnect,
      presentCredentialRecovery: () => {
        presented.push("credential");
      },
      presentReconnectRecovery: () => {
        presented.push("reconnect");
      },
    });
    expect(presented).toEqual(["reconnect"]);
    // Esc cancels that generation only; the settled credential offer stays
    // unpresented.
    expect(state.cancel(reconnect?.generation ?? -1)).toBe(true);
    expect(presented).toEqual(["reconnect"]);
  });

  test("presents nothing when neither offer arms", () => {
    const presented: string[] = [];
    presentSendRecoveryOffer({
      credential: null,
      reconnect: null,
      presentCredentialRecovery: () => {
        presented.push("credential");
      },
      presentReconnectRecovery: () => {
        presented.push("reconnect");
      },
    });
    expect(presented).toEqual([]);
    expect(() =>
      presentSendRecoveryOffer({ credential: null, reconnect: null }),
    ).not.toThrow();
  });
});
