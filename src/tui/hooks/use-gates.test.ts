import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { isRequestCoveredByGrant } from "../../permission/gate.js";
import { createPathRestriction } from "../../permission/path-restriction.js";
import { createWorktreeRootsProvider } from "../../permission/worktree-roots.js";
import type { ApprovalOutcome, Approval, PermissionRequest } from "../../permission/types.js";
import { useGates, type GateController, type PermissionGrantEvent } from "./use-gates.js";

function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    tool: "run_shell",
    action: "Run",
    subject: "bun install",
    scopes: [],
    cwd: "/repo",
    ...overrides,
  };
}

function Harness({
  emitter,
  controllerRef,
  activeProviderModel,
}: {
  emitter: EventEmitter;
  controllerRef: { current: GateController | null };
  activeProviderModel?: string;
}) {
  const gates = useGates({
    eventEmitter: emitter,
    setGatePending: () => {},
    ...(activeProviderModel !== undefined ? { activeProviderModel } : {}),
  });
  controllerRef.current = gates;
  return createElement(Text, null, String(gates.permissionQueueDepth));
}

function enqueuePermission(
  emitter: EventEmitter,
  req: PermissionRequest,
): Promise<ApprovalOutcome> {
  return new Promise((resolve) => {
    emitter.emit("permission.gate", { request: req, resolve });
  });
}

// Mirrors what the gate hands to onGrant: coverage judged with the gate's own
// path restriction, never one re-derived from the request's cwd.
function grant(
  emitter: EventEmitter,
  approval: Approval,
  activeProviderModel?: string,
): void {
  const cwd = process.cwd();
  const isRestricted = createPathRestriction(cwd, createWorktreeRootsProvider(cwd)).isRestricted;
  const event: PermissionGrantEvent = {
    approval,
    covers: (request) =>
      isRequestCoveredByGrant(request, approval, activeProviderModel, isRestricted),
  };
  emitter.emit("permission.grant", event);
}

