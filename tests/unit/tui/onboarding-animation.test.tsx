import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { OnboardingAnimation } from "../../../src/tui/components/onboarding-animation.js";

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("first run shows the 'Welcome to' greeting", async () => {
  const { lastFrame } = render(
    <OnboardingAnimation onComplete={() => {}} rows={20} columns={80} isFirstTime={true} />,
  );
  await tick(1000);
  expect(lastFrame()).toContain("Welcome to");
}, 6000);

test("returning user shows the 'Welcome back' greeting", async () => {
  const { lastFrame } = render(
    <OnboardingAnimation onComplete={() => {}} rows={20} columns={80} isFirstTime={false} />,
  );
  await tick(1000);
  expect(lastFrame()).toContain("Welcome back");
}, 6000);

test("any keypress dismisses the animation immediately", async () => {
  let completed = 0;
  const { stdin } = render(
    <OnboardingAnimation onComplete={() => { completed++; }} rows={20} columns={80} isFirstTime={true} />,
  );
  stdin.write(" ");
  await tick();
  expect(completed).toBe(1);
});

test("the animation completes on its own after playing through", async () => {
  let completed = 0;
  render(
    <OnboardingAnimation onComplete={() => { completed++; }} rows={20} columns={80} isFirstTime={true} />,
  );
  await tick(5000);
  expect(completed).toBe(1);
}, 8000);
