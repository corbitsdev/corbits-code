import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Header } from "../../../src/tui/components/header.js";
import type { HeaderProps } from "../../../src/tui/components/header.js";

function renderHeader(props: Partial<HeaderProps> = {}) {
  return render(
    <Header
      latestUserMessage={props.latestUserMessage ?? ""}
      width={props.width ?? 160}
      {...(props.profile !== undefined ? { profile: props.profile } : {})}
      {...(props.workflow !== undefined ? { workflow: props.workflow } : {})}
    />,
  );
}

test("Header no longer renders the product name — it lives in the status bar", () => {
  const { lastFrame } = renderHeader();
  expect(lastFrame() ?? "").not.toContain("Corbits Code");
});

test("Header renders the latest user message", () => {
  const { lastFrame } = renderHeader({ latestUserMessage: "do the thing" });
  expect(lastFrame()).toContain("do the thing");
});

test("Header renders the profile when provided", () => {
  const { lastFrame } = renderHeader({ profile: "architect" });
  expect(lastFrame()).toContain("architect");
});

test("Header does not render a profile bracket when none is provided", () => {
  const { lastFrame } = renderHeader();
  expect(lastFrame() ?? "").not.toContain("[");
});

test("Header no longer renders the working directory — it lives in the status bar", () => {
  const { lastFrame } = renderHeader({ width: 160, latestUserMessage: "do the thing" });
  expect(lastFrame()).toContain("do the thing");
});

test("Header does not render the session clock", () => {
  // Elapsed time was removed from the header — it lives in the in-flight indicator.
  const { lastFrame } = renderHeader();
  expect(lastFrame() ?? "").not.toContain("0:00");
});

test("Header renders the workflow stepper when provided", () => {
  const { lastFrame } = renderHeader({
    workflow: { name: "refactor", stepIndex: 1, total: 3, label: "editing" },
  });
  expect(lastFrame()).toContain("refactor");
  expect(lastFrame()).toContain("2/3");
});

test("Header does not render the dollar cost", () => {
  const { lastFrame } = renderHeader({ latestUserMessage: "x" });
  expect(lastFrame() ?? "").not.toContain("$");
});
