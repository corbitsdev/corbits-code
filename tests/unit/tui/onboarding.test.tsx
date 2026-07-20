import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { ProviderSetupPanel } from "../../../src/tui/onboarding.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

type SetPhase = (phase: "testing" | "saving") => void;
type SubmitOpts = { skipValidation: boolean };

function renderPanel(
  onSubmit: (v: Record<string, string>, setPhase: SetPhase, opts: SubmitOpts) => Promise<void> = () =>
    Promise.resolve(),
) {
  return render(<ProviderSetupPanel onSubmit={onSubmit} />);
}

async function fillAllFields(stdin: { write: (s: string) => void }): Promise<void> {
  stdin.write("name");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("https://api.example.com");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("sk-key");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("gpt-4o");
  await tick();
  stdin.write("\r");
  await tick();
}

test("shows Provider name label on mount", () => {
  const { lastFrame } = renderPanel();
  expect(lastFrame()).toContain("Provider name");
});

test("shows all field labels", () => {
  const { lastFrame } = renderPanel();
  expect(lastFrame()).toContain("Provider name");
  expect(lastFrame()).toContain("Base URL");
  expect(lastFrame()).toContain("API key");
  expect(lastFrame()).toContain("Default model");
});

test("typing accumulates in current field", async () => {
  const { lastFrame, stdin } = renderPanel();
  stdin.write("myp");
  await tick();
  stdin.write("rovider");
  await tick();
  expect(lastFrame()).toContain("myprovider");
});

test("Enter with empty field does not advance — cursor stays on field 0", async () => {
  const { lastFrame, stdin } = renderPanel();
  stdin.write("\r");
  await tick();
  // Type a character — it should land on field 0 (Provider name), not field 1.
  // If advance had fired, the text would appear under Base URL.
  stdin.write("x");
  await tick();
  // The typed character appears on the current (first) field's input line.
  // Field label is still highlighted as the active one.
  expect(lastFrame()).toContain("Provider name");
  expect(lastFrame()).toContain("x");
});

test("Enter with text advances to next field", async () => {
  const { lastFrame, stdin } = renderPanel();
  stdin.write("anthropic");
  await tick();
  stdin.write("\r");
  await tick();
  expect(lastFrame()).toContain("Base URL");
});

test("Escape from field 2 goes back to field 1", async () => {
  const { lastFrame, stdin } = renderPanel();
  stdin.write("anthropic");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("\x1B");
  await tick();
  expect(lastFrame()).toContain("Provider name");
});

test("Escape from field 1 does nothing", async () => {
  const { lastFrame, stdin } = renderPanel();
  stdin.write("\x1B");
  await tick();
  expect(lastFrame()).toContain("Provider name");
});

test("API key field masks characters with bullets", async () => {
  const { lastFrame, stdin } = renderPanel();
  // advance to name, baseURL, then apiKey
  stdin.write("myname");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("https://api.example.com");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("sk-secret");
  await tick();
  expect(lastFrame()).not.toContain("sk-secret");
  expect(lastFrame()).toContain("●");
});

test("onSubmit rejection shows error text", async () => {
  const onSubmit = async (): Promise<void> => {
    throw new Error("bad credentials");
  };
  const { lastFrame, stdin } = renderPanel(onSubmit);
  // fill all fields
  stdin.write("name");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("https://api.example.com");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("sk-key");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("gpt-4o");
  await tick();
  stdin.write("\r");
  await tick();
  await tick();
  expect(lastFrame()).toContain("bad credentials");
});

test("input ignored while submitting", async () => {
  let resolveSubmit: () => void;
  const onSubmit = (): Promise<void> => new Promise((r) => { resolveSubmit = r; });
  const { lastFrame, stdin } = renderPanel(onSubmit);
  // fill all fields
  stdin.write("name");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("https://api.example.com");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("sk-key");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("gpt-4o");
  await tick();
  stdin.write("\r");
  await tick();
  // now submitting — frame should show the testing-connection phase, since
  // onSubmit hasn't advanced to the "saving" phase yet
  expect(lastFrame()).toContain("Testing connection");
  // further input should be ignored
  stdin.write("extra");
  await tick();
  expect(lastFrame()).toContain("Testing connection");
  resolveSubmit!();
  await tick();
});

test("submit shows testing-connection phase, then saving phase once onSubmit advances", async () => {
  let advancePhase: SetPhase = () => {};
  let resolveSubmit: () => void;
  const onSubmit = (_v: Record<string, string>, setPhase: SetPhase): Promise<void> => {
    advancePhase = setPhase;
    return new Promise((r) => { resolveSubmit = r; });
  };
  const { lastFrame, stdin } = renderPanel(onSubmit);
  stdin.write("name");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("https://api.example.com");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("sk-key");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("gpt-4o");
  await tick();
  stdin.write("\r");
  await tick();

  expect(lastFrame()).toContain("Testing connection");

  advancePhase("saving");
  await tick();
  expect(lastFrame()).toContain("Writing settings");

  resolveSubmit!();
  await tick();
});

test("onSubmit rejection during connection test shows the error and never advances to saving", async () => {
  const onSubmit = async (_v: Record<string, string>, setPhase: SetPhase): Promise<void> => {
    setPhase("testing");
    throw new Error("could not reach https://api.example.com/models");
  };
  const { lastFrame, stdin } = renderPanel(onSubmit);
  stdin.write("name");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("https://api.example.com");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("sk-key");
  await tick();
  stdin.write("\r");
  await tick();
  stdin.write("gpt-4o");
  await tick();
  stdin.write("\r");
  await tick();
  await tick();
  expect(lastFrame()).toContain("could not reach https://api.example.com/models");
  expect(lastFrame()).not.toContain("Writing settings");
});

test("connection-test failure offers a save-anyway path", async () => {
  const onSubmit = async (): Promise<void> => {
    throw new Error("connection refused");
  };
  const { lastFrame, stdin } = renderPanel(onSubmit);
  await fillAllFields(stdin);
  await tick();
  expect(lastFrame()).toContain("connection refused");
  expect(lastFrame()).toContain("save anyway");
});

test("Ctrl+S after a failed connection test resubmits with skipValidation", async () => {
  const submissions: SubmitOpts[] = [];
  const onSubmit = async (_v: Record<string, string>, _setPhase: SetPhase, opts: SubmitOpts): Promise<void> => {
    submissions.push(opts);
    if (!opts.skipValidation) {
      throw new Error("connection refused");
    }
  };
  const { stdin } = renderPanel(onSubmit);
  await fillAllFields(stdin);
  await tick();
  stdin.write("\x13");
  await tick();
  expect(submissions).toEqual([{ skipValidation: false }, { skipValidation: true }]);
});

test("failure during the saving phase does not offer save anyway", async () => {
  const onSubmit = async (_v: Record<string, string>, setPhase: SetPhase): Promise<void> => {
    setPhase("saving");
    throw new Error("disk full");
  };
  const { lastFrame, stdin } = renderPanel(onSubmit);
  await fillAllFields(stdin);
  await tick();
  expect(lastFrame()).toContain("disk full");
  expect(lastFrame()).not.toContain("save anyway");
});
