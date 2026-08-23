import { describe, test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { createPermissionRequestQueue, wirePermissionGrantReconciliation } from "./queue.js";
import { isRequestCoveredByGrant } from "./gate.js";
import { createPathRestriction } from "./path-restriction.js";
import { createWorktreeRootsProvider } from "./worktree-roots.js";
import type { Approval, ApprovalOutcome, PermissionRequest } from "./types.js";

function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    tool: "run_shell",
    action: "Run",
    subject: "bun install",
    scopes: [],
    cwd: process.cwd(),
    ...overrides,
  };
}

// Mirrors the predicate PermissionGateOptions.onGrant hands callers: coverage
// judged with the gate's own path restriction and project workspace, not
// ones re-derived here.
function coversFor(
  approval: Approval,
  activeProviderModel?: string,
): (r: PermissionRequest) => boolean {
  const cwd = process.cwd();
  const rootsProvider = createWorktreeRootsProvider(cwd);
  const isRestricted = createPathRestriction(cwd, rootsProvider).isRestricted;
  const workspace = { resolvedCwd: cwd, roots: rootsProvider() };
  return (r) => isRequestCoveredByGrant(r, approval, activeProviderModel, isRestricted, workspace);
}

describe("createPermissionRequestQueue", () => {
  test("settle resolves the enqueued request and removes it", () => {
    const queue = createPermissionRequestQueue();
    const outcomes: ApprovalOutcome[] = [];
    const id = queue.enqueue(request(), (o) => outcomes.push(o));
    expect(queue.size()).toBe(1);

    expect(queue.settle(id, { allow: true })).toBe(true);
    expect(outcomes).toEqual([{ allow: true }]);
    expect(queue.size()).toBe(0);
  });

  test("settle is a no-op once an id has already settled", () => {
    const queue = createPermissionRequestQueue();
    const outcomes: ApprovalOutcome[] = [];
    const id = queue.enqueue(request(), (o) => outcomes.push(o));

    expect(queue.settle(id, { allow: true })).toBe(true);
    expect(queue.settle(id, { allow: false })).toBe(false);
    expect(outcomes).toEqual([{ allow: true }]);
  });

  test("reconcile drains every queued request a grant now covers, in order", () => {
    const queue = createPermissionRequestQueue();
    const outcomes: ApprovalOutcome[] = [];
    for (let i = 0; i < 3; i++) {
      queue.enqueue(request({ subject: "bun install" }), (o) => outcomes.push(o));
    }
    // An unrelated request stays queued — the grant does not cover it.
    queue.enqueue(request({ subject: "bun test" }), (o) => outcomes.push(o));

    const covers = coversFor({ tool: "run_shell", pattern: "bun install" });
    const settledIds = queue.reconcile(covers);

    expect(settledIds).toHaveLength(3);
    expect(outcomes).toEqual([{ allow: true }, { allow: true }, { allow: true }]);
    expect(queue.size()).toBe(1);
    expect(queue.list().map((e) => e.tool)).toEqual(["run_shell"]);
  });

  test("reconcile leaves requests from a different cwd queued for a project grant", () => {
    const queue = createPermissionRequestQueue();
    const outcomes: ApprovalOutcome[] = [];
    const cwd = process.cwd();
    queue.enqueue(request({ subject: "bun install", cwd: `${cwd}/other-repo` }), (o) =>
      outcomes.push(o),
    );

    const covers = coversFor({ tool: "run_shell", pattern: "bun install", cwd });
    queue.reconcile(covers);

    expect(outcomes).toHaveLength(0);
    expect(queue.size()).toBe(1);
  });

  test("reconcile is safe against settling mid-snapshot: no entry is skipped or double-visited", () => {
    const queue = createPermissionRequestQueue();
    let calls = 0;
    for (let i = 0; i < 5; i++) {
      queue.enqueue(request({ subject: "bun install" }), () => {
        calls++;
      });
    }
    queue.reconcile(coversFor({ tool: "run_shell", pattern: "bun install" }));
    expect(calls).toBe(5);
    expect(queue.size()).toBe(0);
  });

  test("drain denies everything still queued instead of leaving a resolve hanging", () => {
    const queue = createPermissionRequestQueue();
    const outcomes: ApprovalOutcome[] = [];
    queue.enqueue(request(), (o) => outcomes.push(o));
    queue.enqueue(request({ subject: "bun test" }), (o) => outcomes.push(o));

    queue.drain();

    expect(outcomes).toEqual([{ allow: false }, { allow: false }]);
    expect(queue.size()).toBe(0);
  });
});

describe("wirePermissionGrantReconciliation", () => {
  test("reconciles a queue against permission.grant events on the emitter", async () => {
    const emitter = new EventEmitter();
    const queue = createPermissionRequestQueue();
    const dispose = wirePermissionGrantReconciliation(emitter, queue);

    const outcomes: ApprovalOutcome[] = [];
    queue.enqueue(request({ subject: "bun install" }), (o) => outcomes.push(o));
    queue.enqueue(request({ subject: "bun install" }), (o) => outcomes.push(o));

    const approval: Approval = { tool: "run_shell", pattern: "bun install" };
    emitter.emit("permission.grant", { approval, covers: coversFor(approval) });

    expect(outcomes).toEqual([{ allow: true }, { allow: true }]);
    expect(queue.size()).toBe(0);

    dispose();
  });

  test("ignores a malformed grant payload instead of throwing", () => {
    const emitter = new EventEmitter();
    const queue = createPermissionRequestQueue();
    const dispose = wirePermissionGrantReconciliation(emitter, queue);

    queue.enqueue(request(), () => {
      throw new Error("must not settle on a malformed payload");
    });

    expect(() => emitter.emit("permission.grant", { nope: true })).not.toThrow();
    expect(queue.size()).toBe(1);

    dispose();
  });

  test("dispose stops further reconciliation", () => {
    const emitter = new EventEmitter();
    const queue = createPermissionRequestQueue();
    const dispose = wirePermissionGrantReconciliation(emitter, queue);
    dispose();

    const outcomes: ApprovalOutcome[] = [];
    queue.enqueue(request({ subject: "bun install" }), (o) => outcomes.push(o));
    const approval: Approval = { tool: "run_shell", pattern: "bun install" };
    emitter.emit("permission.grant", { approval, covers: coversFor(approval) });

    expect(outcomes).toHaveLength(0);
  });
});
