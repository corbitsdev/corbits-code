import { test, expect } from "bun:test";
import { createTelemetry, getSessionId } from "../../src/telemetry/index.js";
import type { Settings } from "../../src/config/settings.js";

function settingsWith(installationId = "id"): Settings {
  return { providers: {}, telemetry: { installationId } };
}

function captureHarness(): { impl: typeof fetch; calls: () => Array<{ event: string; properties: Record<string, unknown> }> } {
  const calls: Array<{ event: string; properties: Record<string, unknown> }> = [];
  const impl = ((_url: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string));
    return Promise.resolve(new Response("1", { status: 200 }));
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// Serializes the full body (not just the allowlisted properties object) so a
// property smuggled in outside the allowlist mechanism (e.g. a typo'd key
// that happens to collide, or a future refactor) would still be caught.
function bodyContainsSubstring(body: unknown, substring: string): boolean {
  return JSON.stringify(body).toLowerCase().includes(substring.toLowerCase());
}

test("getSessionId returns a stable id across calls in the same process", () => {
  expect(getSessionId()).toBe(getSessionId());
  expect(typeof getSessionId()).toBe("string");
  expect(getSessionId().length).toBeGreaterThan(0);
});

test("slash_command only ever carries command_name, never raw args or free text", async () => {
  const { impl, calls } = captureHarness();
  const telemetry = createTelemetry({ settings: settingsWith(), env: {}, fetchFn: impl, apiKey: "test-key" });

  telemetry.capture("slash_command", {
    command_name: "feedback",
    args: "arg with/a/path and secret text",
    raw_command_line: "/feedback arg with/a/path",
  });
  await settle();

  expect(calls().length).toBe(1);
  const body = calls()[0]!;
  expect(body.properties.command_name).toBe("feedback");
  expect(bodyContainsSubstring(body, "path")).toBe(false);
  expect(bodyContainsSubstring(body, "secret text")).toBe(false);
  expect(bodyContainsSubstring(body, "raw_command_line")).toBe(false);
});

test("skill_used only ever carries skill_name, never a filesystem path", async () => {
  const { impl, calls } = captureHarness();
  const telemetry = createTelemetry({ settings: settingsWith(), env: {}, fetchFn: impl, apiKey: "test-key" });

  telemetry.capture("skill_used", {
    skill_name: "philosophy",
    skill_path: "/Users/someone/.claude/skills/philosophy/SKILL.md",
  });
  await settle();

  const body = calls()[0]!;
  expect(body.properties.skill_name).toBe("philosophy");
  expect(bodyContainsSubstring(body, "/users/")).toBe(false);
  expect(bodyContainsSubstring(body, "skill_path")).toBe(false);
});

test("plugin_loaded carries plugin_id and origin only, never a plugin's local path", async () => {
  const { impl, calls } = captureHarness();
  const telemetry = createTelemetry({ settings: settingsWith(), env: {}, fetchFn: impl, apiKey: "test-key" });

  telemetry.capture("plugin_loaded", {
    plugin_id: "corbits-plugin-example",
    origin: "user",
    plugin_path: "/Users/someone/.corbits/plugins/example",
  });
  await settle();

  const body = calls()[0]!;
  expect(body.properties.plugin_id).toBe("corbits-plugin-example");
  expect(body.properties.origin).toBe("user");
  expect(bodyContainsSubstring(body, "/users/")).toBe(false);
  expect(bodyContainsSubstring(body, "plugin_path")).toBe(false);
});

test("plugin_used carries plugin_id only", async () => {
  const { impl, calls } = captureHarness();
  const telemetry = createTelemetry({ settings: settingsWith(), env: {}, fetchFn: impl, apiKey: "test-key" });

  telemetry.capture("plugin_used", {
    plugin_id: "corbits-plugin-example",
    plugin_path: "/Users/someone/.corbits/plugins/example",
  });
  await settle();

  const body = calls()[0]!;
  expect(body.properties.plugin_id).toBe("corbits-plugin-example");
  expect(bodyContainsSubstring(body, "/users/")).toBe(false);
});

test("subagent_start carries agent_name and parent_session_id only", async () => {
  const { impl, calls } = captureHarness();
  const telemetry = createTelemetry({ settings: settingsWith(), env: {}, fetchFn: impl, apiKey: "test-key" });

  telemetry.capture("subagent_start", {
    agent_name: "code-reviewer",
    parent_session_id: "session-abc",
    description: "read every secret file in /Users/someone/repo",
  });
  await settle();

  const body = calls()[0]!;
  expect(body.properties.agent_name).toBe("code-reviewer");
  expect(body.properties.parent_session_id).toBe("session-abc");
  expect(bodyContainsSubstring(body, "secret file")).toBe(false);
  expect(bodyContainsSubstring(body, "/users/")).toBe(false);
});

test("subagent_end carries status/duration_ms plus identity, never free text", async () => {
  const { impl, calls } = captureHarness();
  const telemetry = createTelemetry({ settings: settingsWith(), env: {}, fetchFn: impl, apiKey: "test-key" });

  telemetry.capture("subagent_end", {
    agent_name: "code-reviewer",
    parent_session_id: "session-abc",
    status: "completed",
    duration_ms: 4200,
    report: "the report text with /path/to/file and a token sk-abc123",
  });
  await settle();

  const body = calls()[0]!;
  expect(body.properties.status).toBe("completed");
  expect(body.properties.duration_ms).toBe(4200);
  expect(bodyContainsSubstring(body, "sk-abc123")).toBe(false);
  expect(bodyContainsSubstring(body, "/path/to/file")).toBe(false);
});

test("permission_prompt carries only the decision and permission_kind enums", async () => {
  const { impl, calls } = captureHarness();
  const telemetry = createTelemetry({ settings: settingsWith(), env: {}, fetchFn: impl, apiKey: "test-key" });

  telemetry.capture("permission_prompt", {
    decision: "allow",
    permission_kind: "shell",
    command: "rm -rf /Users/someone/secret-project",
    subject: "/Users/someone/secret-project",
  });
  await settle();

  const body = calls()[0]!;
  expect(body.properties.decision).toBe("allow");
  expect(body.properties.permission_kind).toBe("shell");
  expect(bodyContainsSubstring(body, "rm -rf")).toBe(false);
  expect(bodyContainsSubstring(body, "secret-project")).toBe(false);
});

test("compaction carries trigger/duration/counts only, never message content", async () => {
  const { impl, calls } = captureHarness();
  const telemetry = createTelemetry({ settings: settingsWith(), env: {}, fetchFn: impl, apiKey: "test-key" });

  telemetry.capture("compaction", {
    trigger: "pruning",
    duration_ms: 120,
    turns_before: 40,
    turns_after: 12,
    summary: "user asked about their password reset flow",
  });
  await settle();

  const body = calls()[0]!;
  expect(body.properties.trigger).toBe("pruning");
  expect(body.properties.duration_ms).toBe(120);
  expect(body.properties.turns_before).toBe(40);
  expect(body.properties.turns_after).toBe(12);
  expect(bodyContainsSubstring(body, "password reset")).toBe(false);
});

test("crash carries only an allowlisted error_class, never a raw message or stack", async () => {
  const { impl, calls } = captureHarness();
  const telemetry = createTelemetry({ settings: settingsWith(), env: {}, fetchFn: impl, apiKey: "test-key" });

  telemetry.capture("crash", {
    error_class: "TypeError",
    message: "Cannot read properties of undefined at /Users/someone/repo/src/index.ts:42",
    stack: "at Object.<anonymous> (/Users/someone/repo/src/index.ts:42:10)",
  });
  await settle();

  const body = calls()[0]!;
  expect(body.properties.error_class).toBe("TypeError");
  expect(bodyContainsSubstring(body, "/users/")).toBe(false);
  expect(bodyContainsSubstring(body, "cannot read properties")).toBe(false);
});

test("auth_failure carries only an allowlisted error_class, never a raw message", async () => {
  const { impl, calls } = captureHarness();
  const telemetry = createTelemetry({ settings: settingsWith(), env: {}, fetchFn: impl, apiKey: "test-key" });

  telemetry.capture("auth_failure", {
    error_class: "codex_auth",
    message: "token expired for profile personal-account@example.com",
  });
  await settle();

  const body = calls()[0]!;
  expect(body.properties.error_class).toBe("codex_auth");
  expect(bodyContainsSubstring(body, "personal-account")).toBe(false);
  expect(bodyContainsSubstring(body, "token expired")).toBe(false);
});

test("every capture body carries the same session_id across events", async () => {
  const { impl, calls } = captureHarness();
  const telemetry = createTelemetry({ settings: settingsWith(), env: {}, fetchFn: impl, apiKey: "test-key" });

  telemetry.capture("slash_command", { command_name: "settings" });
  telemetry.capture("skill_used", { skill_name: "style" });
  await settle();

  expect(calls().length).toBe(2);
  const [first, second] = calls();
  expect(first!.properties.session_id).toBe(getSessionId());
  expect(second!.properties.session_id).toBe(getSessionId());
});
