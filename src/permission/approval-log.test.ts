import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { APPROVAL_LOG_FILE, NOOP_APPROVAL_LOG, createApprovalLog } from "./approval-log.js";
import { createPermissionGate } from "./gate.js";
import type { ToolCall } from "@intx/types/runtime";

function readRecords(dir: string): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = readFileSync(join(dir, APPROVAL_LOG_FILE), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("createApprovalLog", () => {
  test("NOOP never throws and never writes", () => {
    const ask = NOOP_APPROVAL_LOG.ask({ tool: "run_shell", mode: "interactive" });
    expect(() => {
      ask.markDisplayed();
      ask.settle("allow-once");
    }).not.toThrow();
  });

  test("records queued/displayed/settled timestamps and duration for one ask", async () => {
    const dir = mkdtempSync(join(tmpdir(), "approval-log-"));
    let now = new Date("2026-01-01T00:00:00.000Z").getTime();
    const clock = () => new Date(now);
    const log = createApprovalLog(dir, clock);

    const ask = log.ask({ tool: "run_shell", mode: "interactive", segments: 3 });
    now += 50; // sat behind another overlay
    ask.markDisplayed();
    now += 100; // operator decides
    ask.settle("allow-with-scope");

    // Appends are fire-and-forget; give the microtask queue a turn to flush.
    await new Promise((r) => setTimeout(r, 10));

    const [record] = readRecords(dir);
    expect(record).toBeDefined();
    expect(record!.tool).toBe("run_shell");
    expect(record!.mode).toBe("interactive");
    expect(record!.segments).toBe(3);
    expect(record!.outcome).toBe("allow-with-scope");
    expect(record!.durationMs).toBe(150);
    expect(record!.displayDelayMs).toBe(50);
    // No command text, path, or subject of any kind is ever recorded.
    expect(Object.keys(record!)).not.toContain("subject");
    expect(Object.keys(record!)).not.toContain("command");
    expect(Object.keys(record!)).not.toContain("arguments");
  });

  test("settle is idempotent — a second call does not append twice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "approval-log-"));
    const log = createApprovalLog(dir);
    const ask = log.ask({ tool: "write_file", mode: "auto" });
    ask.settle("auto-allow");
    ask.settle("deny");
    await new Promise((r) => setTimeout(r, 10));
    expect(readRecords(dir)).toHaveLength(1);
  });
});

const shellCall = (command: string): ToolCall => ({
  id: "c",
  name: "run_shell",
  arguments: { command },
});

describe("approval-log wiring through the permission gate", () => {
  test("logs an auto-deny for a file-mutation shell command in auto mode, with no command text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "approval-log-gate-"));
    const cwd = mkdtempSync(join(tmpdir(), "gate-cwd-"));
    const gate = createPermissionGate({
      approvals: [],
      interactive: false,
      skipPermissions: false,
      auto: true,
      cwd,
      approvalLog: createApprovalLog(dir),
    });
    const verdict = await gate.evaluate(shellCall("echo hunter2 > /tmp/leaked-secret-file.txt"));
    expect(verdict.allowed).toBe(false);

    await new Promise((r) => setTimeout(r, 10));
    const [record] = readRecords(dir);
    expect(record).toBeDefined();
    expect(record!.mode).toBe("auto");
    expect(record!.outcome).toBe("auto-deny");
    expect(record!.rule).toBe("file-mutation");
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("leaked-secret-file");
  });

  test("logs an interactive allow-once with no command text in the record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "approval-log-gate-"));
    const cwd = mkdtempSync(join(tmpdir(), "gate-cwd-"));
    const gate = createPermissionGate({
      approvals: [],
      interactive: true,
      skipPermissions: false,
      cwd,
      approvalLog: createApprovalLog(dir),
      requestApproval: async (request) => {
        request.markDisplayed?.();
        return { allow: true };
      },
    });
    const verdict = await gate.evaluate(shellCall("curl https://example.com/super-secret-token"));
    expect(verdict.allowed).toBe(true);

    await new Promise((r) => setTimeout(r, 10));
    const [record] = readRecords(dir);
    expect(record).toBeDefined();
    expect(record!.mode).toBe("interactive");
    expect(record!.outcome).toBe("allow-once");
    expect(typeof record!.displayDelayMs).toBe("number");
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("curl");
  });

  test("logs deny with non-interactive rule when no operator is attached", async () => {
    const dir = mkdtempSync(join(tmpdir(), "approval-log-gate-"));
    const cwd = mkdtempSync(join(tmpdir(), "gate-cwd-"));
    const gate = createPermissionGate({
      approvals: [],
      interactive: false,
      skipPermissions: false,
      cwd,
      approvalLog: createApprovalLog(dir),
    });
    const verdict = await gate.evaluate(shellCall("curl https://example.com"));
    expect(verdict.allowed).toBe(false);

    await new Promise((r) => setTimeout(r, 10));
    const [record] = readRecords(dir);
    expect(record).toBeDefined();
    expect(record!.outcome).toBe("deny");
    expect(record!.rule).toBe("non-interactive");
  });

  // A sub-agent's `spawn_agent` dispatch `description` is model-authored free text
  // — it is only ever trimmed, never constrained to a
  // closed set. A prior version of this log carried it verbatim as
  // `agentLabel`. It must never reach the record: unlike `rule` (a fixed
  // taxonomy) and `segments` (a count), nothing stops a model from quoting a
  // path, a token, or secret content it just read into its own summary of the
  // sub-task.
  test("never logs a sub-agent's free-text dispatch description, even with a secret embedded", async () => {
    const { runWithSubAgentIdentity } = await import("../subagent/identity-context.js");
    const dir = mkdtempSync(join(tmpdir(), "approval-log-gate-"));
    const cwd = mkdtempSync(join(tmpdir(), "gate-cwd-"));
    const gate = createPermissionGate({
      approvals: [],
      interactive: true,
      skipPermissions: false,
      cwd,
      approvalLog: createApprovalLog(dir),
      requestApproval: async (request) => {
        request.markDisplayed?.();
        return { allow: true };
      },
    });
    const secret = "sk-live-9f2c7a1e4b6d8f0a";
    const verdict = await runWithSubAgentIdentity(
      { description: `fetch the token ${secret} from the vault and cache it`, cwd },
      () => gate.evaluate(shellCall("curl https://example.com")),
    );
    expect(verdict.allowed).toBe(true);

    await new Promise((r) => setTimeout(r, 10));
    const [record] = readRecords(dir);
    expect(record).toBeDefined();
    expect(Object.keys(record!)).not.toContain("agentLabel");
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("vault");
  });
});

describe("approval-log record size cap", () => {
  test("drops a record that would exceed the hard size cap rather than truncate it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "approval-log-cap-"));
    const log = createApprovalLog(dir);
    // `rule` is a real, typed field — simulate a future regression where some
    // caller stuffs unbounded text into it instead of the closed taxonomy.
    // The cap must catch that even though the type system would not.
    const ask = log.ask({
      tool: "run_shell",
      mode: "interactive",
      rule: "x".repeat(10_000),
    });
    ask.settle("allow-once");
    await new Promise((r) => setTimeout(r, 10));
    expect(readRecords(dir)).toHaveLength(0);
  });
});
