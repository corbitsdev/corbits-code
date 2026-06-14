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

test("PermissionModal shows reject, accept-once, broad-scope options, and exact-match grants", () => {
  const { lastFrame } = render(<PermissionModal request={request} onResolve={() => {}} />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Approval needed");
  expect(frame).toContain("npm test");
  expect(frame).toContain("Reject");
  expect(frame).toContain("Accept once");
  // Broad prefix scope options (3 and 4)
  expect(frame).toContain("npm *");
  expect(frame).toContain("Allow npm *");
  // Exact-command grant options are also shown
  expect(frame).toContain("Auto-accept this session");
  expect(frame).toContain("Auto-accept in this project");
  expect(frame).toContain("Auto-accept globally");
  expect(frame).toContain("Auto-accept for this provider/model");
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
  // 2 fixed + 2 broad + 4 exact = 8 options when a prefix scope exists
  expect(frame).toContain("1-8 select");
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

test("option 5 saves the exact command for session (first exact-match option)", async () => {
  let outcome: ApprovalOutcome | null = null;
  const { stdin } = render(<PermissionModal request={request} onResolve={(o) => { outcome = o; }} />);
  await tick();
  stdin.write("5");
  await tick();
  // Option 5 is "Auto-accept this session [npm test]"
  expect(outcome).toMatchObject({ allow: true, persist: { grant: "session", pattern: "npm test" } });
});

test("Escape rejects", async () => {
  let outcome: ApprovalOutcome | null = null;
  const { stdin } = render(<PermissionModal request={request} onResolve={(o) => { outcome = o; }} />);
  await tick();
  stdin.write("");
  await tick();
  expect(outcome).toEqual({ allow: false });
});
