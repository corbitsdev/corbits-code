import { describe, expect, test } from "bun:test";
import { createPermissionGate } from "../../../src/permission/gate.js";
import { autoShellRuleForCall } from "../../../src/permission/auto-shell-policy.js";
import {
  stripCommentLines,
  splitChainedCommand,
  tokenize,
} from "../../../src/permission/command.js";
import { buildRequests } from "../../../src/permission/classify.js";
import type { RequestApproval } from "../../../src/permission/types.js";

const call = (command: string) => ({ id: "t", name: "run_shell", arguments: { command } });

function gateWith(onAsk: RequestApproval) {
  return createPermissionGate({
    approvals: [],
    requestApproval: onAsk,
    interactive: true,
    skipPermissions: false,
    cwd: process.cwd(),
  });
}

describe("comment normalization x exact full-command grants", () => {
  test("multi-segment grant minted with a comment replays without it", async () => {
    let prompts = 0;
    const gate = gateWith(async (req) => {
      prompts++;
      const exact = req.scopes.find((s) => s.id === "exact");
      return {
        allow: true,
        ...(exact !== undefined ? { persist: { ...exact, grant: "session" as const } } : {}),
      };
    });
    const withComment = "# build then test\ngit fetch origin && git rebase origin/main";
    expect((await gate.evaluate(call(withComment))).allowed).toBe(true);
    expect(prompts).toBe(1);
    const withoutComment = "git fetch origin && git rebase origin/main";
    expect((await gate.evaluate(call(withoutComment))).allowed).toBe(true);
    expect(prompts).toBe(1); // no re-prompt: comment-insensitive replay
  });

  test("comment lines do not count toward the real segment count", () => {
    const comments = Array.from({ length: 10 }, (_, i) => `# c${i}`).join("\n");
    const cmd = `${comments}\ngit fetch origin && git rebase origin/main`;
    const [req] = buildRequests(call(cmd));
    expect(req?.scopes.length).toBeGreaterThan(0);
  });

  test("a long real chain hidden after comments still gets an exact-command scope", () => {
    const cmd = Array.from({ length: 8 }, (_, i) => `cmd${i} run`).join(" && ");
    const [req] = buildRequests(call(cmd));
    expect(req?.scopes.length).toBe(1);
  });
});

describe("comment stripping cannot hide executable payload", () => {
  test("a payload line glued by backslash continuation is not stripped", () => {
    const cmd = "echo safe \\\nrm -rf /";
    expect(stripCommentLines(cmd)).toContain("rm -rf /");
  });

  test("a chained payload on a comment line still surfaces as a segment", () => {
    const segs = splitChainedCommand("# note && rm -rf /");
    expect(segs).toContain("rm -rf /");
  });

  test("substitution inside double quotes stays visible after stripping", () => {
    const cmd = '# why\ncat "$(cat /etc/passwd)"';
    const stripped = stripCommentLines(cmd);
    expect(tokenize(stripped)).toContain("/etc/passwd");
  });
});

describe("comment lines x env -S payload scanning", () => {
  test("leading comment does not defeat the env -S ask rule", () => {
    const cmd = "# run build\nenv -S 'FOO=bar make build'";
    const rule = autoShellRuleForCall(call(cmd));
    expect(rule?.name).toBe("env-assignment");
  });

  test("env -S payload with file mutation stays deny despite comments", () => {
    const cmd = "# innocuous\nenv -S \"FOO=bar sh -c 'echo x > out.txt'\"";
    const rule = autoShellRuleForCall(call(cmd));
    expect(rule?.effect).toBe("deny");
  });
});
