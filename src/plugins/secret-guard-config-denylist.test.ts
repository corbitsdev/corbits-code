import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPosixTools } from "@intx/tools-posix";
import { createPermissionGate } from "../permission/gate.js";
import { buildCorePosixToolPlugins } from "../agent/posix-tool-plugins.js";
import { createCodexReadRawFile } from "../agent/codex-read-raw-file.js";
import { createExtraDeniedPathMatcher } from "./secret-guard-plugin.js";

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
  return {
    gate,
    tools: createPosixTools({
      cwd,
      plugins: buildCorePosixToolPlugins({
        cwd,
        permissionGate: gate,
        ...(activeConfigPath !== undefined
          ? { secretGuardExtraDeniedPaths: [activeConfigPath] }
          : {}),
      }),
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

  test("yolo: active custom --config is blocked for apply_patch raw read", async () => {
    await withFixture(async ({ cwd, customConfig }) => {
      const { gate } = runner(cwd, true, customConfig);
      const readRawFile = createCodexReadRawFile(cwd, gate, [customConfig]);
      const result = await readRawFile("operator-config.json");
      expect(result.isError).toBe(true);
      expect(String(result.content)).toMatch(/sensitive file/i);
      expect(String(result.content)).not.toContain(
        "dangerouslySkipPermissions",
      );
    });
  });
});

describe("CL-9386 createExtraDeniedPathMatcher", () => {
  test("empty list never matches", () => {
    expect(createExtraDeniedPathMatcher([])("/any/path.json")).toBe(false);
  });

  test("exact and dot-segment-normalized paths match; others do not", () => {
    const root = join(tmpdir(), "cl9386-normalize");
    const isDenied = createExtraDeniedPathMatcher([
      `${root}/sub/../custom.json`,
    ]);
    expect(isDenied(`${root}/custom.json`)).toBe(true);
    expect(isDenied(`${root}/sub/../custom.json`)).toBe(true);
    expect(isDenied(`${root}/sub/../other.json`)).toBe(false);
    expect(isDenied(`${root}/custom.json.bak`)).toBe(false);
  });

  test("symlink name resolves to the denied target; sibling links do not", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cl9386-matcher-"));
    try {
      const target = join(parent, "operator-config.json");
      await writeFile(target, `${SKIP_PAYLOAD}\n`);
      const link = join(parent, "looks-safe.txt");
      await symlink(target, link);
      const other = join(parent, "other.txt");
      await writeFile(other, "other\n");
      const isDenied = createExtraDeniedPathMatcher([target]);
      expect(isDenied(link)).toBe(true);
      expect(isDenied(target)).toBe(true);
      expect(isDenied(other)).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
