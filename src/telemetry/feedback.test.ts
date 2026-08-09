import { afterEach, describe, expect, test } from "bun:test";
import { createTelemetry, type Telemetry } from "./index.js";
import {
  armFeedbackCapture,
  buildSurveyProperties,
  cancelFeedbackCapture,
  capFeedbackMessage,
  captureFeedback,
  FEEDBACK_MAX_CHARS,
  feedbackResultMessage,
  getLastTurnTraceId,
  isFeedbackCapturePending,
  noteLastTurnTraceId,
  resetFeedbackStateForTests,
  takeFeedbackCapture,
} from "./feedback.js";

afterEach(() => {
  resetFeedbackStateForTests();
});

const noopFetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

function captureSpy(): {
  telemetry: Telemetry;
  events: Array<{ event: string; properties: Record<string, unknown> }>;
} {
  const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
  // Ambient off, intentional on — the critical /feedback contract.
  const telemetry = createTelemetry({
    settings: {
      providers: {},
      telemetry: { enabled: false, installationId: "install-test-1" },
    },
    // Pin env so a developer's DO_NOT_TRACK / CORBITS_TELEMETRY never bleeds in.
    env: {},
    apiKey: "phc_test",
    batch: { size: 100, intervalMs: 60_000, queueLimit: 100 },
    fetchFn: noopFetch,
  });
  const original = telemetry.captureIntentional.bind(telemetry);
  telemetry.captureIntentional = (event, properties) => {
    const ok = original(event, properties);
    if (ok) events.push({ event, properties: properties ?? {} });
    return ok;
  };
  return { telemetry, events };
}

describe("capFeedbackMessage", () => {
  test("leaves short messages alone", () => {
    expect(capFeedbackMessage("hello")).toBe("hello");
  });

  test("truncates at the free-text cap", () => {
    const long = "x".repeat(FEEDBACK_MAX_CHARS + 50);
    expect(capFeedbackMessage(long).length).toBe(FEEDBACK_MAX_CHARS);
  });
});

describe("buildSurveyProperties", () => {
  test("shapes PostHog custom survey properties", () => {
    const props = buildSurveyProperties("ship it", {
      turnTraceId: "trace-1",
      env: {
        CORBITS_FEEDBACK_SURVEY_ID: "survey-abc",
        CORBITS_FEEDBACK_QUESTION_ID: "q-1",
      },
    });
    expect(props.$survey_id).toBe("survey-abc");
    expect(props.$survey_response).toBe("ship it");
    expect(props.turn_trace_id).toBe("trace-1");
    expect(props.$survey_questions).toEqual([
      {
        id: "q-1",
        question: "What feedback do you have for Corbits Code?",
        response: "ship it",
      },
    ]);
  });
});

describe("captureFeedback", () => {
  test("sends survey sent when ambient telemetry is off", () => {
    const { telemetry, events } = captureSpy();
    expect(telemetry.enabled).toBe(false);
    const status = captureFeedback(telemetry, "great product", {
      env: {
        CORBITS_FEEDBACK_SURVEY_ID: "s1",
        CORBITS_FEEDBACK_QUESTION_ID: "q1",
      },
    });
    expect(status).toBe("sent");
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("survey sent");
    expect(events[0]?.properties.$survey_response).toBe("great product");
  });

  test("rejects empty text", () => {
    const { telemetry, events } = captureSpy();
    expect(captureFeedback(telemetry, "   ")).toBe("empty");
    expect(events).toHaveLength(0);
  });

  test("blocks when install identity is missing", () => {
    const telemetry = createTelemetry({
      settings: { providers: {}, telemetry: { enabled: false } },
      env: {},
      apiKey: "phc_test",
      batch: { size: 100, intervalMs: 60_000, queueLimit: 100 },
      fetchFn: noopFetch,
    });
    expect(
      captureFeedback(telemetry, "hi", {
        env: {
          CORBITS_FEEDBACK_SURVEY_ID: "s1",
          CORBITS_FEEDBACK_QUESTION_ID: "q1",
        },
      }),
    ).toBe("blocked");
  });

  test("blocks under env kill switch even with identity", () => {
    const telemetry = createTelemetry({
      settings: {
        providers: {},
        telemetry: { enabled: true, installationId: "install-1" },
      },
      env: { CORBITS_TELEMETRY: "0" },
      apiKey: "phc_test",
      batch: { size: 100, intervalMs: 60_000, queueLimit: 100 },
      fetchFn: noopFetch,
    });
    expect(
      captureFeedback(telemetry, "hi", {
        env: {
          CORBITS_TELEMETRY: "0",
          CORBITS_FEEDBACK_SURVEY_ID: "s1",
          CORBITS_FEEDBACK_QUESTION_ID: "q1",
        },
      }),
    ).toBe("blocked");
  });

  test("fails closed when survey ids are missing", () => {
    const { telemetry, events } = captureSpy();
    expect(captureFeedback(telemetry, "hi", { env: {} })).toBe("unconfigured");
    expect(events).toHaveLength(0);
  });

  test("rejects non-survey events on the intentional door", () => {
    const { telemetry, events } = captureSpy();
    expect(telemetry.captureIntentional("cli_start")).toBe(false);
    expect(events).toHaveLength(0);
  });
});

describe("feedbackResultMessage", () => {
  test("maps statuses to operator-facing lines", () => {
    expect(feedbackResultMessage("sent")).toContain("Thanks");
    expect(feedbackResultMessage("blocked")).toContain("could not be sent");
    expect(feedbackResultMessage("unconfigured")).toContain("not configured");
    expect(feedbackResultMessage("empty")).toContain("No feedback");
  });
});

describe("pending multi-turn capture", () => {
  test("arm → take consumes once", () => {
    expect(isFeedbackCapturePending()).toBe(false);
    armFeedbackCapture();
    expect(isFeedbackCapturePending()).toBe(true);
    expect(takeFeedbackCapture()).toBe(true);
    expect(isFeedbackCapturePending()).toBe(false);
    expect(takeFeedbackCapture()).toBe(false);
  });

  test("cancel clears pending", () => {
    armFeedbackCapture();
    cancelFeedbackCapture();
    expect(isFeedbackCapturePending()).toBe(false);
  });

  test("remembers last turn trace id", () => {
    noteLastTurnTraceId("sess:3");
    expect(getLastTurnTraceId()).toBe("sess:3");
  });
});
