import { expect, test } from "bun:test";

import {
  deriveTerminalOutcome,
  deriveVerificationBlockedOutcome,
  decideEscalation,
  ESCALATION_TEXT_MAX_BYTES,
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
      questionId: "ask-1",
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

test("parked classifications require fact-3 alternative content (Nit 1)", () => {
  const noAlternatives = parseEscalationAssessment({
    ...assessment,
    permittedAlternatives: [],
  });
  expect(noAlternatives).toBeInstanceOf(Error);
  if (noAlternatives instanceof Error) {
    expect(noAlternatives.message).toContain("permitted alternative");
  }
  const directorResolvable = parseEscalationAssessment({
    ...assessment,
    classification: "director_resolvable",
  });
  expect(directorResolvable).not.toBeInstanceOf(Error);
});

test("recommendation and safeDefault are independent optional facts (Nit 1)", () => {
  const withRecommendationOnly = parseEscalationAssessment({
    ...assessment,
    safeDefault: undefined,
  });
  expect(withRecommendationOnly).not.toBeInstanceOf(Error);
  if (withRecommendationOnly instanceof Error) return;
  expect(withRecommendationOnly.recommendation).toBe(
    "Decline unless the snapshot is necessary.",
  );
  expect(withRecommendationOnly.safeDefault).toBeUndefined();

  const withSafeDefaultOnly = parseEscalationAssessment({
    ...assessment,
    recommendation: undefined,
  });
  expect(withSafeDefaultOnly).not.toBeInstanceOf(Error);
});

test("requestedMechanism must differ from minimumAuthority (Nit 2)", () => {
  const conflated = parseEscalationAssessment({
    ...assessment,
    requestedMechanism: "authenticated read-only snapshot",
    minimumAuthority: "authenticated read-only snapshot",
  });
  expect(conflated).toBeInstanceOf(Error);
  if (conflated instanceof Error) {
    expect(conflated.message).toContain("differ from minimumAuthority");
  }
});

test("a declined non-verification ask still records a consistent outcome (SF3)", () => {
  const parsed = parseEscalationAssessment({
    ...assessment,
    verification: undefined,
  });
  expect(parsed).not.toBeInstanceOf(Error);
  if (parsed instanceof Error) return;
  const outcome = deriveTerminalOutcome(parsed, {
    kind: "declined",
    answer: "No.",
    questionId: "ask-1",
  });
  expect(outcome).toMatchObject({
    kind: "declined",
    resolution: "declined",
    declineConsequence:
      "Implementation is complete but verification is blocked.",
  });
});

test("director_resolvable is a parent-only directive, never operator wording (SF8)", () => {
  const parsed = parseEscalationAssessment({
    ...assessment,
    classification: "director_resolvable",
  });
  expect(parsed).not.toBeInstanceOf(Error);
  if (parsed instanceof Error) return;
  expect(decideEscalation(parsed).kind).toBe("park_parent");
  const rendered = renderEscalationDecision({
    sessionId: "worker-1",
    questionId: "ask-1",
    assessment: parsed,
  });
  expect(rendered).not.toMatch(/operator/i);
  expect(rendered).toContain("send_input");
});

test("long fields cannot drop the authority line or the send_input instruction (SF4)", () => {
  const long = parseEscalationAssessment({
    ...assessment,
    blockedOutcome: "x".repeat(4000),
    unavailableDirectorPath: "y".repeat(4000),
  });
  expect(long).not.toBeInstanceOf(Error);
  if (long instanceof Error) return;
  const rendered = renderEscalationDecision({
    sessionId: "worker-1",
    questionId: "ask-1",
    assessment: long,
  });
  expect(rendered).toContain("Minimum authority/decision:");
  expect(rendered).toContain("authenticated read-only snapshot");
  expect(rendered).toContain("send_input");
  expect(rendered).toContain("x".repeat(4000));
  expect(rendered).not.toContain("\uFFFD");
});

test("byte truncation never splits a multi-byte character (SF4)", () => {
  const nearCap = parseEscalationAssessment({
    ...assessment,
    blockedOutcome: "a".repeat(ESCALATION_TEXT_MAX_BYTES - 3) + "🎯",
  });
  expect(nearCap).not.toBeInstanceOf(Error);
  if (nearCap instanceof Error) return;
  expect(nearCap.blockedOutcome).not.toContain("\uFFFD");
  const rendered = renderEscalationDecision({
    sessionId: "worker-1",
    questionId: "ask-1",
    assessment: nearCap,
  });
  expect(rendered).not.toContain("\uFFFD");
  expect(rendered).toContain("Minimum authority/decision:");
});

test("structured parent resolution is closed and carries no authority", () => {
  expect(
    parseEscalationResolution({
      kind: "minimum_grant_available",
      answer: "The minimum decision is available; continue your next turn.",
      questionId: "ask-1",
    }),
  ).toEqual({
    kind: "minimum_grant_available",
    answer: "The minimum decision is available; continue your next turn.",
    questionId: "ask-1",
  });
  expect(
    parseEscalationResolution({
      kind: "grant",
      answer: "retry this command",
      command: "unsafe",
      questionId: "ask-1",
    }),
  ).toBeInstanceOf(Error);
});

test("structured resolution requires questionId and names the valid kinds", () => {
  const missing = parseEscalationResolution({
    kind: "declined",
    answer: "No.",
  });
  expect(missing).toBeInstanceOf(Error);
  const invalid = parseEscalationResolution({
    kind: "grant",
    answer: "No.",
    questionId: "ask-1",
  });
  expect(invalid).toBeInstanceOf(Error);
  if (invalid instanceof Error) {
    expect(invalid.message).toContain("director_answer");
    expect(invalid.message).toContain("declined");
    expect(invalid.message).toContain("unavailable");
    expect(invalid.message).toContain("minimum_grant_available");
  }
});
