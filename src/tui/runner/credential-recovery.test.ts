import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@intx/types/runtime";
import {
  applyCredentialRecoverySelection,
  buildCredentialRecoveryAlternatives,
  buildCredentialRecoveryContinuationMessage,
  createCredentialRecoveryState,
} from "./credential-recovery.js";
import { modelOptionId, modelOptionRef } from "../model-catalog.js";

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
    attachments: [
      {
        name: "screen.png",
        contentType: "image/png",
        data: new Uint8Array([1, 2, 3]),
      },
    ],
  };
}

function required<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`expected ${label}`);
  return value;
}

const providers = [
  {
    name: "failed",
    baseURL: "https://failed.test/v1",
    apiKey: "failed-key",
    models: ["same", "other"],
  },
  {
    name: "backup",
    baseURL: "https://backup.test/v1",
    apiKey: "backup-key",
    models: ["model-a", "model-a", "model-b"],
  },
  {
    name: "broken",
    baseURL: "",
    apiKey: "",
    models: ["not-assemblable"],
  },
];

describe("credential recovery alternatives", () => {
  test("exclude the failed provider, deduplicate, and retain only assemblable rows", () => {
    expect(
      buildCredentialRecoveryAlternatives(
        {
          providers,
          providerName: "failed",
          model: "same",
        } as never,
        "session-1",
        "failed",
      ).map(({ id, provider, model }) => ({ id, provider, model })),
    ).toEqual([
      {
        id: modelOptionId("backup", "model-a"),
        provider: "backup",
        model: "model-a",
      },
      {
        id: modelOptionId("backup", "model-b"),
        provider: "backup",
        model: "model-b",
      },
    ]);
  });

  test("keeps colon-bearing provider and model identities distinct", () => {
    const alternatives = buildCredentialRecoveryAlternatives(
      {
        providers: [
          providers[0],
          {
            name: "backup:west",
            baseURL: "https://west.test/v1",
            apiKey: "west-key",
            models: ["model:fast"],
          },
          {
            name: "backup",
            baseURL: "https://backup.test/v1",
            apiKey: "backup-key",
            models: ["west:model:fast"],
          },
        ],
        providerName: "failed",
        model: "same",
      } as never,
      "session-colons",
      "failed",
    );

    expect(alternatives).toHaveLength(2);
    expect(alternatives.map((alternative) => alternative.id)).toEqual([
      modelOptionId("backup:west", "model:fast"),
      modelOptionId("backup", "west:model:fast"),
    ]);
  });
});

