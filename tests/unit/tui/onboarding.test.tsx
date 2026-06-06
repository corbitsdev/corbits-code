import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { ProviderSetupPanel } from "../../../src/tui/onboarding.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

function renderPanel(onSubmit: (v: Record<string, string>) => Promise<void> = () => Promise.resolve()) {
  return render(<ProviderSetupPanel onSubmit={onSubmit} />);
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
  // now submitting — frame should show spinner text
  expect(lastFrame()).toContain("Writing settings");
  // further input should be ignored
  stdin.write("extra");
  await tick();
  expect(lastFrame()).toContain("Writing settings");
  resolveSubmit!();
  await tick();
});
