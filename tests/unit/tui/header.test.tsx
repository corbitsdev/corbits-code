import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Header } from "../../../src/tui/components/header.js";
import type { HeaderProps } from "../../../src/tui/components/header.js";

function renderHeader(props: Partial<HeaderProps> = {}) {
  return render(
    <Header
      turnsUsed={props.turnsUsed ?? 0}
      status={props.status ?? "running"}
      totalCost={props.totalCost ?? "$0.0000"}
      sessionTitle={props.sessionTitle ?? ""}
      latestUserMessage={props.latestUserMessage ?? ""}
      mode={props.mode ?? "teammate"}
    />,
  );
}

test("Header renders project name", () => {
  const { lastFrame } = renderHeader();
  expect(lastFrame()).toContain("interchange-code");
});

test("Header renders running status", () => {
  const { lastFrame } = renderHeader();
  expect(lastFrame()).toContain("running");
});

test("Header renders done status", () => {
  const { lastFrame } = renderHeader({ turnsUsed: 5, status: "done", totalCost: "$0.0123" });
  expect(lastFrame()).toContain("done");
});

test("Header renders failed status", () => {
  const { lastFrame } = renderHeader({ turnsUsed: 3, status: "failed" });
  expect(lastFrame()).toContain("failed");
});

test("Header renders turn count", () => {
  const { lastFrame } = renderHeader({ turnsUsed: 7 });
  expect(lastFrame()).toContain("7 turns");
});

test("Header renders cost", () => {
  const { lastFrame } = renderHeader({ totalCost: "$0.0456" });
  expect(lastFrame()).toContain("$0.0456");
});
