import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { render } from "ink-testing-library";
import type { PermissionRequest } from "../../permission/types.js";
import { PermissionModal } from "./permission-modal.js";

function longChainRequest(segmentCount: number): PermissionRequest {
  const subject = Array.from({ length: segmentCount }, (_, i) => `echo line-${i}`).join(" && ");
  return { tool: "run_shell", action: "Run", subject, scopes: [] };
}

describe("PermissionModal scroll indicator", () => {
  test("shows a 'more below' indicator when the body overflows and is scrolled to the top", () => {
    const { lastFrame, unmount } = render(
      createElement(PermissionModal, {
        request: longChainRequest(30),
        onResolve: () => {},
        terminalRows: 15,
      }),
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("more below");
    expect(frame).not.toContain("more above");

    unmount();
  });

  test("swaps to a 'more above' indicator, with no 'more below', once scrolled to the end", async () => {
    const { lastFrame, stdin, unmount } = render(
      createElement(PermissionModal, {
        request: longChainRequest(30),
        onResolve: () => {},
        terminalRows: 15,
      }),
    );

    // Page down repeatedly past the end of the body; offset clamps at max.
    for (let i = 0; i < 10; i++) {
      stdin.write("\x1b[6~");
      await new Promise((r) => setTimeout(r, 0));
    }

    const frame = lastFrame() ?? "";
    expect(frame).toContain("more above");
    expect(frame).not.toContain("more below");

    unmount();
  });

  test("shows no scroll indicator when the body fits without overflow", () => {
    const { lastFrame, unmount } = render(
      createElement(PermissionModal, {
        request: longChainRequest(2),
        onResolve: () => {},
        terminalRows: 40,
      }),
    );

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("more below");
    expect(frame).not.toContain("more above");

    unmount();
  });
});
