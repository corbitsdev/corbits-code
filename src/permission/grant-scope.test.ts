import { describe, test, expect } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";
import type { Approval, PermissionRequest } from "./types.js";
import { evaluateApprovals, grantScopeMatches, type GrantWorkspace } from "./authz-grants.js";
import { createPermissionGate, isRequestCoveredByGrant } from "./gate.js";

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

// Grant minting now decomposes a multi-segment exact-chain scope into one
// grant per real segment (see mintGrant in gate.ts) rather than persisting a
// single whole-string pattern, so a grant scoped to the full chain string is
// legacy shape and no longer the replay path — per-segment grants are (see
// permission.test.ts). This confirms a grant scoped to a mismatched cwd or
// provider model still never replays, consistent with grantScopeMatches
// everywhere else.
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
