import { expect, test } from "bun:test";

import {
  deriveVerificationBlockedOutcome,
  decideEscalation,
  parseEscalationAssessment,
  parseEscalationResolution,
  renderEscalationDecision,
} from "./escalation-policy.js";

const assessment = {
  policyVersion: "1",
  classification: "operator_decision_required",
  blockedOutcome: "The authenticated verification result cannot be produced.",
  unavailableDirectorPath: "The director has no credential authority.",
  permittedAlternatives: [
    {
      attempted: "focused local test",
      result: "requires the missing credential",
      comparableConfidence: false,
    },
  ],
  minimumAddition: "Allow an authenticated read-only snapshot.",
  declineConsequence: "Implementation is complete but verification is blocked.",
  recommendation: "Decline unless the snapshot is necessary.",
  safeDefault: "Decline.",
  requestedMechanism: "broad web access",
  minimumAuthority: "authenticated read-only snapshot",
  verification: {
    verificationOutcome: "integration verification",
    rootCause: "missing test credential",
    attemptedNarrowChecks: ["focused local test"],
    reducedConfidence: "integration behavior remains unverified",
  },
} as const;

test("routine alternatives remain internal and never produce a parked directive", () => {
  const parsed = parseEscalationAssessment({
    ...assessment,
    classification: "routine",
    permittedAlternatives: [
      {
        attempted: "focused test",
        result: "passed",
        comparableConfidence: true,
      },
    ],
  });
  expect(parsed).not.toBeInstanceOf(Error);
  if (parsed instanceof Error) return;
  expect(decideEscalation(parsed).kind).toBe("continue_internal");
});

test("decision rendering distinguishes requested mechanism from minimum authority", () => {
  const parsed = parseEscalationAssessment(assessment);
  expect(parsed).not.toBeInstanceOf(Error);
  if (parsed instanceof Error) return;
  const rendered = renderEscalationDecision({
    sessionId: "worker-1",
    questionId: "ask-1",
    assessment: parsed,
  });
  expect(rendered).toContain("Requested mechanism: broad web access");
  expect(rendered).toContain(
    "Minimum authority/decision: authenticated read-only snapshot",
  );
  expect(rendered).toContain("Decline/proceed-without consequence:");
});

test("declined verification produces a distinct durable blocked outcome", () => {
  const parsed = parseEscalationAssessment(assessment);
  expect(parsed).not.toBeInstanceOf(Error);
  if (parsed instanceof Error) return;
  expect(
    deriveVerificationBlockedOutcome(parsed, {
      kind: "declined",
      answer: "No credential grant.",
    }),
  ).toMatchObject({
    kind: "verification_blocked",
    implementationReviewComplete: true,
    rootCause: "missing test credential",
    resolution: "declined",
  });
});

test("incomplete material requests are rejected", () => {
  expect(
    parseEscalationAssessment({
      policyVersion: "1",
      classification: "operator_decision_required",
    }),
  ).toBeInstanceOf(Error);
});

test("structured parent resolution is closed and carries no authority", () => {
  expect(
    parseEscalationResolution({
      kind: "minimum_grant_available",
      answer: "The minimum decision is available; continue your next turn.",
    }),
  ).toEqual({
    kind: "minimum_grant_available",
    answer: "The minimum decision is available; continue your next turn.",
  });
  expect(
    parseEscalationResolution({
      kind: "grant",
      answer: "retry this command",
      command: "unsafe",
    }),
  ).toBeInstanceOf(Error);
});
