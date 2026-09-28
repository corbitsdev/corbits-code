import { describe, expect, test } from "bun:test";
import { mkdtemp, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SETTINGS_DIR_NAME } from "../branding.js";
import { savedSkipPermissionsWarning } from "./saved-skip-warning.js";

const defaultSource = join(homedir(), SETTINGS_DIR_NAME, "settings.json");

const symlinkAlias = async (): Promise<string> => {
  const sandbox = await mkdtemp(join(tmpdir(), "corbits-skip-warning-"));
  const link = join(sandbox, "home");
  await symlink(homedir(), link);
  return join(link, SETTINGS_DIR_NAME, "settings.json");
};

describe("savedSkipPermissionsWarning", () => {
  test("TUI appends the /yolo off hint only for the machine-wide source, including symlinked aliases", async () => {
    const warning = savedSkipPermissionsWarning(defaultSource, "tui");
    expect(warning).toContain(defaultSource);
    expect(warning).toContain("/yolo off");

    const aliased = await symlinkAlias();
    const aliasWarning = savedSkipPermissionsWarning(aliased, "tui");
    expect(aliasWarning).toContain(aliased);
    expect(aliasWarning).toContain("/yolo off");
  });

  test("exec and custom sources name the file but never print the /yolo hint", async () => {
    const aliased = await symlinkAlias();
    for (const [source, surface] of [
      [defaultSource, "exec"],
      [aliased, "exec"],
      ["/tmp/custom-corbits-settings.json", "tui"],
      ["/tmp/custom-corbits-settings.json", "exec"],
    ] as const) {
      const warning = savedSkipPermissionsWarning(source, surface);
      expect(warning).toContain(source);
      expect(warning).not.toContain("/yolo");
    }
  });
});
