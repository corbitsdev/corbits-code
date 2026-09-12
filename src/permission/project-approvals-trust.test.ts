import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSessionId } from "../session/index.js";
import { loadSeededApprovals } from "../session/runtime-assembly.js";
import { runWithSubAgentIdentity } from "../subagent/identity-context.js";
import { trustProjectGrants } from "../trust/project-trust.js";
import { createPermissionGate } from "./gate.js";
import type { Approval, PermissionRequest } from "./types.js";
import {
  formatPendingProjectApprovals,
  loadPendingProjectApprovals,
  loadProjectApprovals,
  saveProjectApproval,
} from "./store.js";

const PLANTED = [
  { tool: "run_shell", pattern: "git push --force origin main" },
  { tool: "write_file", pattern: "*.ts" },
] as const;

async function plantProjectApprovals(
  cwd: string,
  entries: readonly unknown[] = PLANTED,
): Promise<void> {
  const dir = join(cwd, ".corbits");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "permissions.json"),
    JSON.stringify({ version: 1, approvals: entries }),
  );
}

async function driveGate(cwd: string, sessionId: string, home: string) {
  const asked: string[] = [];
  const gate = createPermissionGate({
    cwd,
    interactive: true,
    skipPermissions: false,
    reactorGated: false,
    requestApproval: async (request: PermissionRequest) => {
      asked.push(`${request.tool}:${request.subject}`);
      return { allow: true };
    },
    approvals: await loadSeededApprovals(cwd, sessionId, home),
  });
  return { gate, asked };
}

const PUSH = {
  id: "push",
  name: "run_shell",
  arguments: { command: "git push --force origin main" },
} as const;

const WRITE = {
  id: "write",
  name: "write_file",
  arguments: { path: "notes.ts" },
} as const;

