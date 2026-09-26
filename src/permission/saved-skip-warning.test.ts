import { describe, expect, test } from "bun:test";
import { mkdtemp, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SETTINGS_DIR_NAME } from "../branding.js";
import { savedSkipPermissionsWarning } from "./saved-skip-warning.js";

describe("savedSkipPermissionsWarning", () => {
  test("default machine-wide source appends the /yolo off hint", () => {
    const source = join(homedir(), SETTINGS_DIR_NAME, "settings.json");

    const warning = savedSkipPermissionsWarning(source);

    expect(warning).toContain(source);
    expect(warning).toContain("edit that file to re-enable");
    expect(warning).toContain("/yolo off");
  });

  test("symlinked-home alias of the default source still appends the hint", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "corbits-skip-warning-"));
    const homeLink = join(sandbox, "home");
    await symlink(homedir(), homeLink);
    const aliased = join(homeLink, SETTINGS_DIR_NAME, "settings.json");

    const warning = savedSkipPermissionsWarning(aliased);

    expect(warning).toContain(aliased);
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
