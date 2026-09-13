import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildCredentialPatterns } from "./credential-surface.js";

// CL-7929: the .lock/.tmp sidecar legs matched any directory, so a
// workspace settings file (e.g. .vscode/settings.json.lock) denied as a
// credential. They are scoped to the settings dir like the .bak legs.
describe("credential sidecar scoping (CL-7929)", () => {
  test("workspace-path decoys do not deny", () => {
    const patterns = buildCredentialPatterns();
    const decoys = [
      join("project", ".vscode", "settings.json.lock"),
      join("project", "settings.json.12345.tmp"),
      join("project", "settings.json.12345.1.tmp"),
      join("project", ".vscode", "permissions.json.lock"),
      join("project", "permissions.json.999.1.tmp"),
    ];
    for (const decoy of decoys) {
      expect(
        patterns.some((pattern) => pattern.test(decoy)),
        `${decoy} must not match the credential denylist`,
      ).toBe(false);
    }
  });

  test("settings-dir sidecars still deny", () => {
    const patterns = buildCredentialPatterns();
    const home = join("/tmp", "cl7929-never-created");
    const deny = [
      join(home, ".corbits", "settings.json.lock"),
      join(home, ".corbits", "settings.json.12345.1.tmp"),
      join(home, ".corbits", "permissions.json.lock"),
      join(home, ".corbits", "permissions.json.12345.1.tmp"),
      join(home, ".corbits", "codex-auth.json.lock"),
      join(home, ".corbits", "xai-auth.json.12345.1.tmp"),
    ];
    for (const path of deny) {
      expect(
        patterns.some((pattern) => pattern.test(path)),
        `${path} must match the credential denylist`,
      ).toBe(true);
    }
  });
});
