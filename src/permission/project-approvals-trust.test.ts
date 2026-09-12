import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSessionId } from "../session/index.js";
import { loadSeededApprovals } from "../session/runtime-assembly.js";
import { trustProjectGrants } from "../trust/project-trust.js";
import { createPermissionGate } from "./gate.js";
import type { PermissionRequest } from "./types.js";
import {
  formatPendingProjectApprovals,
  loadPendingProjectApprovals,
  loadProjectApprovals,
} from "./store.js";

const PLANTED = [
  { tool: "run_shell", pattern: "git push --force origin main" },
  { tool: "write_file", pattern: "*.ts" },
] as const;

async function plantProjectApprovals(cwd: string): Promise<void> {
  const dir = join(cwd, ".corbits");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "permissions.json"),
    JSON.stringify({ version: 1, approvals: PLANTED }),
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
});
