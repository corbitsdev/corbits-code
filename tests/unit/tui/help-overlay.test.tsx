import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { HelpOverlay } from "../../../src/tui/components/help-overlay.js";
import { SHORTCUTS, SLASH_COMMANDS } from "../../../src/tui/keymap-table.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test("HelpOverlay lists every shortcut and slash command from the table", () => {
  const { lastFrame } = render(<HelpOverlay onClose={() => {}} />);
  const frame = lastFrame() ?? "";
  for (const entry of SHORTCUTS) {
    expect(frame).toContain(entry.keys);
  }
  for (const entry of SLASH_COMMANDS) {
    expect(frame).toContain(entry.keys);
  }
});

test("HelpOverlay closes on escape", async () => {
  let closed = false;
  const { stdin } = render(<HelpOverlay onClose={() => { closed = true; }} />);
  stdin.write("\x1B");
  await tick();
  expect(closed).toBe(true);
});
