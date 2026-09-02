import { describe, test, expect } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";
import type { Approval, PermissionRequest } from "./types.js";
import {
  evaluateApprovals,
  grantScopeMatches,
  cwdMatchesGrant,
  type GrantWorkspace,
} from "./authz-grants.js";
import { createPermissionGate, isRequestCoveredByGrant } from "./gate.js";
import { createPermissionRequestQueue } from "./queue.js";
import { buildRequests } from "./classify.js";

// evaluateApprovals and isRequestCoveredByGrant each decide, independently,
// whether a grant's tool/providerModel/cwd scope covers a request. Both are
// expected to delegate to the same shared predicate (grantScopeMatches)
// rather than reimplementing the condition. This test drives the same
// grant+request pairs through all three and asserts they agree — a
// regression where one call site reimplements the check with subtly
// different semantics would fail here even if each function still "looks
// right" in isolation.
describe("grant tool/providerModel/cwd scoping agrees across call sites", () => {
  const workspace: GrantWorkspace = { resolvedCwd: "/proj", roots: ["/proj"] };
  const noopRestricted = () => false;

  const grants: Approval[] = [
    { tool: "run_shell", pattern: "npm test" },
    { tool: "run_shell", pattern: "npm test", providerModel: "openai:gpt-5" },
    { tool: "run_shell", pattern: "npm test", cwd: "/proj" },
    { tool: "write_file", pattern: "npm test" },
  ];

  const requests: {
    tool: string;
    cwd?: string | undefined;
    activeProviderModel?: string | undefined;
  }[] = [
    { tool: "run_shell", cwd: "/proj", activeProviderModel: "openai:gpt-5" },
    { tool: "run_shell", cwd: "/proj", activeProviderModel: "anthropic:opus" },
    { tool: "run_shell", cwd: "/other", activeProviderModel: "openai:gpt-5" },
    { tool: "run_shell", cwd: undefined, activeProviderModel: undefined },
    { tool: "write_file", cwd: "/proj", activeProviderModel: undefined },
  ];

  for (const grant of grants) {
    for (const req of requests) {
      test(`grant ${JSON.stringify(grant)} vs request ${JSON.stringify(req)}`, async () => {
        const expected = grantScopeMatches(
          grant,
          req.tool,
          req.activeProviderModel,
          req.cwd,
          workspace,
        );

        const viaEvaluateApprovals = await evaluateApprovals({
          tool: req.tool,
          subject: "npm test",
          approvals: [grant],
          activeProviderModel: req.activeProviderModel,
          requestCwd: req.cwd,
          workspace,
        });

        const request: PermissionRequest = {
          tool: req.tool,
          action: req.tool,
          subject: "npm test",
          scopes: [],
          ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
        };
        const viaGate = isRequestCoveredByGrant(
          request,
          grant,
          req.activeProviderModel,
          noopRestricted,
          workspace,
        );

        // Both live call sites additionally require the pattern to match the
        // subject, which is true for every case here ("npm test" grants an
        // exact "npm test" subject), so a scope mismatch is the only thing
        // that can make either disagree with the shared predicate.
        expect(viaEvaluateApprovals).toBe(expected);
        expect(viaGate).toBe(expected);
      });
    }
  }
});

// Grant minting decomposes a multi-segment chain scope into one grant per
// real segment (see mintGrant in gate.ts). A grant whose pattern is the full
// chain string is legacy shape: evaluate() and isRequestCoveredByGrant both
// match per segment only, so that shape never replays. Per-segment grants are
// the live path (see permission.test.ts).
describe("a scope-mismatched grant never replays a multi-segment chain", () => {
  const full = "npm i && curl x";
  const shellCall = (command: string): ToolCall => ({
    id: "c",
    name: "run_shell",
    arguments: { command },
  });

  test("does not replay a grant scoped to a different cwd", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [{ tool: "run_shell", pattern: "npm i", cwd: "/other-project" }],
      requestApproval: async () => {
        asked++;
        return { allow: true };
      },
      interactive: true,
      skipPermissions: false,
    });
    expect((await gate.evaluate(shellCall(full))).allowed).toBe(true);
    expect(asked).toBeGreaterThan(0);
  });

  test("does not replay a grant scoped to a different provider model", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [{ tool: "run_shell", pattern: "npm i", providerModel: "openai:gpt-5" }],
      providerName: "anthropic",
      model: "opus",
      requestApproval: async () => {
        asked++;
        return { allow: true };
      },
      interactive: true,
      skipPermissions: false,
    });
    expect((await gate.evaluate(shellCall(full))).allowed).toBe(true);
    expect(asked).toBeGreaterThan(0);
  });

  test("replays per-segment grants whose scope grantScopeMatches accepts", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [
        { tool: "run_shell", pattern: "npm i" },
        { tool: "run_shell", pattern: "curl x" },
      ],
      requestApproval: async () => {
        asked++;
        return { allow: true };
      },
      interactive: true,
      skipPermissions: false,
    });
    expect((await gate.evaluate(shellCall(full))).allowed).toBe(true);
    expect(asked).toBe(0);
  });
});

