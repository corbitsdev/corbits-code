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

export const FEEDBACK_THANKS = "Thanks — feedback queued.";

export const FEEDBACK_THANKS_TRUNCATED =
  "Thanks — feedback queued (truncated to 2000 characters).";

export const FEEDBACK_EMPTY = "No feedback text provided.";

export const FEEDBACK_BLOCKED =
  "Feedback could not be sent (disabled by environment or missing install identity).";

export const FEEDBACK_UNCONFIGURED =
  "Feedback is not configured (missing survey id). Set CORBITS_FEEDBACK_SURVEY_ID and CORBITS_FEEDBACK_QUESTION_ID.";

/**
 * PostHog survey id for /feedback. Set via CORBITS_FEEDBACK_SURVEY_ID once the
 * survey exists in the project (user creates it in PostHog UI).
 */
export function feedbackSurveyId(env: NodeJS.ProcessEnv = process.env): string {
  return env.CORBITS_FEEDBACK_SURVEY_ID?.trim() ?? "";
}

/**
 * Free-text question id inside the survey. Set via CORBITS_FEEDBACK_QUESTION_ID.
 */
export function feedbackQuestionId(env: NodeJS.ProcessEnv = process.env): string {
  return env.CORBITS_FEEDBACK_QUESTION_ID?.trim() ?? "";
}

/** True when both survey env ids are present (command is useful to show). */
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
        question: "What feedback do you have for Corbits Code?",
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
 * Capture intentional survey response. Returns whether the event was queued.
 * Empty/whitespace-only text is not sent. Missing survey/question ids fail closed.
 * "sent" means queued for flush (not a network delivery ack); "sent_truncated"
 * is the same after the free-text cap was applied.
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
  const ok = telemetry.captureIntentional(
    "survey sent",
    buildSurveyProperties(trimmed, options),
  );
  if (!ok) return "blocked";
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

/** Test helper — reset module state between cases. */
export function resetFeedbackStateForTests(): void {
  feedbackCapturePending = false;
  lastTurnTraceId = undefined;
}