describe("useGates queue reconciliation", () => {
  test("a session grant drains other queued requests it now covers", async () => {
    const emitter = new EventEmitter();
    const controllerRef: { current: GateController | null } = { current: null };
    const element = () => createElement(Harness, { emitter, controllerRef });
    const { rerender, unmount } = render(element());

    const outcomes: ApprovalOutcome[] = [];
    for (let i = 0; i < 3; i++) {
      enqueuePermission(emitter, request({ subject: "bun install" })).then((o) => outcomes.push(o));
    }
    rerender(element());
    expect(controllerRef.current!.permissionQueueDepth).toBe(3);

    grant(emitter, { tool: "run_shell", pattern: "bun install" });
    rerender(element());

    await new Promise((r) => setTimeout(r, 0));
    rerender(element());

    expect(controllerRef.current!.permissionQueueDepth).toBe(0);
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((o) => o.allow)).toBe(true);

    unmount();
  });

  test("a project-scoped grant only drains requests from the same repo", async () => {
    const emitter = new EventEmitter();
    const controllerRef: { current: GateController | null } = { current: null };
    const element = () => createElement(Harness, { emitter, controllerRef });
    const { rerender, unmount } = render(element());

    const outcomes: Array<{ cwd: string; outcome: ApprovalOutcome }> = [];
    enqueuePermission(emitter, request({ subject: "npm test", cwd: "/repo-a" })).then((o) =>
      outcomes.push({ cwd: "/repo-a", outcome: o }),
    );
    enqueuePermission(emitter, request({ subject: "npm test", cwd: "/repo-b" })).then((o) =>
      outcomes.push({ cwd: "/repo-b", outcome: o }),
    );
    rerender(element());
    expect(controllerRef.current!.permissionQueueDepth).toBe(2);

    // A project grant minted in /repo-a must never drain /repo-b's queued request.
    grant(emitter, { tool: "run_shell", pattern: "npm test", cwd: "/repo-a" });
    rerender(element());
    await new Promise((r) => setTimeout(r, 0));
    rerender(element());

    expect(controllerRef.current!.permissionQueueDepth).toBe(1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.cwd).toBe("/repo-a");
    expect(outcomes[0]!.outcome.allow).toBe(true);

    // Settle the remaining one so the promise doesn't dangle across tests.
    controllerRef.current!.resetGates();
    await new Promise((r) => setTimeout(r, 0));
    unmount();
  });

  test("a global grant drains queued requests regardless of repo", async () => {
    const emitter = new EventEmitter();
    const controllerRef: { current: GateController | null } = { current: null };
    const element = () => createElement(Harness, { emitter, controllerRef });
    const { rerender, unmount } = render(element());

    const outcomes: ApprovalOutcome[] = [];
    enqueuePermission(emitter, request({ subject: "npm test", cwd: "/repo-a" })).then((o) =>
      outcomes.push(o),
    );
    enqueuePermission(emitter, request({ subject: "npm test", cwd: "/repo-b" })).then((o) =>
      outcomes.push(o),
    );
    rerender(element());

    // Global grants carry no cwd, so they cover requests from any repo.
    grant(emitter, { tool: "run_shell", pattern: "npm test" });
    rerender(element());
    await new Promise((r) => setTimeout(r, 0));
    rerender(element());

    expect(controllerRef.current!.permissionQueueDepth).toBe(0);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.allow)).toBe(true);

    unmount();
  });

  test("a provider-model grant only drains requests matching the active model", async () => {
    const emitter = new EventEmitter();
    const controllerRef: { current: GateController | null } = { current: null };
    const element = () =>
      createElement(Harness, { emitter, controllerRef, activeProviderModel: "anthropic:opus" });
    const { rerender, unmount } = render(element());

    const outcomes: ApprovalOutcome[] = [];
    enqueuePermission(emitter, request({ subject: "npm test" })).then((o) => outcomes.push(o));
    rerender(element());

    grant(emitter, {
      tool: "run_shell",
      pattern: "npm test",
      providerModel: "openai:gpt-5",
    });
    rerender(element());
    await new Promise((r) => setTimeout(r, 0));
    rerender(element());

    expect(controllerRef.current!.permissionQueueDepth).toBe(1);
    expect(outcomes).toHaveLength(0);

    controllerRef.current!.resetGates();
    await new Promise((r) => setTimeout(r, 0));
    unmount();
  });

  test("a provider-model grant drains the queue when the active model matches", async () => {
    const emitter = new EventEmitter();
    const controllerRef: { current: GateController | null } = { current: null };
    const active = "openai:gpt-5";
    const element = () =>
      createElement(Harness, { emitter, controllerRef, activeProviderModel: active });
    const { rerender, unmount } = render(element());

    const outcomes: ApprovalOutcome[] = [];
    enqueuePermission(emitter, request({ subject: "npm test" })).then((o) => outcomes.push(o));
    rerender(element());

    grant(
      emitter,
      {
        tool: "run_shell",
        pattern: "npm test",
        providerModel: active,
      },
      active,
    );
    rerender(element());
    await new Promise((r) => setTimeout(r, 0));
    rerender(element());

    expect(controllerRef.current!.permissionQueueDepth).toBe(0);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.allow).toBe(true);

    unmount();
  });

  test("a grant that does not match the queued command's pattern leaves it queued", async () => {
    const emitter = new EventEmitter();
    const controllerRef: { current: GateController | null } = { current: null };
    const element = () => createElement(Harness, { emitter, controllerRef });
    const { rerender, unmount } = render(element());

    const outcomes: ApprovalOutcome[] = [];
    enqueuePermission(emitter, request({ subject: "rm -rf /tmp/x" })).then((o) => outcomes.push(o));
    rerender(element());

    grant(emitter, { tool: "run_shell", pattern: "bun install" });
    rerender(element());
    await new Promise((r) => setTimeout(r, 0));
    rerender(element());

    expect(controllerRef.current!.permissionQueueDepth).toBe(1);
    expect(outcomes).toHaveLength(0);

    controllerRef.current!.resetGates();
    await new Promise((r) => setTimeout(r, 0));
    unmount();
  });

  test("a secret-path request stays queued after a covering grant mints", async () => {
    const emitter = new EventEmitter();
    const controllerRef: { current: GateController | null } = { current: null };
    const element = () => createElement(Harness, { emitter, controllerRef });
    const { rerender, unmount } = render(element());

    const outcomes: ApprovalOutcome[] = [];
    enqueuePermission(emitter, request({ subject: "cat .env" })).then((o) => outcomes.push(o));
    rerender(element());

    grant(emitter, { tool: "run_shell", pattern: "cat *" });
    rerender(element());
    await new Promise((r) => setTimeout(r, 0));
    rerender(element());

    expect(controllerRef.current!.permissionQueueDepth).toBe(1);
    expect(outcomes).toHaveLength(0);

    controllerRef.current!.resetGates();
    await new Promise((r) => setTimeout(r, 0));
    unmount();
  });

  test("a restricted-path request stays queued after a covering grant mints", async () => {
    const emitter = new EventEmitter();
    const controllerRef: { current: GateController | null } = { current: null };
    const element = () => createElement(Harness, { emitter, controllerRef });
    const { rerender, unmount } = render(element());

    const outcomes: ApprovalOutcome[] = [];
    enqueuePermission(emitter, request({ subject: "cat /etc/passwd" })).then((o) =>
      outcomes.push(o),
    );
    rerender(element());

    grant(emitter, { tool: "run_shell", pattern: "cat *" });
    rerender(element());
    await new Promise((r) => setTimeout(r, 0));
    rerender(element());

    expect(controllerRef.current!.permissionQueueDepth).toBe(1);
    expect(outcomes).toHaveLength(0);

    controllerRef.current!.resetGates();
    await new Promise((r) => setTimeout(r, 0));
    unmount();
  });

  test("a plain covered request still auto-drains despite the new guards", async () => {
    const emitter = new EventEmitter();
    const controllerRef: { current: GateController | null } = { current: null };
    const element = () => createElement(Harness, { emitter, controllerRef });
    const { rerender, unmount } = render(element());

    const outcomes: ApprovalOutcome[] = [];
    enqueuePermission(emitter, request({ subject: "cat README.md" })).then((o) => outcomes.push(o));
    rerender(element());

    grant(emitter, { tool: "run_shell", pattern: "cat *" });
    rerender(element());
    await new Promise((r) => setTimeout(r, 0));
    rerender(element());

    expect(controllerRef.current!.permissionQueueDepth).toBe(0);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.allow).toBe(true);

    unmount();
  });
});
