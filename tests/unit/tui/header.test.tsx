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
      width={props.width ?? 160}
    />,
  );
}

test("Header renders product name", () => {
  const { lastFrame } = renderHeader();
  expect(lastFrame()).toContain("Intercode");
});

test("Header renders running status label", () => {
  const { lastFrame } = renderHeader();
  expect(lastFrame()).toContain("Running");
});

test("Header renders done status label", () => {
  const { lastFrame } = renderHeader({ turnsUsed: 5, status: "done", totalCost: "$0.0123" });
  expect(lastFrame()).toContain("Done");
});

test("Header renders failed status label", () => {
  const { lastFrame } = renderHeader({ turnsUsed: 3, status: "failed" });
  expect(lastFrame()).toContain("Failed");
});

test("Header renders blocked status label", () => {
  const { lastFrame } = renderHeader({ status: "blocked" });
  expect(lastFrame()).toContain("Blocked");
});

test("Header renders turn count at wide widths", () => {
  const { lastFrame } = renderHeader({ turnsUsed: 7, width: 160 });
  expect(lastFrame()).toContain("7 turns");
});

test("Header drops turn label below 120 columns", () => {
  const { lastFrame } = renderHeader({ turnsUsed: 7, width: 100 });
  expect(lastFrame()).not.toContain("7 turns");
});

test("Header renders cost", () => {
  const { lastFrame } = renderHeader({ totalCost: "$0.0456" });
  expect(lastFrame()).toContain("$0.0456");
});
