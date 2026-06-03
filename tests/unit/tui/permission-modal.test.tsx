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

test("PermissionModal shows allow once, one choice per scope, and reject", () => {
  const { lastFrame } = render(<PermissionModal request={request} onResolve={() => {}} />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Approval needed");
  expect(frame).toContain("npm test");
  expect(frame).toContain("Allow Once");
  // Each persistable scope is surfaced as its own labelled choice rather than a
  // single generic "Allow Always" that hides which scope is being granted.
  expect(frame).toContain("Always allow npm *");
  expect(frame).toContain("Always allow this exact command");
  expect(frame).toContain("Reject");
});

test("Enter on the first choice allows once without persisting", async () => {
  let outcome: ApprovalOutcome | null = null;
  const { stdin } = render(<PermissionModal request={request} onResolve={(o) => { outcome = o; }} />);
  await tick();
  stdin.write("\r");
  await tick();
  expect(outcome).toEqual({ allow: true });
});

test("arrowing to a scope and selecting it persists that scope", async () => {
  let outcome: ApprovalOutcome | null = null;
  const { stdin } = render(<PermissionModal request={request} onResolve={(o) => { outcome = o; }} />);
  await tick();
  stdin.write("[B"); // down → first scope
  await tick();
  stdin.write("\r");
  await tick();
  expect(outcome).toEqual({ allow: true, persist: request.scopes[0] });
});

test("Escape rejects", async () => {
  let outcome: ApprovalOutcome | null = null;
  const { stdin } = render(<PermissionModal request={request} onResolve={(o) => { outcome = o; }} />);
  await tick();
  stdin.write("");
  await tick();
  expect(outcome).toEqual({ allow: false });
});
