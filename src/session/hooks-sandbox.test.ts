import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLifecycleHookManager, createRunSummary } from "./hooks.js";
import type { ShellSandbox } from "../shell/sandbox-config.js";
import type { RunSummary } from "./hooks.js";

// Regression for the warden's S1: lifecycle hooks are discovered under the
// per-session (sandbox-writable) .corbits/hooks directory, so a sandboxed
// session that raw-triggered its hooks would hand an attacker-planted file a
// full-privilege host spawn. With a sandbox handle wired, both hook shapes
// (["sh", path, kind] and ["bun", runner]) must wrap through the sandbox and
// fail closed when it cannot wrap.

function usage() {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    thinking: 0,
  } as const;
}

function summary(): RunSummary {
  return createRunSummary({
    task: "x",
    status: "done",
    startedAt: 0,
    finishedAt: 1,
    turnsUsed: 0,
    tokenUsage: usage(),
    turns: [],
    toolCallCount: 0,
  });
}

/** Records argv-form wraps; the stub argv just drains stdin and exits 0. */
function recordingSandbox(): {
  sandbox: ShellSandbox;
  argvWraps: { command: string; args: string[] }[];
  failNextWrap: { value: boolean };
} {
  const argvWraps: { command: string; args: string[] }[] = [];
  const failNextWrap = { value: false };
  return {
    argvWraps,
    failNextWrap,
    sandbox: {
      wrapShellCommand: async () => {
        throw new Error("hooks never use the shell-string wrap");
      },
      wrapExecArgv: async (command: string, args: readonly string[]) => {
        if (failNextWrap.value) {
          throw new Error("sandbox runtime is unavailable");
        }
        argvWraps.push({ command, args: [...args] });
        // The stub does not matter to the assertion — what the hook would
        // have raw-spawned is recorded; this executes and exits 0.
        return { argv: ["/bin/sh", "-c", "cat > /dev/null"] };
      },
      dispose: async () => undefined,
    },
  };
}

const plantedShellHook = String.raw`# shell hook: drains payload (planted by the test)
cat > /dev/null
`;
const plantedTsHook = String.raw`export function postRun() {}
`;

describe("lifecycle hooks spawn under the session sandbox", () => {
  test("planted shell + typescript hooks wrap through the sandbox argv form", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-hooks-"));
    const hooksDir = join(root, ".corbits", "hooks");
    await mkdir(hooksDir, { recursive: true });
    await writeFile(join(hooksDir, "planted.sh"), plantedShellHook);
    const tsHookPath = join(hooksDir, "planted.ts");
    await writeFile(tsHookPath, plantedTsHook);

    const { sandbox, argvWraps } = recordingSandbox();
    const manager = createLifecycleHookManager({
      hooks: [
        {
          id: join(hooksDir, "planted.sh"),
          name: "planted.sh",
          type: "shell",
          path: join(hooksDir, "planted.sh"),
        },
        {
          id: tsHookPath,
          name: "planted.ts",
          type: "typescript",
          path: tsHookPath,
        },
      ],
      getSandbox: () => sandbox,
    });
    await manager.dispatchPostRun(summary());

    // Exactly two wraps, one per hook shape, both carrying the planted path.
    expect(argvWraps).toHaveLength(2);
    expect(argvWraps[0]).toEqual({
      command: "sh",
      args: [join(hooksDir, "planted.sh"), "postRun"],
    });
    expect(argvWraps[1]?.command).toBe("bun");
    const runnerArg = argvWraps[1]?.args[0] ?? "";
    expect(runnerArg.endsWith(".ts")).toBe(true);
    expect(runnerArg).toContain("hook-runners");
  });

  test("a sandbox wrap failure surfaces fail-closed on the hook status", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-hooks-"));
    const hookPath = join(root, "origin.sh");
    await writeFile(hookPath, "true\n");
    const { sandbox, argvWraps, failNextWrap } = recordingSandbox();
    failNextWrap.value = true;
    const manager = createLifecycleHookManager({
      hooks: [
        { id: hookPath, name: "origin.sh", type: "shell", path: hookPath },
      ],
      getSandbox: () => sandbox,
    });
    await manager.dispatchPostRun(summary());
    expect(argvWraps).toHaveLength(0);
    const status = manager.getStatuses()[0];
    // The wrap failure surfaces on the hook status (runHook records it) — the
    // prefixed fail-closed shape is asserted in sandbox-config.test.ts via
    // createShellSandbox's wrapper; here the raw cause proves the hook never
    // rode the raw spawn.
    expect(status?.lastExitStatus?.stderr).toContain(
      "sandbox runtime is unavailable",
    );
  });
});
