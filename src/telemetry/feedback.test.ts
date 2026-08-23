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
  events: { event: string; properties: Record<string, unknown> }[];
} {
  const events: { event: string; properties: Record<string, unknown> }[] = [];
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
    });
    expect(props.$survey_id).toBe("019fe7ff-d12a-0000-7a63-303f3a874b90");
    expect(props.$survey_response).toBe("ship it");
    expect(props.turn_trace_id).toBe("trace-1");
    expect(props.$survey_questions).toEqual([
      {
        id: "913862f4-82aa-4814-8f68-146c05c38a74",
        question: "What feedback do you have about Corbits Code?",
        response: "ship it",
      },
    ]);
  });

  test("env override can blank the survey ids", () => {
    const props = buildSurveyProperties("x", {
      env: {
        CORBITS_FEEDBACK_SURVEY_ID: "",
        CORBITS_FEEDBACK_QUESTION_ID: "",
      },
    });
    expect(props.$survey_id).toBe("");
  });
});

describe("captureFeedback", () => {
  test("sends survey sent when ambient telemetry is off", () => {
    const { telemetry, events } = captureSpy();
    expect(telemetry.enabled).toBe(false);
    const status = captureFeedback(telemetry, "great product");
    expect(status).toBe("sent");
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("survey sent");
    expect(events[0]?.properties.$survey_response).toBe("great product");
    expect(events[0]?.properties.$survey_id).toBe("019fe7ff-d12a-0000-7a63-303f3a874b90");
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
    expect(captureFeedback(telemetry, "hi")).toBe("blocked");
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
        env: { CORBITS_TELEMETRY: "0" },
      }),
    ).toBe("blocked");
  });

  test("fails closed when survey ids are blanked via env", () => {
    const { telemetry, events } = captureSpy();
    expect(
      captureFeedback(telemetry, "hi", {
        env: {
          CORBITS_FEEDBACK_SURVEY_ID: "",
          CORBITS_FEEDBACK_QUESTION_ID: "",
        },
      }),
    ).toBe("unconfigured");
    expect(events).toHaveLength(0);
  });

  test("reports truncation when free text exceeds the cap", () => {
    const { telemetry, events } = captureSpy();
    const long = "x".repeat(FEEDBACK_MAX_CHARS + 50);
    const status = captureFeedback(telemetry, long);
    expect(status).toBe("sent_truncated");
    expect(events).toHaveLength(1);
    expect(String(events[0]?.properties.$survey_response).length).toBe(FEEDBACK_MAX_CHARS);
  });

  test("rejects non-survey events on the intentional door", () => {
    const { telemetry, events } = captureSpy();
    expect(telemetry.captureIntentional("cli_start")).toBe(false);
    expect(events).toHaveLength(0);
  });
});

describe("feedbackResultMessage", () => {
  test("maps statuses to operator-facing lines", () => {
    expect(feedbackResultMessage("sent")).toBe("Thanks — feedback sent.");
    expect(feedbackResultMessage("sent_truncated")).toContain("truncated");
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
