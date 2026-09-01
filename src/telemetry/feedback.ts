// Intentional operator feedback via PostHog custom surveys (headless).
//
// Unlike ambient product events, this path can ship when settings.telemetry.enabled
// is false — the operator typed the text for that purpose. Env kill switches
// (DO_NOT_TRACK / CORBITS_TELEMETRY=0) still block send.

import type { Telemetry } from "./index.js";

/** Free-text cap for /feedback responses. */
export const FEEDBACK_MAX_CHARS = 2000;

export const FEEDBACK_PROMPT =
  "Please share your feedback. When done please hit enter. (Empty Enter cancels.)";

export const FEEDBACK_THANKS = "Thanks — feedback sent.";

export const FEEDBACK_THANKS_TRUNCATED = "Thanks — feedback sent (truncated to 2000 characters).";

export const FEEDBACK_EMPTY = "No feedback text provided.";

export const FEEDBACK_BLOCKED =
  "Feedback could not be sent (disabled by environment or missing install identity).";

export const FEEDBACK_UNCONFIGURED = "Feedback is not configured (missing survey id).";

/**
 * Corbits team survey — public routing ids (same trust class as the baked-in
 * PostHog project key). Operators never set these. Env override is for tests
 * and forks: when the env key is present (even empty), it wins over the default.
 */
export const DEFAULT_FEEDBACK_SURVEY_ID = "019fe7ff-d12a-0000-7a63-303f3a874b90";
export const DEFAULT_FEEDBACK_QUESTION_ID = "913862f4-82aa-4814-8f68-146c05c38a74";
export const FEEDBACK_QUESTION_TEXT = "What feedback do you have about Corbits Code?";

function envOverride(env: NodeJS.ProcessEnv, key: string): string | undefined {
  // Present key wins (including empty → fail closed for tests/forks).
  if (!Object.prototype.hasOwnProperty.call(env, key)) return undefined;
  return (env[key] ?? "").trim();
}

/** PostHog survey id for /feedback. */
export function feedbackSurveyId(env: NodeJS.ProcessEnv = process.env): string {
  return envOverride(env, "CORBITS_FEEDBACK_SURVEY_ID") ?? DEFAULT_FEEDBACK_SURVEY_ID;
}

/** Free-text question id inside the survey. */
export function feedbackQuestionId(env: NodeJS.ProcessEnv = process.env): string {
  return envOverride(env, "CORBITS_FEEDBACK_QUESTION_ID") ?? DEFAULT_FEEDBACK_QUESTION_ID;
}

/** True when both survey ids resolve (defaults always do unless env blanks them). */
export function isFeedbackConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return feedbackSurveyId(env).length > 0 && feedbackQuestionId(env).length > 0;
}

export function capFeedbackMessage(message: string): string {
  if (message.length <= FEEDBACK_MAX_CHARS) return message;
  return message.slice(0, FEEDBACK_MAX_CHARS);
}

/** PostHog custom-survey property bag for a free-text response. */
export function buildSurveyProperties(
  message: string,
  options: {
    turnTraceId?: string | undefined;
    env?: NodeJS.ProcessEnv;
  } = {},
): Record<string, unknown> {
  const env = options.env ?? process.env;
  const capped = capFeedbackMessage(message);
  const surveyId = feedbackSurveyId(env);
  const questionId = feedbackQuestionId(env);
  const props: Record<string, unknown> = {
    $survey_id: surveyId,
    $survey_response: capped,
    $survey_questions: [
      {
        id: questionId,
        question: FEEDBACK_QUESTION_TEXT,
        response: capped,
      },
    ],
  };
  if (options.turnTraceId !== undefined && options.turnTraceId.length > 0) {
    props.turn_trace_id = options.turnTraceId;
  }
  return props;
}

/**
 * Capture intentional survey response. Empty/whitespace-only text is not sent.
 * Missing survey/question ids fail closed. On success the event is enqueued and
 * flushed immediately (fire-and-forget) — not held for the ambient batch timer.
 * Status "sent" means the capture path accepted the payload; delivery is best-
 * effort over the network and is not awaited on the operator path.
 */
export function captureFeedback(
  telemetry: Telemetry,
  message: string,
  options: {
    turnTraceId?: string | undefined;
    env?: NodeJS.ProcessEnv;
  } = {},
): "empty" | "blocked" | "unconfigured" | "sent" | "sent_truncated" {
  const trimmed = message.trim();
  if (trimmed.length === 0) return "empty";
  const env = options.env ?? process.env;
  if (!isFeedbackConfigured(env)) {
    return "unconfigured";
  }
  const truncated = trimmed.length > FEEDBACK_MAX_CHARS;
  const ok = telemetry.captureIntentional("survey sent", buildSurveyProperties(trimmed, options));
  if (!ok) return "blocked";
  // Deterministic handoff to PostHog — not part of the agent loop. Flush so
  // the response is not sitting in the ambient batch queue until idle exit.
  void telemetry.flush();
  return truncated ? "sent_truncated" : "sent";
}

export function feedbackResultMessage(
  status: "empty" | "blocked" | "unconfigured" | "sent" | "sent_truncated",
): string {
  switch (status) {
    case "sent":
      return FEEDBACK_THANKS;
    case "sent_truncated":
      return FEEDBACK_THANKS_TRUNCATED;
    case "blocked":
      return FEEDBACK_BLOCKED;
    case "unconfigured":
      return FEEDBACK_UNCONFIGURED;
    case "empty":
      return FEEDBACK_EMPTY;
  }
}

// ── Pending multi-turn capture (bare `/feedback` then next Enter) ──────────

let feedbackCapturePending = false;
let lastTurnTraceId: string | undefined;
/** In-flight primary turn — set at inference.start, cleared when the turn settles. */
let currentTurnTraceId: string | undefined;

/** Arm after bare `/feedback` so the next non-command submit is treated as feedback. */
export function armFeedbackCapture(): void {
  feedbackCapturePending = true;
}

export function isFeedbackCapturePending(): boolean {
  return feedbackCapturePending;
}

/** Consume the pending flag. Returns true only once per arm. */
export function takeFeedbackCapture(): boolean {
  if (!feedbackCapturePending) return false;
  feedbackCapturePending = false;
  return true;
}

/** Cancel pending capture (e.g. on /clear). */
export function cancelFeedbackCapture(): void {
  feedbackCapturePending = false;
}

/** Remember the most recent AI turn trace for linking feedback. */
export function noteLastTurnTraceId(traceId: string): void {
  if (traceId.length > 0) lastTurnTraceId = traceId;
}

export function getLastTurnTraceId(): string | undefined {
  return lastTurnTraceId;
}

/**
 * Remember the in-flight turn's `$ai_trace_id` so `subagent_end` can link to the
 * turn that is still running when `spawn_agent` dispatch (not the
 * previous completed turn).
 */
export function noteCurrentTurnTraceId(traceId: string): void {
  if (traceId.length > 0) currentTurnTraceId = traceId;
}

export function getCurrentTurnTraceId(): string | undefined {
  return currentTurnTraceId;
}

export function clearCurrentTurnTraceId(): void {
  currentTurnTraceId = undefined;
}

/** Test helper — reset module state between cases. */
export function resetFeedbackStateForTests(): void {
  feedbackCapturePending = false;
  lastTurnTraceId = undefined;
  currentTurnTraceId = undefined;
}