describe("generation-scoped credential recovery", () => {
  test("arms only after a repeated terminal credential failure and preserves the original input", () => {
    const state = createCredentialRecoveryState();
    const message = operatorMessage();
    const attempt = state.begin(message, "failed");

    state.observe(attempt, {
      type: "inference.retry",
      data: {
        previousError: { category: "credential_failure", message: "401" },
      },
    });
    state.observe(attempt, {
      type: "inference.error",
      data: { error: { category: "credential_failure", message: "still 401" } },
    });

    const pending = state.settle(attempt, [
      {
        id: modelOptionId("backup", "model-a"),
        label: "model-a * [backup]",
        provider: "backup",
        model: "model-a",
      },
    ]);
    expect(pending?.message).toBe(message);
    expect(pending?.message.attachments).toEqual(message.attachments);
  });

  test("does not arm for one credential failure, a noncredential terminal, or no alternatives", () => {
    const state = createCredentialRecoveryState();
    const oneFailure = state.begin(operatorMessage(), "failed");
    state.observe(oneFailure, {
      type: "inference.error",
      data: { error: { category: "credential_failure", message: "401" } },
    });
    expect(state.settle(oneFailure, [])).toBeNull();

    const otherFailure = state.begin(operatorMessage(), "failed");
    state.observe(otherFailure, {
      type: "inference.retry",
      data: {
        previousError: { category: "credential_failure", message: "401" },
      },
    });
    state.observe(otherFailure, {
      type: "inference.error",
      data: { error: { category: "fatal", message: "boom" } },
    });
    expect(
      state.settle(otherFailure, [
        {
          id: modelOptionId("backup", "model-a"),
          label: "backup",
          provider: "backup",
          model: "model-a",
        },
      ]),
    ).toBeNull();
  });

  test("cancel consumes the matching generation without switching or replaying", () => {
    const state = createCredentialRecoveryState();
    const attempt = state.begin(operatorMessage(), "failed");
    state.observe(attempt, {
      type: "inference.retry",
      data: {
        previousError: { category: "credential_failure", message: "401" },
      },
    });
    state.observe(attempt, {
      type: "inference.error",
      data: { error: { category: "credential_failure", message: "401" } },
    });
    const pending = required(
      state.settle(attempt, [
        {
          id: modelOptionId("backup", "model-a"),
          label: "backup",
          provider: "backup",
          model: "model-a",
        },
      ]),
      "pending recovery",
    );
    expect(state.cancel(pending.generation)).toBe(true);
    expect(
      state.accept(pending.generation, modelOptionId("backup", "model-a")),
    ).toEqual({
      kind: "stale",
    });
  });

  test("accept consumes once, validates generation, and vetoes replay after commitment", () => {
    const state = createCredentialRecoveryState();
    const first = state.begin(operatorMessage(), "failed");
    state.observe(first, {
      type: "inference.retry",
      data: {
        previousError: { category: "credential_failure", message: "401" },
      },
    });
    state.observe(first, {
      type: "inference.error",
      data: { error: { category: "credential_failure", message: "401" } },
    });
    const pending = required(
      state.settle(first, [
        {
          id: modelOptionId("backup", "model-a"),
          label: "backup",
          provider: "backup",
          model: "model-a",
        },
      ]),
      "pending recovery",
    );

    expect(
      state.accept(pending.generation + 1, modelOptionId("backup", "model-a")),
    ).toEqual({
      kind: "stale",
    });
    expect(
      state.accept(pending.generation, modelOptionId("backup", "model-a")),
    ).toEqual({
      kind: "accepted",
      alternative: required(pending.alternatives[0] ?? null, "alternative"),
      replay: true,
      generation: pending.generation,
    });
    expect(
      state.accept(pending.generation, modelOptionId("backup", "model-a")),
    ).toEqual({
      kind: "stale",
    });

    const committed = state.begin(operatorMessage(), "failed");
    state.observe(committed, {
      type: "inference.retry",
      data: {
        previousError: { category: "credential_failure", message: "401" },
      },
    });
    state.observe(committed, {
      type: "inference.text.delta",
      data: { delta: "x" },
    });
    state.observe(committed, {
      type: "inference.error",
      data: { error: { category: "credential_failure", message: "401" } },
    });
    const committedPending = required(
      state.settle(committed, [
        {
          id: modelOptionId("backup", "model-a"),
          label: "backup",
          provider: "backup",
          model: "model-a",
        },
      ]),
      "committed pending recovery",
    );
    expect(
      state.accept(
        committedPending.generation,
        modelOptionId("backup", "model-a"),
      ),
    ).toMatchObject({ kind: "accepted", replay: false });
  });

  test("a new generation invalidates an older selection and invalid rows consume without replay", () => {
    const state = createCredentialRecoveryState();
    const old = state.begin(operatorMessage(), "failed");
    state.observe(old, {
      type: "inference.retry",
      data: {
        previousError: { category: "credential_failure", message: "401" },
      },
    });
    state.observe(old, {
      type: "inference.error",
      data: { error: { category: "credential_failure", message: "401" } },
    });
    const oldPending = required(
      state.settle(old, [
        {
          id: modelOptionId("backup", "model-a"),
          label: "backup",
          provider: "backup",
          model: "model-a",
        },
      ]),
      "old pending recovery",
    );
    state.begin(operatorMessage(), "failed");
    expect(
      state.accept(oldPending.generation, modelOptionId("backup", "model-a")),
    ).toEqual({
      kind: "stale",
    });

    const current = state.begin(operatorMessage(), "failed");
    state.observe(current, {
      type: "inference.retry",
      data: {
        previousError: { category: "credential_failure", message: "401" },
      },
    });
    state.observe(current, {
      type: "inference.error",
      data: { error: { category: "credential_failure", message: "401" } },
    });
    const pending = required(
      state.settle(current, [
        {
          id: modelOptionId("backup", "model-a"),
          label: "backup",
          provider: "backup",
          model: "model-a",
        },
      ]),
      "current pending recovery",
    );
    expect(
      state.accept(pending.generation, modelOptionId("missing", "model")),
    ).toEqual({
      kind: "invalid",
    });
    expect(
      state.accept(pending.generation, modelOptionId("backup", "model-a")),
    ).toEqual({
      kind: "stale",
    });
  });

  test("a background continuation preserves an actionable operator selection", () => {
    const { state, pending } = pendingRecovery();

    state.begin(buildCredentialRecoveryContinuationMessage(99), "failed");

    expect(
      state.accept(pending.generation, modelOptionId("backup", "model-a")),
    ).toMatchObject({
      kind: "accepted",
      replay: true,
    });
  });
});

function pendingRecovery(committed = false) {
  const state = createCredentialRecoveryState();
  const attempt = state.begin(operatorMessage(), "failed");
  state.observe(attempt, {
    type: "inference.retry",
    data: { previousError: { category: "credential_failure" } },
  });
  if (committed) {
    state.observe(attempt, {
      type: "inference.thinking.delta",
      data: { delta: "thinking" },
    });
  }
  state.observe(attempt, {
    type: "inference.error",
    data: { error: { category: "credential_failure" } },
  });
  const pending = state.settle(attempt, [
    {
      id: modelOptionId("backup", "model-a"),
      label: "backup",
      provider: "backup",
      model: "model-a",
    },
  ]);
  if (pending === null) throw new Error("expected pending recovery");
  return { state, pending };
}

