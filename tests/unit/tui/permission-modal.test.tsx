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

test("PermissionModal shows reject, accept-once, and the four scoped grants", () => {
  const { lastFrame } = render(<PermissionModal request={request} onResolve={() => {}} />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Approval needed");
  expect(frame).toContain("npm test");
  expect(frame).toContain("Reject");
  expect(frame).toContain("Accept once");
  expect(frame).toContain("Auto-accept this session");
  expect(frame).toContain("Auto-accept in this project");
  expect(frame).toContain("Auto-accept globally");
  expect(frame).toContain("Auto-accept for this provider/model");
  expect(frame).toContain("npm *");
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

test("selecting the session grant persists the broadest pattern with that scope", async () => {
  let outcome: ApprovalOutcome | null = null;
  const { stdin } = render(<PermissionModal request={request} onResolve={(o) => { outcome = o; }} />);
  await tick();
  stdin.write("3");
  await tick();
  expect(outcome).toMatchObject({ allow: true, persist: { grant: "session", pattern: "npm *" } });
});

test("'5' persists a global-scoped grant with the broadest pattern", async () => {
  let outcome: ApprovalOutcome | null = null;
  const { stdin } = render(<PermissionModal request={request} onResolve={(o) => { outcome = o; }} />);
  await tick();
  stdin.write("5");
  await tick();
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
