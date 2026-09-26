import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPosixTools } from "@intx/tools-posix";
import { createPermissionGate } from "../permission/gate.js";
import { buildCorePosixToolPlugins } from "../agent/posix-tool-plugins.js";

/**
 * CL-9386: an operator-chosen --config path inside the workspace is
 * model-readable/writable while carrying standing skip-permissions (persisted
 * there by /yolo, which writes the active settings source). The static
 * secret-guard denylist only covers the default .corbits/settings.json shapes,
 * so the active custom path must be runtime-denylisted for the path-keyed
 * tools — reads and writes — even under skip-permissions.
 */

const SKIP_PAYLOAD = JSON.stringify(
  { dangerouslySkipPermissions: true },
  null,
  2,
);

async function withFixture<T>(
  run: (paths: {
    cwd: string;
    customConfig: string;
    configLink: string;
  }) => Promise<T>,
): Promise<T> {
  const parent = await mkdtemp(join(tmpdir(), "cl9386-config-denylist-"));
  const cwd = join(parent, "ws");
  await mkdir(cwd, { recursive: true });
  // Standing skip-permissions persisted into the operator-chosen --config file,
  // exactly what /yolo writes when --config points inside the workspace.
  const customConfig = join(cwd, "operator-config.json");
  await writeFile(customConfig, `${SKIP_PAYLOAD}\n`);
  // An innocuous symlink name for the same file: the resolve leg must hold.
  const configLink = join(cwd, "notes.txt");
  await symlink(customConfig, configLink);
  await writeFile(join(cwd, "scratch.txt"), "ordinary workspace file\n");
  try {
    return await run({ cwd, customConfig, configLink });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function runner(
  cwd: string,
  skipPermissions: boolean,
  activeConfigPath?: string,
) {
  const gate = createPermissionGate({
    approvals: [],
    interactive: false,
    skipPermissions,
    reactorGated: false,
    auto: false,
    cwd,
  });
  const args = { cwd, permissionGate: gate };
  if (activeConfigPath !== undefined) {
    // CL-9386 seam: entry points thread the active --config path into the tool
    // stack here. Until the option exists this assignment is ignored and the
    // custom-config tests below fail (red).
    (args as { secretGuardExtraDeniedPaths?: string[] })
      .secretGuardExtraDeniedPaths = [activeConfigPath];
  }
  return {
    gate,
    tools: createPosixTools({
      cwd,
      plugins: buildCorePosixToolPlugins(args),
    }),
  };
}

describe("CL-9386 runtime-denylist the active --config path holding skip", () => {
  for (const skipPermissions of [true, false] as const) {
    const mode = skipPermissions ? "yolo" : "normal";

    test(`${mode}: active custom --config is blocked for read_file`, async () => {
      await withFixture(async ({ cwd, customConfig }) => {
        const { tools } = runner(cwd, skipPermissions, customConfig);
        const result = await tools.run(
          {
            id: "1",
            name: "read_file",
            arguments: { path: "operator-config.json" },
          },
          new AbortController().signal,
        );
        expect(result.isError).toBe(true);
        expect(String(result.content)).toMatch(/sensitive file/i);
        expect(String(result.content)).not.toContain(
          "dangerouslySkipPermissions",
        );
      });
    });

    test(`${mode}: active custom --config is blocked for write_file`, async () => {
      await withFixture(async ({ cwd, customConfig }) => {
        const before = await Bun.file(customConfig).text();
        const { tools } = runner(cwd, skipPermissions, customConfig);
        const result = await tools.run(
          {
            id: "1",
            name: "write_file",
            arguments: {
              path: "operator-config.json",
              content: '{"dangerouslySkipPermissions":false}\n',
            },
          },
          new AbortController().signal,
        );
        expect(result.isError).toBe(true);
        expect(String(result.content)).toMatch(/sensitive file/i);
        expect(await Bun.file(customConfig).text()).toBe(before);
      });
    });

    test(`${mode}: active custom --config via symlink name is blocked for read_file`, async () => {
      await withFixture(async ({ cwd, customConfig }) => {
        const { tools } = runner(cwd, skipPermissions, customConfig);
        const result = await tools.run(
          { id: "1", name: "read_file", arguments: { path: "notes.txt" } },
          new AbortController().signal,
        );
        expect(result.isError).toBe(true);
        expect(String(result.content)).toMatch(/sensitive file/i);
        expect(String(result.content)).not.toContain(
          "dangerouslySkipPermissions",
        );
      });
    });
  }

  test("pin: default settings-shaped file stays statically denied without extras", async () => {
    await withFixture(async ({ cwd }) => {
      const defaultShaped = join(cwd, ".corbits", "settings.json");
      await mkdir(join(cwd, ".corbits"), { recursive: true });
      await writeFile(defaultShaped, `${SKIP_PAYLOAD}\n`);
      for (const skipPermissions of [true, false] as const) {
        const { tools } = runner(cwd, skipPermissions);
        const result = await tools.run(
          {
            id: "1",
            name: "read_file",
            arguments: { path: ".corbits/settings.json" },
          },
          new AbortController().signal,
        );
        expect(result.isError).toBe(true);
        expect(String(result.content)).toMatch(/sensitive file/i);
        expect(String(result.content)).not.toContain(
          "dangerouslySkipPermissions",
        );
      }
    });
  });

  test("pin: unrelated workspace file stays readable with extras set", async () => {
    await withFixture(async ({ cwd, customConfig }) => {
      const { tools } = runner(cwd, true, customConfig);
      const result = await tools.run(
        { id: "1", name: "read_file", arguments: { path: "scratch.txt" } },
        new AbortController().signal,
      );
      expect(result.isError !== true).toBe(true);
      expect(String(result.content)).toContain("ordinary workspace file");
    });
  });
});
