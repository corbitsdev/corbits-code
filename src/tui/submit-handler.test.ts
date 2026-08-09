import { afterEach, describe, test, expect } from "bun:test";
import {
  createSubmitHandler,
  IMAGE_ONLY_PROMPT,
  routeSubmission,
  telemetryStartupNotice,
  userInboundMessage,
} from "./runner.js";
import type { PendingImageAttachment } from "./image-attachments.js";
import { TELEMETRY_NOTICE } from "../telemetry/index.js";
import {
  armFeedbackCapture,
  cancelFeedbackCapture,
  isFeedbackCapturePending,
  resetFeedbackStateForTests,
} from "../telemetry/feedback.js";

afterEach(() => {
  resetFeedbackStateForTests();
});

type Dispatched = { name: string; args: string };

function harness(options?: {
  isFeedbackCapturePending?: () => boolean;
  onFeedbackText?: (text: string) => string;
  cancelFeedbackCapture?: () => void;
  onSystemNotice?: (text: string) => void;
}) {
  const dispatched: Dispatched[] = [];
  const prompts: string[] = [];
  const notices: string[] = [];
  let promptSubmissions = 0;
  const submit = createSubmitHandler({
    dispatchCommand: (name, args) => dispatched.push({ name, args }),
    sendPrompt: (text) => prompts.push(text),
    onPromptSubmitted: () => {
      promptSubmissions += 1;
    },
    ...(options?.isFeedbackCapturePending !== undefined
      ? { isFeedbackCapturePending: options.isFeedbackCapturePending }
      : {}),
    ...(options?.onFeedbackText !== undefined ? { onFeedbackText: options.onFeedbackText } : {}),
    ...(options?.cancelFeedbackCapture !== undefined
      ? { cancelFeedbackCapture: options.cancelFeedbackCapture }
      : {}),
    onSystemNotice: (text) => {
      notices.push(text);
      options?.onSystemNotice?.(text);
    },
  });
  return { submit, dispatched, prompts, notices, telemetry: () => promptSubmissions };
}

describe("composer submit handler", () => {
  test("dispatches a typed slash command instead of sending it to the model", () => {
    const h = harness();
    h.submit("/clear");
    expect(h.dispatched).toEqual([{ name: "clear", args: "" }]);
    expect(h.prompts).toEqual([]);
  });

  test("passes slash command arguments through", () => {
    const h = harness();
    h.submit("/rename ship the feature");
    expect(h.dispatched).toEqual([{ name: "rename", args: "ship the feature" }]);
    expect(h.prompts).toEqual([]);
  });

  test("dispatches unknown slash names so the registry can report them", () => {
    const h = harness();
    h.submit("/not-a-command");
    expect(h.dispatched).toEqual([{ name: "not-a-command", args: "" }]);
    expect(h.prompts).toEqual([]);
  });

  test("sends ordinary prompts to the agent", () => {
    const h = harness();
    h.submit("  refactor the parser  ");
    expect(h.prompts).toEqual(["refactor the parser"]);
    expect(h.dispatched).toEqual([]);
  });

  test("ignores blank and bare-slash submissions", () => {
    const h = harness();
    h.submit("   ");
    h.submit("/");
    expect(h.prompts).toEqual([]);
    expect(h.dispatched).toEqual([]);
  });

  test("consent-by-proceeding fires on prompts only, never on commands", () => {
    const h = harness();
    h.submit("/help");
    expect(h.telemetry()).toBe(0);
    h.submit("hello");
    expect(h.telemetry()).toBe(1);
  });

  test("pending feedback capture routes the next prompt as feedback, not a model send", () => {
    const feedbackTexts: string[] = [];
    const h = harness({
      isFeedbackCapturePending: () => isFeedbackCapturePending(),
      onFeedbackText: (text) => {
        feedbackTexts.push(text);
        return "Thanks — feedback sent.";
      },
    });
    armFeedbackCapture();
    h.submit("the UI is snappy");
    expect(feedbackTexts).toEqual(["the UI is snappy"]);
    expect(h.prompts).toEqual([]);
    expect(h.notices).toEqual(["Thanks — feedback sent."]);
    expect(h.telemetry()).toBe(0);
  });

  test("slash commands still dispatch while feedback capture is pending", () => {
    const h = harness({
      isFeedbackCapturePending: () => isFeedbackCapturePending(),
      onFeedbackText: () => "should not run",
    });
    armFeedbackCapture();
    h.submit("/help");
    expect(h.dispatched).toEqual([{ name: "help", args: "" }]);
    expect(h.prompts).toEqual([]);
    expect(h.notices).toEqual([]);
    // Still pending — only a non-command line consumes it.
    expect(isFeedbackCapturePending()).toBe(true);
  });

  test("empty Enter while armed cancels instead of trapping the operator", () => {
    let cancelled = false;
    const h = harness({
      isFeedbackCapturePending: () => isFeedbackCapturePending(),
      cancelFeedbackCapture: () => {
        cancelled = true;
        cancelFeedbackCapture();
      },
      onFeedbackText: () => "should not run",
    });
    armFeedbackCapture();
    h.submit("   ");
    expect(cancelled).toBe(true);
    expect(isFeedbackCapturePending()).toBe(false);
    expect(h.prompts).toEqual([]);
    expect(h.notices).toEqual(["Feedback cancelled."]);
  });
});

