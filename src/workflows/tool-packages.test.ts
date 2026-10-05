import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveWorkflowToolPackages } from "./tool-packages.js";
import { defined } from "../../testkit/defined.js";

const TOOL_NAME = "@corbits/tool-gh";

async function writeJSON(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value));
}

// A workflow package that declares `toolDeps` as npm dependencies.
async function makeWorkflow(
  root: string,
  toolDeps: Record<string, string>,
): Promise<string> {
  const dir = join(root, "workflow");
  await mkdir(dir, { recursive: true });
  await writeJSON(join(dir, "package.json"), {
    name: "@corbits/workflow-pr-review",
    version: "0.1.0",
    dependencies: toolDeps,
  });
  return dir;
}

// A laid-out tool package inside the workflow's `node_modules/`.
async function layOutTool(
  workflowDir: string,
  manifest: Record<string, unknown>,
): Promise<string> {
  const dir = join(workflowDir, "node_modules", TOOL_NAME);
  await mkdir(dir, { recursive: true });
  await writeJSON(join(dir, "package.json"), manifest);
  const entry = join(dir, "dist", "tools.js");
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(entry, "export const tools = [];\n");
  return dir;
}

describe("resolveWorkflowToolPackages", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "wf-tool-pkgs-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("resolves a declared tool package to its interchange.tools entry", async () => {
    const workflowDir = await makeWorkflow(root, {
      [TOOL_NAME]: "workspace:*",
    });
    const toolDir = await layOutTool(workflowDir, {
      name: TOOL_NAME,
      version: "1.2.3",
      interchange: { tools: "./dist/tools.js" },
    });
    const resolved = defined(
      (await resolveWorkflowToolPackages(workflowDir, [TOOL_NAME]))[0],
      "resolved tool package",
    );
    expect(resolved.name).toBe(TOOL_NAME);
    expect(resolved.version).toBe("1.2.3");
    expect(resolved.dir).toBe(await realpath(toolDir));
    expect(resolved.toolsEntry).toBe(
      join(await realpath(toolDir), "dist", "tools.js"),
    );
  });

  test("resolves through a symlinked node_modules entry like a workspace layout", async () => {
    const workflowDir = await makeWorkflow(root, {
      [TOOL_NAME]: "workspace:*",
    });
    const target = join(root, "real-tool-pkg");
    await mkdir(join(target, "dist"), { recursive: true });
    await writeJSON(join(target, "package.json"), {
      name: TOOL_NAME,
      version: "2.0.0",
      interchange: { tools: "./dist/tools.js" },
    });
    await writeFile(
      join(target, "dist", "tools.js"),
      "export const tools = [];\n",
    );
    await mkdir(join(workflowDir, "node_modules", "@corbits"), {
      recursive: true,
    });
    await symlink(target, join(workflowDir, "node_modules", TOOL_NAME));
    const resolved = defined(
      (await resolveWorkflowToolPackages(workflowDir, [TOOL_NAME]))[0],
      "resolved tool package",
    );
    expect(resolved.dir).toBe(await realpath(target));
    expect(resolved.toolsEntry).toBe(
      join(await realpath(target), "dist", "tools.js"),
    );
  });

  test("dedupes a tool package requested twice", async () => {
    const workflowDir = await makeWorkflow(root, {
      [TOOL_NAME]: "workspace:*",
    });
    await layOutTool(workflowDir, {
      name: TOOL_NAME,
      version: "1.2.3",
      interchange: { tools: "./dist/tools.js" },
    });
    const resolved = await resolveWorkflowToolPackages(workflowDir, [
      TOOL_NAME,
      TOOL_NAME,
    ]);
    expect(resolved).toHaveLength(1);
  });

  test("rejects a package present on disk but missing from dependencies", async () => {
    const workflowDir = await makeWorkflow(root, {});
    await layOutTool(workflowDir, {
      name: TOOL_NAME,
      version: "1.2.3",
      interchange: { tools: "./dist/tools.js" },
    });
    await expect(
      resolveWorkflowToolPackages(workflowDir, [TOOL_NAME]),
    ).rejects.toThrow(/not a dependency.*declare it as an npm dep/);
  });

  test("rejects a declared dependency that is not installed", async () => {
    const workflowDir = await makeWorkflow(root, {
      [TOOL_NAME]: "workspace:*",
    });
    await expect(
      resolveWorkflowToolPackages(workflowDir, [TOOL_NAME]),
    ).rejects.toThrow(/could not be resolved.*direct dependency/);
  });

  test("rejects an installed dependency without an interchange.tools entry", async () => {
    const workflowDir = await makeWorkflow(root, {
      [TOOL_NAME]: "workspace:*",
    });
    await layOutTool(workflowDir, { name: TOOL_NAME, version: "1.2.3" });
    await expect(
      resolveWorkflowToolPackages(workflowDir, [TOOL_NAME]),
    ).rejects.toThrow(/declares no "interchange\.tools" entry/);
  });

  test("rejects an interchange.tools entry that escapes its directory", async () => {
    const workflowDir = await makeWorkflow(root, {
      [TOOL_NAME]: "workspace:*",
    });
    await layOutTool(workflowDir, {
      name: TOOL_NAME,
      version: "1.2.3",
      interchange: { tools: "../evil.js" },
    });
    await expect(
      resolveWorkflowToolPackages(workflowDir, [TOOL_NAME]),
    ).rejects.toThrow(/escapes its directory/);
  });

  test("rejects an interchange.tools entry that escapes via a file symlink", async () => {
    const workflowDir = await makeWorkflow(root, {
      [TOOL_NAME]: "workspace:*",
    });
    const toolDir = await layOutTool(workflowDir, {
      name: TOOL_NAME,
      version: "1.2.3",
      interchange: { tools: "./dist/tools.js" },
    });
    const outside = join(root, "evil.js");
    await writeFile(outside, "export const tools = [];\n");
    await rm(join(toolDir, "dist", "tools.js"));
    await symlink(outside, join(toolDir, "dist", "tools.js"));
    await expect(
      resolveWorkflowToolPackages(workflowDir, [TOOL_NAME]),
    ).rejects.toThrow(/escapes its directory via a symlink/);
  });

  test("rejects an interchange.tools entry that escapes via a directory symlink", async () => {
    const workflowDir = await makeWorkflow(root, {
      [TOOL_NAME]: "workspace:*",
    });
    const outsideDir = join(root, "evil-dir");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(
      join(outsideDir, "tools.js"),
      "export const tools = [];\n",
    );
    const toolDir = join(workflowDir, "node_modules", TOOL_NAME);
    await mkdir(toolDir, { recursive: true });
    await writeJSON(join(toolDir, "package.json"), {
      name: TOOL_NAME,
      version: "1.2.3",
      interchange: { tools: "./linked/tools.js" },
    });
    await symlink(outsideDir, join(toolDir, "linked"));
    await expect(
      resolveWorkflowToolPackages(workflowDir, [TOOL_NAME]),
    ).rejects.toThrow(/escapes its directory via a symlink/);
  });

  test("rejects a tool package name that is not a valid npm package name", async () => {
    const workflowDir = await makeWorkflow(root, {
      [TOOL_NAME]: "workspace:*",
    });
    await expect(
      resolveWorkflowToolPackages(workflowDir, ["../../evil"]),
    ).rejects.toThrow(/not a valid npm package name/);
  });

  test("rejects a resolved directory whose package.json names another package", async () => {
    const workflowDir = await makeWorkflow(root, {
      [TOOL_NAME]: "workspace:*",
    });
    await layOutTool(workflowDir, {
      name: "@corbits/tool-other",
      version: "1.2.3",
      interchange: { tools: "./dist/tools.js" },
    });
    await expect(
      resolveWorkflowToolPackages(workflowDir, [TOOL_NAME]),
    ).rejects.toThrow(/names itself/);
  });

  test("rejects a workflow package.json missing name and version", async () => {
    const workflowDir = join(root, "workflow");
    await mkdir(workflowDir, { recursive: true });
    await writeJSON(join(workflowDir, "package.json"), { private: true });
    await expect(
      resolveWorkflowToolPackages(workflowDir, [TOOL_NAME]),
    ).rejects.toThrow(/invalid package\.json/);
  });
});
