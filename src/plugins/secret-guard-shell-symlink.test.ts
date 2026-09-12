import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
    // Extensionless twin of notes.txt: no dot, no slash.
    await symlink(join(cwd, ".env"), join(cwd, "notes"));
    // A link visible only from a subdirectory, for the cd-prefix case.
    await mkdir(join(cwd, "sub"), { recursive: true });
    await symlink(join(cwd, ".env"), join(cwd, "sub", "secret-link.txt"));
    return await run({ cwd });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

// A `~`-reachable secret and a benign-named link into it. Bun's homedir()
// does not follow a runtime-overridden $HOME, so the fixture lives in the
// real home directory under unique per-run names (never the real ~/.env)
// and is removed in `finally`.
async function withHomeFixture<T>(
  run: (paths: { linkName: string }) => Promise<T>,
): Promise<T> {
  const { homedir } = await import("node:os");
  const home = homedir();
  const tag = `cl7790-probe-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
  const secretName = `${tag}.pem`;
  const linkName = `${tag}-notes`;
  try {
    await writeFile(join(home, secretName), "SECRET=fixture-home-pem\n");
    await symlink(join(home, secretName), join(home, linkName));
    return await run({ linkName });
  } finally {
    await rm(join(home, linkName), { force: true });
    await rm(join(home, secretName), { force: true });
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

  test("cat through an extensionless symlink does not auto-allow", async () => {
    await withFixture(async ({ cwd }) => {
      expect(isAutoAllowedShellCommand("cat notes", cwd)).toBe(false);
      expect(commandReferencesSensitivePath("cat notes", cwd)).toBe("notes");
      expect(isSensitiveShellToken("notes", cwd)).toBe(true);
    });
  });

  test("flag-adjacent bare names do not auto-allow", async () => {
    await withFixture(async ({ cwd }) => {
      // `=` splits `--file=notes` into a bare `notes` token; `-n` is a flag.
      expect(isAutoAllowedShellCommand("cat -n notes", cwd)).toBe(false);
      expect(commandReferencesSensitivePath("cat -n notes", cwd)).toBe("notes");
      expect(isAutoAllowedShellCommand("grep --file=notes foo", cwd)).toBe(
        false,
      );
    });
  });

  test("missing bare names still auto-allow (no false positive on a miss)", async () => {
    await withFixture(async ({ cwd }) => {
      // Nothing named Makefile exists in the fixture: the existence probe
      // misses and the command stays auto-allowed.
      expect(isAutoAllowedShellCommand("cat Makefile", cwd)).toBe(true);
      expect(
        commandReferencesSensitivePath("cat Makefile", cwd),
      ).toBeUndefined();
    });
  });

  test("home-relative link asks for the secret reason, not just outside-workspace", async () => {
    await withFixture(async ({ cwd }) => {
      await withHomeFixture(async ({ linkName }) => {
        const command = `cat ~/${linkName}`;
        // classify.ts would already ask here via the `~` outside-workspace
        // rule; the point of `~` expansion is that the *secret* reason fires.
        expect(commandReferencesSensitivePath(command, cwd)).toBe(
          `~/${linkName}`,
        );
        expect(isAutoAllowedShellCommand(command, cwd)).toBe(false);
        expect(
          autoShellRuleForCall(shellCall(command), () => false, cwd)?.name,
        ).toBe("sensitive-path");
      });
    });
  });

  test("cd-prefixed dump fails closed; per-segment cd tracking is out of scope", async () => {
    await withFixture(async ({ cwd }) => {
      // Relative tokens resolve against the session cwd, not a `cd` prefix
      // inside the command — the shell would open cwd/sub/secret-link.txt but
      // the secret leg only sees cwd/secret-link.txt (absent), so no secret
      // reason fires here. The chain still asks because `cd` is not a safe
      // program; per-segment `cd` modeling is deliberately not attempted.
      expect(
        isAutoAllowedShellCommand("cd sub && cat secret-link.txt", cwd),
      ).toBe(false);
      expect(
        commandReferencesSensitivePath("cd sub && cat secret-link.txt", cwd),
      ).toBeUndefined();
    });
  });
});
