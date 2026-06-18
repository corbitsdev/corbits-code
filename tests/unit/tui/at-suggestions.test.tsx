import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { AtSuggestions } from "../../../src/tui/components/at-mention/AtSuggestions.js";

test("AtSuggestions renders clean path labels without duplicating the typed @", () => {
  const { lastFrame } = render(<AtSuggestions suggestions={["src/", "../agents/"]} selectedIdx={0} />);
  const frame = lastFrame() ?? "";

  expect(frame).toContain("src/");
  expect(frame).toContain("../agents/");
  expect(frame).not.toContain("@src/");
  expect(frame).not.toContain("@../agents/");
});
