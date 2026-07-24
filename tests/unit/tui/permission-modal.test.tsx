import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { PermissionModal } from "../../../src/tui/components/permission-modal.js";
import type { ApprovalOutcome, PermissionRequest } from "../../../src/permission/types.js";

const request: PermissionRequest = {
  tool: "run_shell",
  action: "Run shell command",
  subject: "npm test",
  scopes: [
    { id: "prefix-1", label: "Always allow npm *", pattern: "npm *" },
    { id: "exact", label: "Always allow this exact command", pattern: "npm test" },
  ],
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test("PermissionModal shows reject, accept-once, and broad-scope options", () => {
  const { lastFrame } = render(<PermissionModal request={request} onResolve={() => {}} />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Approval needed");
  expect(frame).toContain("npm test");
  expect(frame).toContain("Reject");
  expect(frame).toContain("Accept once");
  // Broad prefix scope options (3, 4, 5)
  expect(frame).toContain("npm *");
  expect(frame).toContain("Allow npm *");
  // No exact-command auto-accept labels when prefix scope is present
  expect(frame).not.toContain("Auto-accept this session");
  expect(frame).not.toContain("Auto-accept for this provider/model");
});

test("multiplexer commands show the broad wildcard as explicit options", async () => {
  const multiplexer: PermissionRequest = {
    tool: "run_shell",
    action: "Run shell command",
    subject: "bun run typecheck",
    scopes: [
      { id: "prefix", label: "Always allow bun run *", pattern: "bun run *" },
      { id: "exact", label: "Always allow this exact command", pattern: "bun run typecheck" },
    ],
  };
  let outcome: ApprovalOutcome | null = null;
  const { lastFrame, stdin } = render(<PermissionModal request={multiplexer} onResolve={(o) => { outcome = o; }} />);
  await tick();
  // The broad scope is now visible
  expect(lastFrame() ?? "").toContain("bun run *");
  // Option 4 is "Allow bun run * · persisted per repo"
  stdin.write("4");
  await tick();
  expect(outcome).toMatchObject({ allow: true, persist: { grant: "project", pattern: "bun run *" } });
});

test("footer reflects the real option count and offers Ctrl+O to expand", () => {
  const { lastFrame } = render(<PermissionModal request={request} onResolve={() => {}} />);
  const frame = lastFrame() ?? "";
  // 2 fixed + 3 broad (session/project/global) = 5 options when a prefix scope exists
  expect(frame).toContain("1-5 select");
  expect(frame).toContain("Ctrl+O expand");
});

test("PermissionModal shows web tool argument details", () => {
  const webRequest: PermissionRequest = {
    tool: "web_search",
    action: "Run web_search",
    subject: "web_search",
    arguments: { query: "hono.dev web framework" },
    scopes: [{ id: "tool", label: "Always allow web_search", pattern: "web_search" }],
  };

  const { lastFrame } = render(<PermissionModal request={webRequest} onResolve={() => {}} />);
  const frame = lastFrame() ?? "";

  expect(frame).toContain("Web Search");
  expect(frame).toContain("query: hono.dev web framework");
  expect(frame).not.toContain("Run web_search: web_search");
});

test("Enter defaults to reject (the first, safe option)", async () => {
  let outcome: ApprovalOutcome | null = null;
  const { stdin } = render(<PermissionModal request={request} onResolve={(o) => { outcome = o; }} />);
  await tick();
  stdin.write("\r");
  await tick();
  expect(outcome).toEqual({ allow: false });
});

test("Ctrl+Up leaves the safe rejection selected for transcript scrolling", async () => {
  let outcome: ApprovalOutcome | null = null;
  const { stdin } = render(<PermissionModal request={request} onResolve={(next) => { outcome = next; }} />);
  await tick();
  stdin.write("\x1B[1;5A");
  await tick();
  stdin.write("\r");
  await tick();
  expect(outcome).toEqual({ allow: false });
});

test("'2' accepts once without persisting", async () => {
  let outcome: ApprovalOutcome | null = null;
  const { stdin } = render(<PermissionModal request={request} onResolve={(o) => { outcome = o; }} />);
  await tick();
  stdin.write("2");
  await tick();
  expect(outcome).toEqual({ allow: true });
});

test("option 3 saves the broad prefix scope for session", async () => {
  let outcome: ApprovalOutcome | null = null;
  const { stdin } = render(<PermissionModal request={request} onResolve={(o) => { outcome = o; }} />);
  await tick();
  stdin.write("3");
  await tick();
  // Option 3 is "Allow npm * · this session"
  expect(outcome).toMatchObject({ allow: true, persist: { grant: "session", pattern: "npm *" } });
});

test("option 5 saves the broad prefix scope globally", async () => {
  let outcome: ApprovalOutcome | null = null;
  const { stdin } = render(<PermissionModal request={request} onResolve={(o) => { outcome = o; }} />);
  await tick();
  stdin.write("5");
  await tick();
  // Option 5 is "Allow npm * · all projects"
  expect(outcome).toMatchObject({ allow: true, persist: { grant: "global", pattern: "npm *" } });
});

test("Escape rejects", async () => {
  let outcome: ApprovalOutcome | null = null;
  const { stdin } = render(<PermissionModal request={request} onResolve={(o) => { outcome = o; }} />);
  await tick();
  stdin.write("");
  await tick();
  expect(outcome).toEqual({ allow: false });
});
