export const ESCALATION_POLICY_VERSION = "1" as const;
export const ESCALATION_TEXT_MAX_BYTES = 4096;

export const ESCALATION_CLASSIFICATIONS = [
  "routine",
  "director_resolvable",
  "operator_decision_required",
  "outcome_blocked",
  "irreversible_or_sensitive",
] as const;
export type EscalationClassification =
  (typeof ESCALATION_CLASSIFICATIONS)[number];

export interface PermittedAlternative {
  readonly attempted: string;
  readonly result: string;
  readonly comparableConfidence: boolean;
}

export interface VerificationDetail {
  readonly verificationOutcome: string;
  readonly rootCause: string;
  readonly attemptedNarrowChecks: readonly string[];
  readonly reducedConfidence: string;
}

export interface EscalationAssessment {
  readonly policyVersion: typeof ESCALATION_POLICY_VERSION;
  readonly classification: EscalationClassification;
  readonly blockedOutcome: string;
  readonly unavailableDirectorPath: string;
  readonly permittedAlternatives: readonly PermittedAlternative[];
  readonly minimumAddition: string;
  readonly declineConsequence: string;
  readonly recommendation?: string;
  readonly safeDefault?: string;
  readonly requestedMechanism?: string;
  readonly minimumAuthority?: string;
  readonly verification?: VerificationDetail;
}

export type EscalationResolution =
  | {
      readonly kind: "director_answer";
      readonly answer: string;
      readonly questionId: string;
    }
  | {
      readonly kind: "declined";
      readonly answer: string;
      readonly questionId: string;
    }
  | {
      readonly kind: "unavailable";
      readonly answer: string;
      readonly questionId: string;
    }
  | {
      readonly kind: "minimum_grant_available";
      readonly answer: string;
      readonly questionId: string;
    };

export type EscalationDirective =
  | {
      readonly kind: "continue_internal";
      readonly assessment: EscalationAssessment;
    }
  | { readonly kind: "park_parent"; readonly assessment: EscalationAssessment };

export interface VerificationBlockedOutcome {
  readonly kind: "verification_blocked";
  readonly implementationReviewComplete: true;
  readonly verificationOutcome: string;
  readonly rootCause: string;
  readonly alternatives: readonly PermittedAlternative[];
  readonly resolution: "declined" | "unavailable";
  readonly reducedConfidence: string;
  readonly recommendation?: string;
}

/** A decline/unavailability on a non-verification ask still records an outcome. */
export interface DeclinedOutcome {
  readonly kind: "declined";
  readonly resolution: "declined" | "unavailable";
  readonly declineConsequence: string;
  readonly recommendation?: string;
}

/** Explicit worker-reported successful verification replaces a blocked outcome. */
export interface VerifiedOutcome {
  readonly kind: "verified";
  readonly verificationOutcome: string;
}

export type TerminalOutcome =
  | VerificationBlockedOutcome
  | DeclinedOutcome
  | VerifiedOutcome;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
/** Byte-bounded on a character boundary so a slice never splits a code point. */
const bounded = (value: string): string => {
  if (new TextEncoder().encode(value).byteLength <= ESCALATION_TEXT_MAX_BYTES)
    return value;
  let kept = "";
  let bytes = 0;
  for (const ch of Array.from(value)) {
    const size = new TextEncoder().encode(ch).byteLength;
    if (bytes + size > ESCALATION_TEXT_MAX_BYTES) break;
    kept += ch;
    bytes += size;
  }
  return kept;
};
const text = (value: unknown, field: string): string | Error =>
  nonEmpty(value)
    ? bounded(value.trim())
    : new Error(`escalation.${field} must be a non-empty string.`);

/** Validates the explicit parent decision; it never carries authority or a call. */
export function parseEscalationResolution(
  raw: unknown,
): EscalationResolution | Error {
  if (!isRecord(raw)) return new Error("resolution must be an object.");
  const { kind } = raw;
  if (
    kind !== "director_answer" &&
    kind !== "declined" &&
    kind !== "unavailable" &&
    kind !== "minimum_grant_available"
  ) {
    return new Error(
      "resolution.kind must be one of: director_answer, declined, unavailable, minimum_grant_available.",
    );
  }
  const questionId = text(raw.questionId, "resolution.questionId");
  if (questionId instanceof Error) return questionId;
  const answer = text(raw.answer, "resolution.answer");
  if (answer instanceof Error) return answer;
  return { kind, answer, questionId };
}