describe("credential recovery selection effects", () => {
  test("applies the exact colon-bearing pair and replays once", () => {
    const state = createCredentialRecoveryState();
    const attempt = state.begin(operatorMessage(), "failed");
    state.observe(attempt, {
      type: "inference.retry",
      data: { previousError: { category: "credential_failure" } },
    });
    state.observe(attempt, {
      type: "inference.error",
      data: { error: { category: "credential_failure" } },
    });
    const id = modelOptionId("backup:west", "model:fast");
    const alternative = {
      id,
      label: "model:fast * [backup:west]",
      provider: "backup:west",
      model: "model:fast",
    };
    const pending = required(state.settle(attempt, [alternative]), "pending");
    const switched: (typeof alternative)[] = [];
    const delivered: InboundMessage[] = [];

    expect(
      applyCredentialRecoverySelection({
        state,
        generation: pending.generation,
        alternativeId: id,
        switchAlternative: (selected) => switched.push(selected),
        armContinuation: () => undefined,
        cancelContinuation: () => undefined,
        deliverContinuation: (message) => delivered.push(message),
      }),
    ).toBe("continued");
    expect(switched).toEqual([alternative]);
    expect(modelOptionRef(switched[0]?.id ?? "")).toEqual({
      provider: "backup:west",
      model: "model:fast",
    });
    expect(delivered).toHaveLength(1);
    expect(state.accept(pending.generation, id)).toEqual({ kind: "stale" });
  });

  test("switches and continues an uncommitted input exactly once", () => {
    const { state, pending } = pendingRecovery();
    const switches: string[] = [];
    const arms: number[] = [];
    const deliveries: InboundMessage[] = [];
    const args = {
      state,
      generation: pending.generation,
      alternativeId: modelOptionId("backup", "model-a"),
      switchAlternative: (alternative: { id: string }) =>
        switches.push(alternative.id),
      armContinuation: (generation: number) => arms.push(generation),
      cancelContinuation: () => undefined,
      deliverContinuation: (message: InboundMessage) =>
        deliveries.push(message),
    };

    expect(applyCredentialRecoverySelection(args)).toBe("continued");
    expect(applyCredentialRecoverySelection(args)).toBe("stale");
    expect(switches).toEqual([modelOptionId("backup", "model-a")]);
    expect(arms).toEqual([pending.generation]);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.content).toBe("");
  });

  test("committed input switches future source without continuation", () => {
    const { state, pending } = pendingRecovery(true);
    let switches = 0;
    let deliveries = 0;
    expect(
      applyCredentialRecoverySelection({
        state,
        generation: pending.generation,
        alternativeId: modelOptionId("backup", "model-a"),
        switchAlternative: () => switches++,
        armContinuation: () => {
          throw new Error("must not arm");
        },
        cancelContinuation: () => undefined,
        deliverContinuation: () => deliveries++,
      }),
    ).toBe("switched");
    expect(switches).toBe(1);
    expect(deliveries).toBe(0);
  });

  test("switch and continuation failures consume without cascading", () => {
    const failedSwitch = pendingRecovery();
    let arms = 0;
    expect(
      applyCredentialRecoverySelection({
        state: failedSwitch.state,
        generation: failedSwitch.pending.generation,
        alternativeId: modelOptionId("backup", "model-a"),
        switchAlternative: () => {
          throw new Error("unavailable");
        },
        armContinuation: () => arms++,
        cancelContinuation: () => undefined,
        deliverContinuation: () => {
          throw new Error("must not deliver");
        },
      }),
    ).toBe("switch-failed");
    expect(arms).toBe(0);

    const failedDelivery = pendingRecovery();
    const cancelled: number[] = [];
    expect(
      applyCredentialRecoverySelection({
        state: failedDelivery.state,
        generation: failedDelivery.pending.generation,
        alternativeId: modelOptionId("backup", "model-a"),
        switchAlternative: () => undefined,
        armContinuation: () => undefined,
        cancelContinuation: (generation) => cancelled.push(generation),
        deliverContinuation: () => {
          throw new Error("closed");
        },
      }),
    ).toBe("switched");
    expect(cancelled).toEqual([failedDelivery.pending.generation]);
    expect(
      failedDelivery.state.accept(
        failedDelivery.pending.generation,
        modelOptionId("backup", "model-a"),
      ),
    ).toEqual({ kind: "stale" });
  });

  test("an invalid identity cannot switch or arm continuation", () => {
    const { state, pending } = pendingRecovery();
    let switches = 0;
    let arms = 0;
    expect(
      applyCredentialRecoverySelection({
        state,
        generation: pending.generation,
        alternativeId: "not-an-option-id",
        switchAlternative: () => switches++,
        armContinuation: () => arms++,
        cancelContinuation: () => undefined,
        deliverContinuation: () => {
          throw new Error("must not deliver");
        },
      }),
    ).toBe("invalid");
    expect(switches).toBe(0);
    expect(arms).toBe(0);
  });
});

test("credential recovery continuation is a dedicated contentless system inbound", () => {
  const message = buildCredentialRecoveryContinuationMessage(7);
  expect(message.ref).toEqual({ uid: 0, mailbox: "system" });
  expect(message.content).toBe("");
  expect(message.attachments).toBeUndefined();
  expect(message.headers.interchangeType).toBe("system.credential.refresh");
  expect(message.headers.interchangeCorrelationId).toBe("7");
});
