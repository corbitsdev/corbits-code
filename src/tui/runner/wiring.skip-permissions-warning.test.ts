import { describe, expect, test } from "bun:test";
import { globalSettingsPath } from "../../config/settings.js";
import { createAppShell } from "../shell/index.js";
import { shellInternals } from "../shell/internals.js";
import { withTestRenderer } from "../harness.js";
import { surfaceSavedSkipPermissionsWarning } from "./wiring.js";

const OPTIONS = {
  terminal: { columns: 80, rows: 24 },
  wireKeys: false,
  run: "idle" as const,
};

async function surfacedWarning(globalSettingsPath: string): Promise<string> {
  return withTestRenderer(async (h) => {
    const shell = createAppShell(h.renderer, OPTIONS);
    try {
      surfaceSavedSkipPermissionsWarning(shell, {
        globalSettingsPath,
        skipPermissionsFromSettings: true,
      });
      return shellInternals(shell)?.landingDeferredRows.at(-1)?.text ?? "";
    } finally {
      shell.dispose();
    }
  });
}

describe("saved skip-permissions startup warning", () => {
  test("identifies a custom config path without false default provenance", async () => {
    const warning = await surfacedWarning("/tmp/custom-corbits-settings.json");

    expect(warning).toContain("/tmp/custom-corbits-settings.json");
    expect(warning).toContain("edit that file to re-enable");
    expect(warning).not.toMatch(/machine-wide|saved default|\/yolo off/i);
  });

  test("appends the /yolo off hint for the default settings path", async () => {
    const source = globalSettingsPath();
    const warning = await surfacedWarning(source);

    expect(warning).toContain(source);
    expect(warning).toContain("edit that file to re-enable");
    expect(warning).toContain("/yolo off");
  });
});
