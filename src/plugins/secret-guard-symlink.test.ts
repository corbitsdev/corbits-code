import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPosixTools } from "@intx/tools-posix";
import { createPermissionGate } from "../permission/gate.js";
import { buildCorePosixToolPlugins } from "../agent/posix-tool-plugins.js";
import { createCodexReadRawFile } from "../agent/codex-read-raw-file.js";

/**
 * CL-6971: under skip-permissions (yolo), pathEscape absolutizes outside paths
 * without realpath'ing, so an innocuous symlink name defeats the secret-guard
 * denylist. Secret guard is a floor — always realpath before isSensitivePath,
 * yolo or not. Covers both shapes: file symlink → secret, and dir symlink →
 * outside secret dir (where the lexical path no longer contains the sensitive
 * segment).
 */

async function withFixture<T>(
  run: (paths: {
    cwd: string;
    outsideEnv: string;
    awsDir: string;
    fileLink: string;
    dirLink: string;
  }) => Promise<T>,
): Promise<T> {
  const parent = await mkdtemp(join(tmpdir(), "cl6971-secret-symlink-"));
  const cwd = join(parent, "ws");
  const outside = join(parent, "outside");
  const awsDir = join(parent, ".aws");
  await mkdir(cwd);
  await mkdir(outside);
  await mkdir(awsDir);
  const outsideEnv = join(outside, ".env");
  await writeFile(outsideEnv, "SECRET=outside-env\n");
  await writeFile(join(awsDir, "credentials"), "aws_secret_access_key=LEAKED\n");
  // Shape 1: file symlink with an innocuous name → outside .env
  const fileLink = join(cwd, "config.txt");
  await symlink(outsideEnv, fileLink);
  // Shape 2: dir symlink → ~/.aws-shaped dir; lexical path is cache/credentials
  // (no ".aws/" segment) so basename-only matching is not enough.
  const dirLink = join(cwd, "cache");
  await symlink(awsDir, dirLink);
  try {
    return await run({ cwd, outsideEnv, awsDir, fileLink, dirLink });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function runner(cwd: string, skipPermissions: boolean) {
  const gate = createPermissionGate({
    approvals: [],
    interactive: false,
    skipPermissions,
    auto: false,
    cwd,
  });
  return {
    gate,
    tools: createPosixTools({
      cwd,
      plugins: buildCorePosixToolPlugins({ cwd, permissionGate: gate }),
    }),
  };
}

describe("CL-6971 secret-guard realpaths before denylist (symlink floor)", () => {
  for (const skipPermissions of [true, false] as const) {
    const mode = skipPermissions ? "yolo" : "normal";

    test(`${mode}: file symlink → outside .env is blocked for read_file`, async () => {
      await withFixture(async ({ cwd }) => {
        const { tools } = runner(cwd, skipPermissions);
        const result = await tools.run(
          { id: "1", name: "read_file", arguments: { path: "config.txt" } },
          new AbortController().signal,
        );
        expect(result.isError).toBe(true);
        expect(String(result.content)).toMatch(/sensitive file|escapes working directory/i);
        expect(String(result.content)).not.toContain("SECRET=outside-env");
      });
    });

    test(`${mode}: file symlink → outside .env is blocked for write_file`, async () => {
      await withFixture(async ({ cwd, outsideEnv }) => {
        const before = await Bun.file(outsideEnv).text();
        const { tools } = runner(cwd, skipPermissions);
        const result = await tools.run(
          {
            id: "1",
            name: "write_file",
            arguments: { path: "config.txt", content: "pwned" },
          },
          new AbortController().signal,
        );
        expect(result.isError).toBe(true);
        expect(String(result.content)).toMatch(/sensitive file|escapes working directory/i);
        expect(await Bun.file(outsideEnv).text()).toBe(before);
      });
    });

    test(`${mode}: dir symlink → outside .aws/credentials is blocked for read_file`, async () => {
      await withFixture(async ({ cwd }) => {
        const { tools } = runner(cwd, skipPermissions);
        const result = await tools.run(
          { id: "1", name: "read_file", arguments: { path: "cache/credentials" } },
          new AbortController().signal,
        );
        expect(result.isError).toBe(true);
        expect(String(result.content)).toMatch(/sensitive file|escapes working directory/i);
        expect(String(result.content)).not.toContain("LEAKED");
      });
    });

    test(`${mode}: dir symlink → outside .aws/credentials is blocked for write_file`, async () => {
      await withFixture(async ({ cwd, awsDir }) => {
        const target = join(awsDir, "credentials");
        const before = await Bun.file(target).text();
        const { tools } = runner(cwd, skipPermissions);
        const result = await tools.run(
          {
            id: "1",
            name: "write_file",
            arguments: { path: "cache/credentials", content: "pwned" },
          },
          new AbortController().signal,
        );
        expect(result.isError).toBe(true);
        expect(String(result.content)).toMatch(/sensitive file|escapes working directory/i);
        expect(await Bun.file(target).text()).toBe(before);
      });
    });

    test(`${mode}: file symlink → outside .env is blocked for apply_patch raw read`, async () => {
      await withFixture(async ({ cwd }) => {
        const { gate } = runner(cwd, skipPermissions);
        const result = await createCodexReadRawFile(cwd, gate)("config.txt");
        expect(result.isError).toBe(true);
        expect(String(result.content)).toMatch(/sensitive file|escapes working directory/i);
        expect(String(result.content)).not.toContain("SECRET=outside-env");
      });
    });

    test(`${mode}: dir symlink → outside .aws/credentials is blocked for apply_patch raw read`, async () => {
      await withFixture(async ({ cwd }) => {
        const { gate } = runner(cwd, skipPermissions);
        const result = await createCodexReadRawFile(cwd, gate)("cache/credentials");
        expect(result.isError).toBe(true);
        expect(String(result.content)).toMatch(/sensitive file|escapes working directory/i);
        expect(String(result.content)).not.toContain("LEAKED");
      });
    });
  }

  // In-workspace file symlink → .env: pathEscape already realpaths in-bounds, but
  // the floor must still hold under yolo without relying on that alone.
  test("yolo: in-workspace file symlink → .env is blocked for read_file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cl6971-inws-"));
    try {
      await writeFile(join(cwd, ".env"), "SECRET=in-ws\n");
      await symlink(join(cwd, ".env"), join(cwd, "looks-safe.txt"));
      const { tools } = runner(cwd, true);
      const result = await tools.run(
        { id: "1", name: "read_file", arguments: { path: "looks-safe.txt" } },
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
      expect(String(result.content)).toMatch(/sensitive file/i);
      expect(String(result.content)).not.toContain("SECRET=in-ws");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