/** Validates tool-boundary data before it can create a parked parent ask. */
export function parseEscalationAssessment(
  raw: unknown,
): EscalationAssessment | Error {
  if (!isRecord(raw))
    return new Error("ask_director requires escalation (object).");
  if (raw.policyVersion !== ESCALATION_POLICY_VERSION)
    return new Error(
      `escalation.policyVersion must be ${ESCALATION_POLICY_VERSION}.`,
    );
  const classification = raw.classification;
  if (
    typeof classification !== "string" ||
    !ESCALATION_CLASSIFICATIONS.includes(
      classification as EscalationClassification,
    )
  )
    return new Error("escalation.classification is not recognized.");
  const fields = [
    "blockedOutcome",
    "unavailableDirectorPath",
    "minimumAddition",
    "declineConsequence",
  ] as const;
  const parsed = fields.map((field) => text(raw[field], field));
  const invalid = parsed.find(
    (value): value is Error => value instanceof Error,
  );
  if (invalid !== undefined) return invalid;
  if (!Array.isArray(raw.permittedAlternatives))
    return new Error("escalation.permittedAlternatives must be an array.");
  const alternatives: PermittedAlternative[] = [];
  for (const [index, alternative] of raw.permittedAlternatives.entries()) {
    if (!isRecord(alternative))
      return new Error(
        `escalation.permittedAlternatives[${index}] must be an object.`,
      );
    const attempted = text(
      alternative.attempted,
      `permittedAlternatives[${index}].attempted`,
    );
    const result = text(
      alternative.result,
      `permittedAlternatives[${index}].result`,
    );
    if (attempted instanceof Error) return attempted;
    if (result instanceof Error) return result;
    if (typeof alternative.comparableConfidence !== "boolean")
      return new Error(
        `escalation.permittedAlternatives[${index}].comparableConfidence must be boolean.`,
      );
    alternatives.push({
      attempted,
      result,
      comparableConfidence: alternative.comparableConfidence,
    });
  }
  // Fact 3 content is mandatory for every parked/surfaced classification:
  // an empty alternatives list would let a worker park without showing the
  // permitted paths already considered. `routine` instead requires a
  // comparable alternative below.
  if (classification !== "routine" && alternatives.length === 0)
    return new Error(
      "parked escalation requires at least one permitted alternative considered.",
    );
  const optionalText = (field: string): string | Error | undefined =>
    raw[field] === undefined ? undefined : text(raw[field], field);
  const requestedMechanism = optionalText("requestedMechanism");
  const minimumAuthority = optionalText("minimumAuthority");
  const recommendation = optionalText("recommendation");
  const safeDefault = optionalText("safeDefault");
  for (const value of [
    requestedMechanism,
    minimumAuthority,
    recommendation,
    safeDefault,
  ])
    if (value instanceof Error) return value;
  const requestedMechanismValue = requestedMechanism as string | undefined;
  const minimumAuthorityValue = minimumAuthority as string | undefined;
  const recommendationValue = recommendation as string | undefined;
  const safeDefaultValue = safeDefault as string | undefined;
  if (
    requestedMechanismValue !== undefined &&
    minimumAuthorityValue !== undefined &&
    requestedMechanismValue === minimumAuthorityValue
  )
    return new Error(
      "escalation.requestedMechanism must differ from minimumAuthority.",
    );
  if (
    (classification === "operator_decision_required" ||
      classification === "irreversible_or_sensitive") &&
    minimumAuthorityValue === undefined
  )
    return new Error(
      `escalation.minimumAuthority is required for ${classification}.`,
    );
  if (
    classification === "routine" &&
    !alternatives.some((alternative) => alternative.comparableConfidence)
  )
    return new Error(
      "routine escalation requires a comparable permitted alternative.",
    );
  let verification: VerificationDetail | undefined;
  if (raw.verification !== undefined) {
    if (!isRecord(raw.verification))
      return new Error("escalation.verification must be an object.");
    const verificationOutcome = text(
      raw.verification.verificationOutcome,
      "verification.verificationOutcome",
    );
    const rootCause = text(
      raw.verification.rootCause,
      "verification.rootCause",
    );
    const reducedConfidence = text(
      raw.verification.reducedConfidence,
      "verification.reducedConfidence",
    );
    if (verificationOutcome instanceof Error) return verificationOutcome;
    if (rootCause instanceof Error) return rootCause;
    if (reducedConfidence instanceof Error) return reducedConfidence;
    if (
      !Array.isArray(raw.verification.attemptedNarrowChecks) ||
      !raw.verification.attemptedNarrowChecks.every(nonEmpty)
    )
      return new Error(
        "escalation.verification.attemptedNarrowChecks must contain non-empty strings.",
      );
    verification = {
      verificationOutcome,
      rootCause,
      reducedConfidence,
      attemptedNarrowChecks: raw.verification.attemptedNarrowChecks.map(
        (item) => bounded(item.trim()),
      ),
    };
  }
  return {
    policyVersion: ESCALATION_POLICY_VERSION,
    classification: classification as EscalationClassification,
    blockedOutcome: parsed[0] as string,
    unavailableDirectorPath: parsed[1] as string,
    minimumAddition: parsed[2] as string,
    declineConsequence: parsed[3] as string,
    permittedAlternatives: alternatives,
    ...(requestedMechanismValue !== undefined
      ? { requestedMechanism: requestedMechanismValue }
      : {}),
    ...(minimumAuthorityValue !== undefined
      ? { minimumAuthority: minimumAuthorityValue }
      : {}),
    ...(recommendationValue !== undefined
      ? { recommendation: recommendationValue }
      : {}),
    ...(safeDefaultValue !== undefined
      ? { safeDefault: safeDefaultValue }
      : {}),
    ...(verification !== undefined ? { verification } : {}),
  };
}

