import { describe, test, expect } from "bun:test";
import { createSubmitHandler, routeSubmission, telemetryStartupNotice } from "./runner.js";
import { TELEMETRY_NOTICE } from "../telemetry/index.js";

type Dispatched = { name: string; args: string };

function harness() {
  const dispatched: Dispatched[] = [];
  const prompts: string[] = [];
  let promptSubmissions = 0;
  const submit = createSubmitHandler({
    dispatchCommand: (name, args) => dispatched.push({ name, args }),
    sendPrompt: (text) => prompts.push(text),
    onPromptSubmitted: () => {
      promptSubmissions += 1;
    },
  });
  return { submit, dispatched, prompts, telemetry: () => promptSubmissions };
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
    h.submit("/goal 12 ship the feature");
    expect(h.dispatched).toEqual([{ name: "goal", args: "12 ship the feature" }]);
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