describe("routeSubmission", () => {
  test("classifies leading slash as a command", () => {
    expect(routeSubmission("/model gpt")).toEqual({ kind: "command", name: "model", args: "gpt" });
  });

  test("classifies plain text as a prompt", () => {
    expect(routeSubmission("do the thing")).toEqual({ kind: "prompt", text: "do the thing" });
  });
});

describe("telemetryStartupNotice", () => {
  const firstRun = { providers: {}, telemetry: { installationId: "install-1" } };

  test("returns the disclosure on a first run", () => {
    expect(telemetryStartupNotice(firstRun, {})).toBe(TELEMETRY_NOTICE);
  });

  test("stays silent once the notice has been shown", () => {
    expect(
      telemetryStartupNotice({ ...firstRun, telemetry: { ...firstRun.telemetry, noticeShown: true } }, {}),
    ).toBeUndefined();
  });
});

describe("image attachment submits", () => {
  const image: PendingImageAttachment = {
    id: "img-1",
    name: "clipboard.png",
    contentType: "image/png",
    data: new Uint8Array([1, 2, 3]),
    contentHash: "hash-1",
  };

  function attachmentHarness() {
    const sends: Array<{ text: string; attachments?: readonly PendingImageAttachment[] }> = [];
    const submit = createSubmitHandler({
      dispatchCommand: () => {},
      sendPrompt: (text, attachments) => sends.push({ text, ...(attachments ? { attachments } : {}) }),
    });
    return { submit, sends };
  }

  test("sends an attachment-only submit that would otherwise be empty", () => {
    const h = attachmentHarness();
    h.submit("   ", [image]);
    expect(h.sends).toEqual([{ text: "", attachments: [image] }]);
  });

  test("carries attachments alongside prompt text", () => {
    const h = attachmentHarness();
    h.submit("what is this", [image]);
    expect(h.sends[0]?.text).toBe("what is this");
    expect(h.sends[0]?.attachments).toEqual([image]);
  });

  test("still drops a truly empty submit", () => {
    const h = attachmentHarness();
    h.submit("", []);
    expect(h.sends).toEqual([]);
  });

  test("builds an inbound message carrying the image bytes", () => {
    const message = userInboundMessage("look", [image]);
    expect(message.content).toBe("look");
    expect(message.attachments).toEqual([
      { name: "clipboard.png", contentType: "image/png", data: image.data },
    ]);
  });

  test("substitutes a prompt when only an image was submitted", () => {
    expect(userInboundMessage("", [image]).content).toBe(IMAGE_ONLY_PROMPT);
  });
});