// Explicit rejection of the pre-CL-5752 whole-string chain grant shape: both
// evaluate() and isRequestCoveredByGrant match per segment only, so a stored
// pattern equal to the full chain never short-circuits. Dual paths stay
// aligned — neither honors legacy while the other rejects it.
describe("legacy whole-string chain grants are explicitly rejected", () => {
  const full = "npm i && curl x";
  const shellCall = (command: string): ToolCall => ({
    id: "c",
    name: "run_shell",
    arguments: { command },
  });
  const workspace: GrantWorkspace = { resolvedCwd: "/proj", roots: ["/proj"] };
  const noopRestricted = () => false;

  test("evaluate() re-prompts for a legacy full-chain pattern", async () => {
    let asked = 0;
    const gate = createPermissionGate({
      approvals: [{ tool: "run_shell", pattern: full }],
      requestApproval: async () => {
        asked++;
        return { allow: true };
      },
      interactive: true,
      skipPermissions: false,
    });
    expect((await gate.evaluate(shellCall(full))).allowed).toBe(true);
    expect(asked).toBe(1);
  });

  test("isRequestCoveredByGrant refuses a legacy full-chain pattern", () => {
    const request: PermissionRequest = {
      tool: "run_shell",
      action: "Run",
      subject: full,
      scopes: [],
      cwd: "/proj",
    };
    expect(
      isRequestCoveredByGrant(
        request,
        { tool: "run_shell", pattern: full },
        undefined,
        noopRestricted,
        workspace,
      ),
    ).toBe(false);
  });

  test("a single per-segment grant alone does not cover the full chain", () => {
    const request: PermissionRequest = {
      tool: "run_shell",
      action: "Run",
      subject: full,
      scopes: [],
      cwd: "/proj",
    };
    expect(
      isRequestCoveredByGrant(
        request,
        { tool: "run_shell", pattern: "npm i" },
        undefined,
        noopRestricted,
        workspace,
      ),
    ).toBe(false);
  });
});

// After the operator approves `a && b`, mintGrant emits one grant per segment
// and onGrant's covers predicate sees the live approvals list — so a queued
// identical chain drains once both segments are present, without a second
// prompt.
describe("queue reconcile drains an identical chain after per-segment mint", () => {
  const full = "npm i && curl x";
  const shellCall = (command: string): ToolCall => ({
    id: "c",
    name: "run_shell",
    arguments: { command },
  });

  test("queued identical chain settles after approving the same chain", async () => {
    const queue = createPermissionRequestQueue();
    const outcomes: { allow: boolean }[] = [];
    queue.enqueue(
      {
        tool: "run_shell",
        action: "Run",
        subject: full,
        scopes: [],
        cwd: process.cwd(),
      },
      (o) => outcomes.push({ allow: o.allow }),
    );

    const built = buildRequests(shellCall(full))[0]?.scopes[0];
    expect(built?.pattern).toBe(full);
    if (built === undefined) throw new Error("expected chain scope");

    let grantEvents = 0;
    const gate = createPermissionGate({
      approvals: [],
      requestApproval: async () => ({
        allow: true,
        persist: { ...built, grant: "session" as const },
      }),
      onGrant: (_approval, covers) => {
        grantEvents++;
        queue.reconcile(covers);
      },
      interactive: true,
      skipPermissions: false,
    });

    expect((await gate.evaluate(shellCall(full))).allowed).toBe(true);
    // Two per-segment grants minted → two onGrant fires; the second drains.
    expect(grantEvents).toBe(2);
    expect(outcomes).toEqual([{ allow: true }]);
    expect(queue.size()).toBe(0);
  });

  test("first per-segment mint alone does not drain a multi-segment queue entry", async () => {
    const queue = createPermissionRequestQueue();
    const outcomes: { allow: boolean }[] = [];
    queue.enqueue(
      {
        tool: "run_shell",
        action: "Run",
        subject: full,
        scopes: [],
        cwd: process.cwd(),
      },
      (o) => outcomes.push({ allow: o.allow }),
    );

    // Seed only the first segment via a one-segment persist, then assert the
    // queued full chain stays put — draining on a partial grant would let an
    // unapproved tail through.
    const gate = createPermissionGate({
      approvals: [],
      requestApproval: async () => ({
        allow: true,
        persist: {
          id: "exact",
          label: "Always allow this exact command",
          pattern: "npm i",
          grant: "session" as const,
        },
      }),
      onGrant: (_approval, covers) => {
        queue.reconcile(covers);
      },
      interactive: true,
      skipPermissions: false,
    });

    expect((await gate.evaluate(shellCall("npm i"))).allowed).toBe(true);
    expect(outcomes).toEqual([]);
    expect(queue.size()).toBe(1);
  });
});

