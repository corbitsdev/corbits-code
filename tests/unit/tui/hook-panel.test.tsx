import { expect, test } from "bun:test";
import { render } from "ink-testing-library";

import { HookPanel } from "../../../src/tui/components/hook-panel.js";

test("HookPanel renders empty state", () => {
  const { lastFrame } = render(<HookPanel hooks={[]} />);
  expect(lastFrame()).toContain("none registered");
  expect(lastFrame()).toContain(".interchange/hooks, ~/.interchange/hooks");
});

test("HookPanel renders hook status details", () => {
  const { lastFrame } = render(
    <HookPanel
      hooks={[
        {
          id: "/tmp/hook.ts",
          name: "hook.ts",
          type: "typescript",
          path: "/tmp/hook.ts",
          enabled: true,
          lastFiredAt: 100,
          lastKind: "postTurn",
          lastExitStatus: { code: 1, signal: null, stderr: "bad" },
        },
      ]}
    />,
  );

  const frame = lastFrame() ?? "";
  expect(frame).toContain("hook.ts");
  expect(frame).toContain("typescript");
  expect(frame).toContain("exit 1");
  expect(frame).toContain("/tmp/hook.ts");
});
