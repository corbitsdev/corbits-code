import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandReferencesSensitivePath,
  isSensitiveShellToken,
} from "./secret-guard-plugin.js";
import { isAutoAllowedShellCommand } from "../permission/classify.js";
import { autoShellRuleForCall } from "../permission/auto-shell-policy.js";

/**
 * CL-7790: shell token matching ignores symlinks. A benign-named symlink
 * into a secret file (notes.txt -> .env) must not auto-allow a content dump
 * (`cat notes.txt`), identically to the direct name (`cat .env`). Pure
 * name-listing (`ls notes.txt`) still lists freely — dumping contents is the
 * threat, listing a name is not (dump-vs-list distinction, CL-5420).
 */

async function withFixture<T>(
  run: (paths: { cwd: string }) => Promise<T>,
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "cl7790-shell-symlink-"));
  try {
    await writeFile(join(cwd, ".env"), "SECRET=fixture-env\n");
    await writeFile(join(cwd, "README.md"), "# fixture\n");
    await symlink(join(cwd, ".env"), join(cwd, "notes.txt"));
    return await run({ cwd });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const shellCall = (command: string) => ({
  id: "c",
  name: "run_shell",
  arguments: { command },
});

describe("CL-7790 shell tokens resolve symlinks before the secret denylist", () => {
  test("cat through a benign-named symlink does not auto-allow", async () => {
    await withFixture(async ({ cwd }) => {
      expect(isAutoAllowedShellCommand("cat notes.txt", cwd)).toBe(false);
    });
  });

  test("cat of the direct secret name still does not auto-allow", async () => {
    await withFixture(async ({ cwd }) => {
      expect(isAutoAllowedShellCommand("cat .env", cwd)).toBe(false);
    });
  });

  test("pure listing of the symlink still lists freely", async () => {
    await withFixture(async ({ cwd }) => {
      expect(isAutoAllowedShellCommand("ls notes.txt", cwd)).toBe(true);
      expect(isAutoAllowedShellCommand("ls -la", cwd)).toBe(true);
    });
  });

  test("pure listing of the direct secret name still asks (CL-5420)", async () => {
    await withFixture(async ({ cwd }) => {
      expect(isAutoAllowedShellCommand("ls .env", cwd)).toBe(false);
    });
  });

  test("plugin flags the symlinked dump but not the listing", async () => {
    await withFixture(async ({ cwd }) => {
      expect(commandReferencesSensitivePath("cat notes.txt", cwd)).toBe(
        "notes.txt",
      );
      expect(
        commandReferencesSensitivePath("ls notes.txt", cwd),
      ).toBeUndefined();
    });
  });

  test("shared helper matches the resolved target, not just the lexical name", async () => {
    await withFixture(async ({ cwd }) => {
      expect(isSensitiveShellToken("notes.txt", cwd)).toBe(true);
      // The listing leg never resolves: names are not contents.
      expect(isSensitiveShellToken("notes.txt", cwd, false)).toBe(false);
      expect(isSensitiveShellToken("README.md", cwd)).toBe(false);
    });
  });

  test("auto mode asks for the symlinked dump, not the listing", async () => {
    await withFixture(async ({ cwd }) => {
      expect(
        autoShellRuleForCall(shellCall("cat notes.txt"), () => false, cwd)
          ?.name,
      ).toBe("sensitive-path");
      expect(
        autoShellRuleForCall(shellCall("ls notes.txt"), () => false, cwd),
      ).toBeUndefined();
    });
  });
});
