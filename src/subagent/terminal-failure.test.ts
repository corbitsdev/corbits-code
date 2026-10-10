import { describe, expect, test } from "bun:test";

import { createResolvedProviderFailureError } from "../inference-error-message.js";
import {
  classifySubAgentFailure,
  createSubAgentLoopGuardError,
  failureClassForStopReason,
  isProviderFailureClass,
  isSubAgentLoopGuardError,
  recoveryFor,
} from "./terminal-failure.js";

function providerError(category: string): Error {
  return createResolvedProviderFailureError("test-provider", {
    category,
    message: `provider said ${category}`,
  });
}

function permissionSuspension(): Error {
  // Same shape assertReplySend throws when a worker send parks on a gate.
  return Object.assign(
    new Error("Sub-agent send returned a suspended result"),
    {
      suspendedType: "suspended",
      correlationId: "corr-1",
    },
  );
}

describe("classifySubAgentFailure", () => {
  test.each([
    ["retryable", "provider_retryable"],
    ["timeout", "provider_retryable"],
    ["credential_failure", "provider_fatal"],
    ["quota_exhausted", "provider_fatal"],
    ["context_overflow", "provider_fatal"],
    ["fatal", "provider_fatal"],
  ] as const)("resolved provider category %s is %s", (category, expected) => {
    expect(classifySubAgentFailure(providerError(category))).toBe(expected);
  });

  test("a loop-guard stop is loop_guard, never a provider class", () => {
    const wrapped = createSubAgentLoopGuardError(
      new Error("reactor error: Doom loop detected: x"),
    );
    expect(classifySubAgentFailure(wrapped)).toBe("loop_guard");
    expect(
      classifySubAgentFailure(wrapped, { providerFailureObserved: true }),
    ).toBe("loop_guard");
    expect(
      classifySubAgentFailure(
        createSubAgentLoopGuardError(providerError("retryable")),
      ),
    ).toBe("loop_guard");
  });

  test("the loop-guard wrapper keeps the cause's message", () => {
    const cause = new Error("reactor error: Doom loop detected: x");
    const wrapped = createSubAgentLoopGuardError(cause);
    expect(wrapped.message).toBe(cause.message);
    expect(wrapped.cause).toBe(cause);
    expect(isSubAgentLoopGuardError(wrapped)).toBe(true);
    const lookalike = new Error(cause.message);
    lookalike.name = "SubAgentLoopGuardError";
    expect(isSubAgentLoopGuardError(lookalike)).toBe(false);
  });

  test("a permission suspension is error even after an observed inference.error", () => {
    expect(
      classifySubAgentFailure(permissionSuspension(), {
        providerFailureObserved: true,
      }),
    ).toBe("error");
  });

  test("an unclassified throw is error unless the fleet saw inference.error last", () => {
    expect(classifySubAgentFailure(new Error("boom"))).toBe("error");
    expect(
      classifySubAgentFailure(new Error("boom"), {
        providerFailureObserved: true,
      }),
    ).toBe("provider_fatal");
  });

  test("forced-stop reasons map onto their own classes", () => {
    expect(failureClassForStopReason("stalled")).toBe("stalled");
    expect(failureClassForStopReason("deadline")).toBe("deadline");
    expect(failureClassForStopReason("incomplete-report")).toBe(
      "incomplete_report",
    );
    expect(failureClassForStopReason("cancelled")).toBe("cancelled");
    expect(failureClassForStopReason("interrupted")).toBe("interrupted");
  });

  test("only provider classes count as provider failures", () => {
    expect(isProviderFailureClass("provider_retryable")).toBe(true);
    expect(isProviderFailureClass("provider_fatal")).toBe(true);
    expect(isProviderFailureClass("loop_guard")).toBe(false);
    expect(isProviderFailureClass("error")).toBe(false);
  });
});

describe("recoveryFor", () => {
  test("a retryable failure on the original spawn is eligible", () => {
    expect(
      recoveryFor({
        failureClass: "provider_retryable",
        attempt: 1,
        followupTurn: false,
      }),
    ).toEqual({ available: true, reason: "eligible" });
  });

  test.each([
    "provider_fatal",
    "loop_guard",
    "cancelled",
    "stalled",
    "error",
  ] as const)("%s is not_retryable", (failureClass) => {
    expect(
      recoveryFor({ failureClass, attempt: 1, followupTurn: false }),
    ).toEqual({ available: false, reason: "not_retryable" });
  });

  test("a retryable failure on a follow-up turn is not_retryable", () => {
    expect(
      recoveryFor({
        failureClass: "provider_retryable",
        attempt: 1,
        followupTurn: true,
      }),
    ).toEqual({ available: false, reason: "not_retryable" });
  });

  test("a failed recovery attempt is exhausted whatever its class", () => {
    for (const failureClass of ["provider_retryable", "error"] as const) {
      expect(
        recoveryFor({ failureClass, attempt: 2, followupTurn: false }),
      ).toEqual({ available: false, reason: "recovery_exhausted" });
    }
  });
});
