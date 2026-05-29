import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Header } from "../../../src/tui/components/header.js";

test("Header renders project name", () => {
  const { lastFrame } = render(<Header turnsUsed={0} status="running" totalCost="$0.0000" maxTurns={30} />);
  expect(lastFrame()).toContain("interchange-code");
});

test("Header renders running status", () => {
  const { lastFrame } = render(<Header turnsUsed={0} status="running" totalCost="$0.0000" maxTurns={30} />);
  expect(lastFrame()).toContain("running");
});

test("Header renders done status", () => {
  const { lastFrame } = render(<Header turnsUsed={5} status="done" totalCost="$0.0123" maxTurns={30} />);
  expect(lastFrame()).toContain("done");
});

test("Header renders failed status", () => {
  const { lastFrame } = render(<Header turnsUsed={3} status="failed" totalCost="$0.0000" maxTurns={30} />);
  expect(lastFrame()).toContain("failed");
});

test("Header renders turn count and max turns", () => {
  const { lastFrame } = render(<Header turnsUsed={7} status="running" totalCost="$0.0000" maxTurns={30} />);
  expect(lastFrame()).toContain("7/30");
});

test("Header renders cost", () => {
  const { lastFrame } = render(<Header turnsUsed={0} status="running" totalCost="$0.0456" maxTurns={30} />);
  expect(lastFrame()).toContain("$0.0456");
});
