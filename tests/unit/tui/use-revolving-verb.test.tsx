import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useRevolvingVerb } from "../../../src/tui/hooks/use-revolving-verb.js";

const KNOWN = ["thinking", "streaming", "running", "reasoning", "composing", "working"];

function Verb({ active }: { active: boolean }) {
  const verb = useRevolvingVerb(active);
  return <Text>{verb ?? "idle"}</Text>;
}

test("useRevolvingVerb returns undefined while inactive", () => {
  const { lastFrame } = render(<Verb active={false} />);
  expect(lastFrame()).toBe("idle");
});

test("useRevolvingVerb returns a known verb while active", () => {
  const { lastFrame } = render(<Verb active={true} />);
  expect(KNOWN).toContain(lastFrame() ?? "");
});