// A project-scoped grant is confined to the session that minted it, so it may
// replay only inside THIS gate's workspace. The grant cwd must equal the gate
// workspace resolvedCwd before roots membership (or an exact request-cwd
// match) is considered. Before CL-6706, grantCwd === requestCwd short-circuited
// first, so a foreign grant stamped for /foreign replayed for any request with
// that same cwd even under a gate whose workspace is /proj — a cross-project
// replay. The predicate, the shared scoping predicate, and both live call
// sites (evaluateApprovals, isRequestCoveredByGrant) must all reject the foreign
// case and agree.
describe("foreign grant cwd matching request cwd under a different workspace is rejected (CL-6706)", () => {
  const workspace: GrantWorkspace = { resolvedCwd: "/proj", roots: ["/proj", "/proj/wt1"] };
  const noopRestricted = () => false;

  // Foreign grant: stamped for a different project's root.
  const foreignGrant: Approval = { tool: "run_shell", pattern: "npm test", cwd: "/foreign" };
  // Own grant: stamped for this gate's workspace root.
  const ownGrant: Approval = { tool: "run_shell", pattern: "npm test", cwd: "/proj" };

  test("cwdMatchesGrant: foreign grant cwd equals request cwd but differs from workspace → false", () => {
    // The pre-CL-6706 short-circuit would have returned true here.
    expect(cwdMatchesGrant("/foreign", "/foreign", workspace)).toBe(false);
  });

  test("cwdMatchesGrant: own grant matches its workspace, session root and worktree", () => {
    expect(cwdMatchesGrant("/proj", "/proj", workspace)).toBe(true); // session root
    expect(cwdMatchesGrant("/proj", "/proj/wt1", workspace)).toBe(true); // registered worktree
    expect(cwdMatchesGrant("/proj", "/other/wt1", workspace)).toBe(false); // outside project
  });

  test("grantScopeMatches agrees: foreign scope does not cover a coinciding request cwd", () => {
    expect(grantScopeMatches(foreignGrant, "run_shell", undefined, "/foreign", workspace)).toBe(
      false,
    );
  });

  test("both live call sites refuse a foreign grant replaying into /proj's workspace", async () => {
    // evaluateApprovals
    expect(
      await evaluateApprovals({
        tool: "run_shell",
        subject: "npm test",
        approvals: [foreignGrant],
        requestCwd: "/foreign",
        workspace,
      }),
    ).toBe(false);

    // isRequestCoveredByGrant (request cwd coincides with the foreign grant's cwd)
    const request: PermissionRequest = {
      tool: "run_shell",
      action: "Run",
      subject: "npm test",
      scopes: [],
      cwd: "/foreign",
    };
    expect(
      isRequestCoveredByGrant(request, foreignGrant, undefined, noopRestricted, workspace),
    ).toBe(false);
  });

  test("the same grant with its own workspace still replays the session root", async () => {
    expect(
      await evaluateApprovals({
        tool: "run_shell",
        subject: "npm test",
        approvals: [ownGrant],
        requestCwd: "/proj",
        workspace,
      }),
    ).toBe(true);
  });
});