describe("CL-7782: project approvals require grant trust", () => {
  test("untrusted directory contributes zero project approvals through the real gate", async () => {
    const base = await mkdtemp(join(tmpdir(), "cl-7782-untrusted-"));
    const home = join(base, "home");
    const cwd = join(base, "repo");
    await plantProjectApprovals(cwd);
    const sessionId = generateSessionId();

    expect(await loadProjectApprovals(cwd, home)).toEqual([]);
    const seeded = await loadSeededApprovals(cwd, sessionId, home);
    for (const entry of PLANTED) {
      expect(
        seeded.some(
          (approval) =>
            approval.tool === entry.tool && approval.pattern === entry.pattern,
        ),
      ).toBe(false);
    }

    const { gate, asked } = await driveGate(cwd, sessionId, home);
    expect((await gate.evaluate({ ...PUSH })).allowed).toBe(true);
    expect((await gate.evaluate({ ...WRITE })).allowed).toBe(true);
    expect(asked).toEqual([
      "run_shell:git push --force origin main",
      "write_file:notes.ts",
    ]);
  });

  test("trusted and confirmed directory grants apply without asking", async () => {
    const base = await mkdtemp(join(tmpdir(), "cl-7782-trusted-"));
    const home = join(base, "home");
    const cwd = join(base, "repo");
    await plantProjectApprovals(cwd);
    await trustProjectGrants(cwd, [...PLANTED], home);
    const sessionId = generateSessionId();

    expect(await loadProjectApprovals(cwd, home)).toHaveLength(2);

    const { gate, asked } = await driveGate(cwd, sessionId, home);
    expect((await gate.evaluate({ ...PUSH })).allowed).toBe(true);
    expect((await gate.evaluate({ ...WRITE })).allowed).toBe(true);
    expect(asked).toEqual([]);
  });

  test("trust is keyed by realpath: a symlinked checkout cannot inherit or confer", async () => {
    const base = await mkdtemp(join(tmpdir(), "cl-7782-link-"));
    const home = join(base, "home");
    const target = join(base, "real-repo");
    await plantProjectApprovals(target);
    const link = join(base, "linked-repo");
    await symlink(target, link);
    expect(await realpath(link)).toBe(await realpath(target));

    await trustProjectGrants(link, [...PLANTED], home);
    expect(await loadProjectApprovals(target, home)).toHaveLength(2);

    const twin = join(base, "twin-repo");
    await plantProjectApprovals(twin);
    expect(await loadProjectApprovals(twin, home)).toEqual([]);
  });

  test("first encounter surfaces the would-be grants instead of dropping them silently", async () => {
    const base = await mkdtemp(join(tmpdir(), "cl-7782-pending-"));
    const home = join(base, "home");
    const cwd = join(base, "repo");
    await plantProjectApprovals(cwd);

    const pending = await loadPendingProjectApprovals(cwd, home);
    expect(pending).toHaveLength(2);
    const notice = formatPendingProjectApprovals(pending);
    for (const entry of PLANTED) {
      expect(notice).toContain(entry.pattern);
    }

    await trustProjectGrants(cwd, [...PLANTED], home);
    expect(await loadPendingProjectApprovals(cwd, home)).toEqual([]);
    expect(formatPendingProjectApprovals([])).toBe("");
  });

  test("hand-removing an entry revokes its confirmation: a byte-identical replant re-surfaces", async () => {
    const base = await mkdtemp(join(tmpdir(), "cl-7782-replant-"));
    const home = join(base, "home");
    const cwd = join(base, "repo");
    await plantProjectApprovals(cwd);
    await trustProjectGrants(cwd, [...PLANTED], home);
    expect(await loadProjectApprovals(cwd, home)).toHaveLength(2);

    // Hand-edit the first entry out of the file without removeProjectApproval.
    await plantProjectApprovals(cwd, [PLANTED[1]]);
    expect(await loadProjectApprovals(cwd, home)).toEqual([{ ...PLANTED[1] }]);
    expect(await loadPendingProjectApprovals(cwd, home)).toEqual([]);

    // Replant the identical bytes: the removed entry surfaces, not applies.
    await plantProjectApprovals(cwd);
    expect(await loadProjectApprovals(cwd, home)).toEqual([{ ...PLANTED[1] }]);
    expect(await loadPendingProjectApprovals(cwd, home)).toEqual([
      { ...PLANTED[0] },
    ]);
  });

  test("a gate-minted project grant ({tool, pattern, cwd}) survives save → reload and still applies", async () => {
    const base = await mkdtemp(join(tmpdir(), "cl-7782-cwd-"));
    const home = join(base, "home");
    const cwd = join(base, "repo");

    // Mint through the real gate so the entry has the production shape.
    const minted: Approval[] = [];
    const mintGate = createPermissionGate({
      cwd,
      interactive: true,
      skipPermissions: false,
      reactorGated: false,
      requestApproval: async () => ({
        allow: true,
        persist: {
          id: "exact",
          label: "Always allow",
          pattern: "npm test",
          grant: "project",
        },
      }),
      persist: (approval, scope) => {
        expect(scope).toBe("project");
        minted.push(approval);
      },
      approvals: await loadSeededApprovals(cwd, generateSessionId(), home),
    });
    const NPM_TEST = {
      id: "npm-test",
      name: "run_shell",
      arguments: { command: "npm test" },
    } as const;
    expect((await mintGate.evaluate({ ...NPM_TEST })).allowed).toBe(true);
    expect(minted).toEqual([{ tool: "run_shell", pattern: "npm test", cwd }]);

    // Production persist path, then reload: the cwd must round-trip, not strip.
    const grant = minted[0];
    if (grant === undefined) throw new Error("gate minted no project grant");
    await saveProjectApproval(cwd, grant, home);
    const reloaded = await loadProjectApprovals(cwd, home);
    expect(reloaded).toEqual(minted);

    // The reloaded entry still applies: a fresh seeded gate asks nothing.
    const { gate, asked } = await driveGate(cwd, generateSessionId(), home);
    expect((await gate.evaluate({ ...NPM_TEST })).allowed).toBe(true);
    expect(asked).toEqual([]);
  });

  test("confirming a planted entry through the pending flow converges the file to the minted shape", async () => {
    const base = await mkdtemp(join(tmpdir(), "cl-7782-converge-"));
    const home = join(base, "home");
    const cwd = join(base, "repo");
    await plantProjectApprovals(cwd, [
      { tool: "run_shell", pattern: "npm test" },
    ]);
    expect(await loadPendingProjectApprovals(cwd, home)).toEqual([
      { tool: "run_shell", pattern: "npm test" },
    ]);

    // What the gate persist does when the operator confirms the pending entry
    // with a project-scope persist: mint {tool, pattern, cwd} and write it.
    await saveProjectApproval(
      cwd,
      { tool: "run_shell", pattern: "npm test", cwd },
      home,
    );

    // The planted twin is displaced by the minted shape — nothing lingers as
    // pending, and the grant applies without asking.
    expect(await loadProjectApprovals(cwd, home)).toEqual([
      { tool: "run_shell", pattern: "npm test", cwd },
    ]);
    expect(await loadPendingProjectApprovals(cwd, home)).toEqual([]);

    const { gate, asked } = await driveGate(cwd, generateSessionId(), home);
    expect(
      (
        await gate.evaluate({
          id: "npm-test",
          name: "run_shell",
          arguments: { command: "npm test" },
        })
      ).allowed,
    ).toBe(true);
    expect(asked).toEqual([]);
  });

  test("stripping cwd from a confirmed entry re-surfaces as pending and never cross-repo auto-allows", async () => {
    const base = await mkdtemp(join(tmpdir(), "cl-7782-cwd-strip-"));
    const home = join(base, "home");
    const cwd = join(base, "repo");
    const other = join(base, "other");
    await mkdir(other, { recursive: true });

    // Operator confirms {tool, pattern, cwd} through the production path.
    await saveProjectApproval(
      cwd,
      { tool: "run_shell", pattern: "npm test", cwd },
      home,
    );
    expect(await loadProjectApprovals(cwd, home)).toEqual([
      { tool: "run_shell", pattern: "npm test", cwd },
    ]);

    // Hand-edit drops the cwd key: byte-identical to a planted entry, but the
    // confirmation was bound to the cwd-bearing shape, so trust must not
    // follow the stripped bytes.
    await plantProjectApprovals(cwd, [
      { tool: "run_shell", pattern: "npm test" },
    ]);
    expect(await loadProjectApprovals(cwd, home)).toEqual([]);
    expect(await loadPendingProjectApprovals(cwd, home)).toEqual([
      { tool: "run_shell", pattern: "npm test" },
    ]);

    // The real gate, seeded after the strip: neither the same-repo request
    // nor a cross-repo request (different request cwd) auto-allows.
    const asked: string[] = [];
    const gate = createPermissionGate({
      cwd,
      interactive: true,
      skipPermissions: false,
      reactorGated: false,
      requestApproval: async (request: PermissionRequest) => {
        asked.push(`${request.tool}:${request.subject}`);
        return { allow: false };
      },
      approvals: await loadSeededApprovals(cwd, generateSessionId(), home),
    });
    const NPM_TEST = {
      id: "npm-test",
      name: "run_shell",
      arguments: { command: "npm test" },
    } as const;
    expect((await gate.evaluate({ ...NPM_TEST })).allowed).toBe(false);
    expect(
      (
        await runWithSubAgentIdentity(
          { description: "other", cwd: other },
          () => gate.evaluate({ ...NPM_TEST }),
        )
      ).allowed,
    ).toBe(false);
    expect(asked).toEqual(["run_shell:npm test", "run_shell:npm test"]);
  });
});
