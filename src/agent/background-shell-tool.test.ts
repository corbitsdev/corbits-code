import { defined } from "../../tests/helpers/defined.js";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createPermissionGate } from "../permission/gate.js";
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
      await new Promise((r) => setTimeout(r, 300));
      const probe = spawnSync("pgrep", ["-f", token], { encoding: "utf8" });
      expect(probe.stdout?.trim() ?? "").toBe("");
      expect(probe.status).not.toBe(0);
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
    await new Promise((r) => setTimeout(r, 300));
    const probe = spawnSync("pgrep", ["-f", token], { encoding: "utf8" });
    expect(probe.stdout?.trim() ?? "").toBe("");
    expect(probe.status).not.toBe(0);
  });
});
