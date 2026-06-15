import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Header } from "../../../src/tui/components/header.js";
import type { HeaderProps } from "../../../src/tui/components/header.js";

function renderHeader(props: Partial<HeaderProps> = {}) {
  return render(
    <Header
      sessionTitle={props.sessionTitle ?? ""}
      latestUserMessage={props.latestUserMessage ?? ""}
      width={props.width ?? 160}
      elapsedMs={props.elapsedMs ?? 0}
      usage={props.usage}
    />,
  );
}

test("Header renders product name", () => {
  const { lastFrame } = renderHeader();
  expect(lastFrame()).toContain("Intercode");
});

test("Header renders the session title", () => {
  const { lastFrame } = renderHeader({ sessionTitle: "build a plan" });
  expect(lastFrame()).toContain("build a plan");
});

test("Header renders the latest user message", () => {
  const { lastFrame } = renderHeader({ latestUserMessage: "do the thing" });
  expect(lastFrame()).toContain("do the thing");
});

test("Header shows the working directory at wide widths", () => {
  const { lastFrame } = renderHeader({ width: 160 });
  expect(lastFrame()).toContain("/");
});

test("Header renders the session clock", () => {
  const { lastFrame } = renderHeader({ elapsedMs: 65000 });
  expect(lastFrame()).toContain("1:05");
});

test("Header renders live usage when provided", () => {
  const { lastFrame } = renderHeader({ usage: "Codex 5h 12%" });
  expect(lastFrame()).toContain("Codex 5h 12%");
});

test("Header does not render the dollar cost", () => {
  const { lastFrame } = renderHeader({ sessionTitle: "x" });
  expect(lastFrame() ?? "").not.toContain("$");
});
