import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { StatusBar } from "../../../src/tui/components/status-bar.js";

test("StatusBar renders keyboard hints", () => {
  const { lastFrame } = render(<StatusBar />);
  expect(lastFrame()).toContain("Ctrl+C");
  expect(lastFrame()).toContain("exit");
});

test("StatusBar renders hook panel hint", () => {
  const { lastFrame } = render(<StatusBar />);
  expect(lastFrame()).toContain("Ctrl+H hooks");
});
