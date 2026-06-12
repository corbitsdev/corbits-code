import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { PermissionsManager } from "../../../src/tui/components/permissions-manager.js";
import type { ScopedApproval } from "../../../src/permission/admin.js";

const entries: ScopedApproval[] = [
  { scope: "session", tool: "run_shell", pattern: "curl *" },
  { scope: "project", tool: "write_file", pattern: "src/*" },
  { scope: "provider-model", tool: "run_shell", pattern: "npm *", providerModel: "openai:gpt-5" },
];

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test("groups remembered approvals by scope", () => {
  const { lastFrame } = render(
    <PermissionsManager entries={entries} onRevoke={() => {}} onClose={() => {}} />,
  );
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Permissions");
  expect(frame).toContain("This session");
  expect(frame).toContain("This project");
  expect(frame).toContain("Provider / model");
  expect(frame).toContain("curl *");
  expect(frame).toContain("openai:gpt-5");
});

test("shows an empty state when there are no approvals", () => {
  const { lastFrame } = render(
    <PermissionsManager entries={[]} onRevoke={() => {}} onClose={() => {}} />,
  );
  expect(lastFrame() ?? "").toContain("No remembered approvals");
});

test("'d' revokes the selected entry", async () => {
  let revoked: ScopedApproval | null = null;
  const { stdin } = render(
    <PermissionsManager entries={entries} onRevoke={(e) => { revoked = e; }} onClose={() => {}} />,
  );
  await tick();
  stdin.write("d");
  await tick();
  expect(revoked).toEqual(entries[0]);
});

test("arrowing down then revoking targets the next entry", async () => {
  let revoked: ScopedApproval | null = null;
  const { stdin } = render(
    <PermissionsManager entries={entries} onRevoke={(e) => { revoked = e; }} onClose={() => {}} />,
  );
  await tick();
  stdin.write("[B");
  await tick();
  stdin.write("d");
  await tick();
  expect(revoked).toEqual(entries[1]);
});

test("Escape closes", async () => {
  let closed = false;
  const { stdin } = render(
    <PermissionsManager entries={entries} onRevoke={() => {}} onClose={() => { closed = true; }} />,
  );
  await tick();
  stdin.write("");
  await tick();
  expect(closed).toBe(true);
});
