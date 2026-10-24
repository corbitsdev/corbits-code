import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall } from "@intx/types/runtime";

import { createPermissionGate, isRequestCoveredByApproval } from "./gate.js";
import { createPathRestriction } from "./path-restriction.js";
import type { Approval, PermissionRequest } from "./types.js";
import {
  createDeniedCallEnvelope,
  getProcessWorkerGrantStore,
} from "./worker-grant.js";
import { createWorktreeRootsProvider } from "./worktree-roots.js";

const cwd = mkdtempSync(join(tmpdir(), "approve-worker-call-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));
afterEach(() => getProcessWorkerGrantStore().clear());

const SAVED_RULE: Approval = { tool: "approve_worker_call", pattern: "*" };

function countingGate(
  opts: {
    approvals?: Approval[];
    allow?: boolean;
    pluginEffect?: "allow" | "ask";
  } = {},
) {
  const prompts: PermissionRequest[] = [];
  const { pluginEffect } = opts;
  const gate = createPermissionGate({
    approvals: opts.approvals ?? [],
    cwd,
    interactive: true,
    skipPermissions: false,
    reactorGated: false,
    requestApproval: async (request) => {
      prompts.push(request);
      return { allow: opts.allow ?? true };
    },
    ...(pluginEffect !== undefined
      ? {
          pluginAuthorize: async () => ({
            effect: pluginEffect,
            matchingGrants: [],
            resolvedBy: null,
          }),
        }
      : {}),
  });
  return { gate, prompts };
}

const shellCall = (command: string): ToolCall => ({
  id: "frozen-shell",
  name: "run_shell",
  arguments: { command },
});

function deniedShellCall(command: string, workerLabel?: string) {
  return getProcessWorkerGrantStore().register(
    createDeniedCallEnvelope({
      callId: "worker-call-1",
      tool: "run_shell",
      action: "Run shell command",
      subject: command,
      args: { command },
      cwd,
      workerSessionId: "worker-1",
      ...(workerLabel !== undefined ? { workerLabel } : {}),
    }),
  );
}

const approveCall = (requestId: string): ToolCall => ({
  id: "approve-1",
  name: "approve_worker_call",
  arguments: {
    target: "worker-1",
    question_id: "question-1",
    request_id: requestId,
  },
});

describe("the approve_worker_call prompt", () => {
  test("shows the worker's frozen call and offers no standing grant", async () => {
    const envelope = deniedShellCall(
      "printf changed > generated.txt",
      "lint fixer",
    );
    const { gate, prompts } = countingGate();

    expect(await gate.evaluate(approveCall(envelope.requestId))).toEqual({
      allowed: true,
    });

    expect(prompts).toHaveLength(1);
    const [prompt] = prompts;
    expect(prompt?.tool).toBe("approve_worker_call");
    expect(prompt?.subject).toBe("printf changed > generated.txt");
    expect(prompt?.action).toContain("Run shell command");
    expect(prompt?.agentLabel).toBe("lint fixer");
    expect(prompt?.scopes).toEqual([]);
  });

  test("names the worker by id when its label was not recorded", async () => {
    const envelope = deniedShellCall("printf changed > generated.txt");
    const { gate, prompts } = countingGate();

    await gate.evaluate(approveCall(envelope.requestId));

    expect(prompts[0]?.agentLabel).toBe("worker-1");
  });

  test("still prompts when no live denied call matches, without a standing grant", async () => {
    const { gate, prompts } = countingGate();

    await gate.evaluate(approveCall("no-such-request"));

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.tool).toBe("approve_worker_call");
    expect(prompts[0]?.scopes).toEqual([]);
  });

  test("prompts even when a saved rule would cover it", async () => {
    const envelope = deniedShellCall("printf changed > generated.txt");
    const { gate, prompts } = countingGate({ approvals: [SAVED_RULE] });

    await gate.evaluate(approveCall(envelope.requestId));

    expect(prompts).toHaveLength(1);
  });

  test("is never drained from the queue by a saved rule", () => {
    const envelope = deniedShellCall("printf changed > generated.txt");
    const request: PermissionRequest = {
      tool: "approve_worker_call",
      action: "Approve worker call",
      subject: envelope.permissionSubject,
      scopes: [],
      cwd,
    };
    const isRestricted = createPathRestriction(
      cwd,
      createWorktreeRootsProvider(cwd),
    ).isRestricted;

    expect(
      isRequestCoveredByApproval(request, SAVED_RULE, undefined, isRestricted, {
        resolvedCwd: cwd,
        roots: [],
      }),
    ).toBe(false);
  });
});

describe("evaluateApprovedWorkerCall", () => {
  const writeCall: ToolCall = {
    id: "frozen-1",
    name: "write_file",
    arguments: { path: join(cwd, "notes.txt"), content: "approved" },
  };

  test("an ordinary ask is answered by the approve_worker_call prompt", async () => {
    const control = countingGate();
    await control.gate.evaluate(writeCall);
    expect(control.prompts).toHaveLength(1);

    const { gate, prompts } = countingGate();
    expect(await gate.evaluateApprovedWorkerCall(writeCall)).toEqual({
      allowed: true,
    });
    expect(prompts).toHaveLength(0);
  });

  test.each([
    ["a sensitive path", "cat .env"],
    ["a restricted target", "cat /etc/passwd"],
  ])("a call touching %s still prompts on its own", async (_name, command) => {
    const approved = countingGate();
    expect(
      await approved.gate.evaluateApprovedWorkerCall({
        id: "frozen-1",
        name: "run_shell",
        arguments: { command },
      }),
    ).toEqual({ allowed: true });
    expect(approved.prompts).toHaveLength(1);

    const declined = countingGate({ allow: false });
    const verdict = await declined.gate.evaluateApprovedWorkerCall({
      id: "frozen-2",
      name: "run_shell",
      arguments: { command },
    });
    expect(verdict.allowed).toBe(false);
  });

  test("a restricted non-shell target still prompts on its own", async () => {
    const { gate, prompts } = countingGate();

    // The session state root is write-ask even inside the workspace.
    const verdict = await gate.evaluateApprovedWorkerCall({
      id: "frozen-1",
      name: "write_file",
      arguments: { path: join(cwd, ".agent-state", "x.json"), content: "{}" },
    });

    expect(verdict).toEqual({ allowed: true });
    expect(prompts).toHaveLength(1);
  });

  test.each([
    ["the gate allows", "ls"],
    ["the gate already asks for", "printf x > out.txt"],
  ])(
    "a plugin-policy ask on a call %s still prompts",
    async (_name, command) => {
      const { gate, prompts } = countingGate({ pluginEffect: "ask" });

      await gate.evaluateApprovedWorkerCall(shellCall(command));

      expect(prompts).toHaveLength(1);
    },
  );

  test("a plugin allow adds no prompt to an ordinary ask", async () => {
    const { gate, prompts } = countingGate({ pluginEffect: "allow" });

    await gate.evaluateApprovedWorkerCall(shellCall("printf x > out.txt"));

    expect(prompts).toHaveLength(0);
  });

  test("a hard deny still blocks without a prompt", async () => {
    const { gate, prompts } = countingGate();

    const verdict = await gate.evaluateApprovedWorkerCall({
      id: "frozen-1",
      name: "run_shell",
      arguments: { command: "rm -rf /" },
    });

    expect(verdict.allowed).toBe(false);
    expect(prompts).toHaveLength(0);
  });
});