export const decideEscalation = (
  assessment: EscalationAssessment,
): EscalationDirective =>
  assessment.classification === "routine" ||
  assessment.permittedAlternatives.some(
    (alternative) => alternative.comparableConfidence,
  )
    ? { kind: "continue_internal", assessment }
    : { kind: "park_parent", assessment };

export const deriveVerificationBlockedOutcome = (
  assessment: EscalationAssessment,
  resolution: EscalationResolution,
): VerificationBlockedOutcome | undefined => {
  if (
    (resolution.kind !== "declined" && resolution.kind !== "unavailable") ||
    assessment.verification === undefined
  )
    return undefined;
  return {
    kind: "verification_blocked",
    implementationReviewComplete: true,
    verificationOutcome: assessment.verification.verificationOutcome,
    rootCause: assessment.verification.rootCause,
    alternatives: assessment.permittedAlternatives,
    resolution: resolution.kind,
    reducedConfidence: assessment.verification.reducedConfidence,
    ...(assessment.recommendation !== undefined
      ? { recommendation: assessment.recommendation }
      : {}),
  };
};

/**
 * Records a consistent decline/unavailability outcome for every ask. A
 * verification ask derives the typed `verification_blocked` outcome; any other
 * parked ask records the decline consequence so a structured decline can never
 * settle silently.
 */
export const deriveTerminalOutcome = (
  assessment: EscalationAssessment,
  resolution: EscalationResolution,
): TerminalOutcome | undefined => {
  if (resolution.kind !== "declined" && resolution.kind !== "unavailable")
    return undefined;
  if (assessment.verification !== undefined)
    return deriveVerificationBlockedOutcome(assessment, resolution);
  return {
    kind: "declined",
    resolution: resolution.kind,
    declineConsequence: assessment.declineConsequence,
    ...(assessment.recommendation !== undefined
      ? { recommendation: assessment.recommendation }
      : {}),
  };
};

/** Stable parent-facing text. It carries facts only; it cannot convey authority. */
export const renderEscalationDecision = (input: {
  sessionId: string;
  questionId: string;
  assessment: EscalationAssessment;
}): string => {
  const a = input.assessment;
  const alternatives =
    a.permittedAlternatives.length === 0
      ? "none recorded"
      : a.permittedAlternatives
          .map(
            (alternative) =>
              `${alternative.attempted}: ${alternative.result} (${alternative.comparableConfidence ? "comparable" : "not comparable"})`,
          )
          .join("; ");
  // Bound every field on its own (character-boundary) so a long field can
  // never truncate the mechanism-vs-authority separation or the send_input
  // instruction that follow it.
  const field = (label: string, value: string): string =>
    `${label} ${bounded(value)}`;
  return [
    `Worker decision required (${a.classification})`,
    `Target: ${input.sessionId} / ${input.questionId}`,
    field("Blocked outcome/verification:", a.blockedOutcome),
    field("Unavailable director path:", a.unavailableDirectorPath),
    field("Permitted alternatives considered:", alternatives),
    field("Minimum addition:", a.minimumAddition),
    field("Decline/proceed-without consequence:", a.declineConsequence),
    field("Safe default/recommendation:", a.recommendation ?? "none recorded"),
    field("Requested mechanism:", a.requestedMechanism ?? "none recorded"),
    field("Minimum authority/decision:", a.minimumAuthority ?? "none recorded"),
    "Reply with send_input (plain text or a structured resolution); this does not grant or retry a tool.",
  ].join("\n");
};
