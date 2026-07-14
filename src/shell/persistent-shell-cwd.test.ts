import { expect, test, describe } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";

import {
  SHELL_PWD_MARKER,
  assertShellCwdUsable,
  missingShellCwdMessage,
  parsePwdProbeOutput,
  wrapCommandWithPwdProbe,
} from "./persistent-shell-cwd.js";
import { runGuardedShell } from "../plugins/shell-guard-plugin.js";

describe("persistent-shell-cwd helpers", () => {
  test("parsePwdProbeOutput strips marker and returns final cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "ic-parse-pwd-"));
    const parsed = parsePwdProbeOutput(`hello\n${SHELL_PWD_MARKER}${root}\n`);
    expect(parsed.output).toBe("hello");
    expect(parsed.finalCwd).toBe(realpathSync(root));
  });

  test("missingShellCwdMessage is actionable", () => {
    expect(missingShellCwdMessage("/gone")).toContain("does not exist");
    expect(missingShellCwdMessage("/gone")).toContain("/gone");
  });

  test("assertShellCwdUsable rejects missing paths", () => {
    expect(() => assertShellCwdUsable("/nonexistent-intercode-cwd-test")).toThrow(
      /Shell working directory/,
    );
  });
});

describe("pwd probe via runGuardedShell", () => {
  test("cd in one invocation updates reported final cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "ic-shell-cwd-"));
    const sub = join(root, "sub");
    await mkdir(sub);
    const wrapped = wrapCommandWithPwdProbe("cd sub && pwd");
    const { output, exitCode } = await runGuardedShell(
      { command: wrapped, cwd: root },
      new AbortController().signal,
    );
    expect(exitCode).toBe(0);
    const parsed = parsePwdProbeOutput(output);
    expect(parsed.finalCwd).toBe(realpathSync(sub));
    expect(parsed.output).toContain(realpathSync(sub));
  });
});