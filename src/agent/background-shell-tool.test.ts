import { defined } from "../../tests/helpers/defined.js";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

/** Poll until no process carries `token`; fail instead of asserting on a pid. */
async function waitUntilGone(token: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    const probe = spawnSync("pgrep", ["-f", token], { encoding: "utf8" });
    if ((probe.stdout?.trim() ?? "").length === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`tagged child still alive after 5s: ${token}`);
}
import { createPermissionGate } from "../permission/gate.js";
import { shellCollectDefinition } from "./background-shell-tool.js";
import { createAgentToolset } from "./tools.js";
import type { BackgroundShellExit } from "../shell/background-shell.js";
import { buildShellBackgroundMessage } from "../session/runtime-assembly.js";
import { OPERATOR_ORIGINATED_FLAG } from "../agent/message-provenance.js";

function gate(cwd: string) {
  return createPermissionGate({
    approvals: [],
    interactive: false,
    skipPermissions: true,
    reactorGated: false,
    cwd,
  });
}

describe("background shell through the agent toolset", () => {
  test("run_shell background:true returns a handle and delivers the exit on exit", async () => {
    const exits: BackgroundShellExit[] = [];
    const toolset = await createAgentToolset({
      cwd: process.cwd(),
      permissionGate: gate(process.cwd()),
      onOperatorGate: async () => ({ kind: "cancel" as const }),
      onBackgroundShellExit: (exit) => exits.push(exit),
    });
    try {
      const started = await toolset.dynamicRunner.run(
        {
          id: "bg-start",
          name: "run_shell",
          arguments: { command: "sleep 0.4; echo bg-done", background: true },
        },
        new AbortController().signal,
      );
      expect(started.isError).not.toBe(true);
      const parsed = JSON.parse(String(started.content)) as {
        shell_id: string;
      };
      const snapshotNow = await toolset.dynamicRunner.run(
        {
          id: "bg-collect",
          name: "shell_collect",
          arguments: { shell_id: parsed.shell_id, action: "collect" },
        },
        new AbortController().signal,
      );
      expect(JSON.parse(String(snapshotNow.content))).toMatchObject({
        status: "running",
      });
      const final = await toolset.dynamicRunner.run(
        {
          id: "bg-collect2",
          name: "shell_collect",
          arguments: {
            shell_id: parsed.shell_id,
            action: "collect",
            wait_ms: 5_000,
          },
        },
        new AbortController().signal,
      );
      const result = JSON.parse(String(final.content)) as {
        status: string;
        exit_code: number;
        output: string;
      };
      expect(result).toMatchObject({ status: "completed", exit_code: 0 });
      expect(result.output).toContain("bg-done");
      await new Promise((r) => setTimeout(r, 50));
      expect(exits).toHaveLength(1);
      expect(defined(exits[0]).id).toBe(parsed.shell_id);
      const message = buildShellBackgroundMessage(defined(exits[0]));
      expect(message.headers.messageId).toBe(
        `bg-shell-${parsed.shell_id}@local`,
      );
      expect(message.ref.mailbox).toBe("system");
      expect(message.flags).not.toContain(OPERATOR_ORIGINATED_FLAG);
      expect(message.content).toContain("exit code 0");
      expect(message.content).toContain("bg-done");
    } finally {
      await toolset.dispose();
    }
  });

  test("shell_collect cancel kills the session's own child process group", async () => {
    const token = `ic_toolset_cancel_${randomUUID()}`;
    const toolset = await createAgentToolset({
      cwd: process.cwd(),
      permissionGate: gate(process.cwd()),
      onOperatorGate: async () => ({ kind: "cancel" as const }),
    });
    try {
      const started = await toolset.dynamicRunner.run(
        {
          id: "c-start",
          name: "run_shell",
          arguments: {
            command: `sleep 600 # ${token}`,
            background: true,
          },
        },
        new AbortController().signal,
      );
      const { shell_id } = JSON.parse(String(started.content)) as {
        shell_id: string;
      };
      const cancelled = await toolset.dynamicRunner.run(
        {
          id: "c-cancel",
          name: "shell_collect",
          arguments: { shell_id, action: "cancel" },
        },
        new AbortController().signal,
      );
      expect(JSON.parse(String(cancelled.content))).toMatchObject({
        status: "cancelling",
      });
      await waitUntilGone(token);
    } finally {
      await toolset.dispose();
    }
  });

  test("shell_collect with an aborted signal releases as running without killing the child", async () => {
    const toolset = await createAgentToolset({
      cwd: process.cwd(),
      permissionGate: gate(process.cwd()),
    });
    try {
      const started = await toolset.dynamicRunner.run(
        {
          id: "a-start",
          name: "run_shell",
          arguments: {
            command: "sleep 60",
            background: true,
          },
        },
        new AbortController().signal,
      );
      const { shell_id } = JSON.parse(String(started.content)) as {
        shell_id: string;
      };
      const aborted = new AbortController();
      aborted.abort(new Error("interrupted by interrupt_agent"));
      const out = await toolset.dynamicRunner.run(
        {
          id: "a-collect",
          name: "shell_collect",
          arguments: { shell_id, action: "collect", wait_ms: 60_000 },
        },
        aborted.signal,
      );
      expect(JSON.parse(String(out.content))).toMatchObject({
        status: "running",
      });
      // A live-signal collect still sees the child running: the abort above
      // released the waiter instead of killing the process. Had the abort
      // killed it, this would already report completed.
      const stillThere = await toolset.dynamicRunner.run(
        {
          id: "a-collect2",
          name: "shell_collect",
          arguments: { shell_id, action: "collect" },
        },
        new AbortController().signal,
      );
      expect(JSON.parse(String(stillThere.content))).toMatchObject({
        status: "running",
      });
      // And the child is still killable: cancel settles it as completed.
      const cancelled = await toolset.dynamicRunner.run(
        {
          id: "a-cancel",
          name: "shell_collect",
          arguments: { shell_id, action: "cancel" },
        },
        new AbortController().signal,
      );
      expect(JSON.parse(String(cancelled.content))).toMatchObject({
        status: "cancelling",
      });
      const final = await toolset.dynamicRunner.run(
        {
          id: "a-collect3",
          name: "shell_collect",
          arguments: { shell_id, action: "collect", wait_ms: 5_000 },
        },
        new AbortController().signal,
      );
      expect(JSON.parse(String(final.content))).toMatchObject({
        status: "completed",
      });
    } finally {
      await toolset.dispose();
    }
  });

  test("toolset dispose kills every live background process group", async () => {
    const token = `ic_toolset_dispose_${randomUUID()}`;
    const toolset = await createAgentToolset({
      cwd: process.cwd(),
      permissionGate: gate(process.cwd()),
      onOperatorGate: async () => ({ kind: "cancel" as const }),
    });
    const started = await toolset.dynamicRunner.run(
      {
        id: "d-start",
        name: "run_shell",
        arguments: { command: `sleep 600 # ${token}`, background: true },
      },
      new AbortController().signal,
    );
    expect(started.isError).not.toBe(true);
    await toolset.dispose();
    await waitUntilGone(token);
  });
});

describe("shell_collect tool copy", () => {
  test("names the doom-loop exemption for still-running polls", () => {
    expect(shellCollectDefinition.description).toContain("doom-loop guard");
    expect(shellCollectDefinition.description).toContain("liveness");
    expect(shellCollectDefinition.description).toContain("running");
  });
});
