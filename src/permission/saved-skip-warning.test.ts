import { describe, expect, test } from "bun:test";
import { globalSettingsPath } from "../config/settings.js";
import { savedSkipPermissionsWarning } from "./saved-skip-warning.js";

describe("savedSkipPermissionsWarning", () => {
  test("default machine-wide source appends the /yolo off hint", () => {
    const source = globalSettingsPath();

    const warning = savedSkipPermissionsWarning(source);

    expect(warning).toContain(source);
    expect(warning).toContain("edit that file to re-enable");
    expect(warning).toContain("/yolo off");
  });

  test("custom source keeps file-path wording with no false provenance", () => {
    const warning = savedSkipPermissionsWarning(
      "/tmp/custom-corbits-settings.json",
    );

    expect(warning).toContain("/tmp/custom-corbits-settings.json");
    expect(warning).toContain("edit that file to re-enable");
    expect(warning).not.toMatch(/machine-wide|saved default|\/yolo off/i);
  });
});
