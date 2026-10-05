import { readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { ArkErrors, type } from "arktype";

import { isContainedEntryPath, PackageJSON } from "@intx/types/package-json";
import { ToolPackagePinName } from "@intx/types/tool-packages";

// A workflow package declares the tool packages its steps need as npm
// dependencies (CL-4473). Resolution reads the laid-out `node_modules/` tree,
// the same contract the vendored workflow-definition-loader enforces for
// plugin packages: the dep must be declared, resolvable, and carry an
// `interchange.tools` entry contained in its own directory.
const WorkflowPackageJSON = type({
  name: "string",
  version: "string",
  "dependencies?": "Record<string, string>",
  "peerDependencies?": "Record<string, string>",
}).onUndeclaredKey("ignore");

export interface WorkflowToolPackage {
  name: string;
  version: string;
  // Realpath of the resolved tool package directory.
  dir: string;
  // Absolute path of the package's `interchange.tools` entry module.
  toolsEntry: string;
}

async function readJSON(dir: string, label: string): Promise<unknown> {
  const path = join(dir, "package.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    throw new Error(`cannot read ${label} package.json at ${path}`, {
      cause,
    });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new Error(`cannot parse ${label} package.json at ${path}`, {
      cause,
    });
  }
}

// Resolve one declared tool package from the workflow package's laid-out
// `node_modules/`. Realpath first so workspace symlinks and the closure
// materializer's laid-out tree compare realpath-vs-realpath downstream.
async function resolveOne(
  workflowDir: string,
  declared: ReadonlySet<string>,
  name: string,
): Promise<WorkflowToolPackage> {
  // A declared dep key is joined onto `node_modules/` below, so the name must
  // satisfy npm's package-name rules first — otherwise a key like
  // `../../evil` resolves outside the workflow package. Same rule the hub
  // enforces on tool-package pins (`ToolPackagePinName`).
  if (ToolPackagePinName(name) instanceof ArkErrors) {
    throw new Error(
      `tool package ${JSON.stringify(name)} is not a valid npm package name`,
    );
  }
  if (!declared.has(name)) {
    throw new Error(
      `tool package ${JSON.stringify(name)} is not a dependency of the workflow package at ${workflowDir}; declare it as an npm dep`,
    );
  }
  const linkedDir = join(workflowDir, "node_modules", name);
  let dir: string;
  try {
    dir = await realpath(linkedDir);
  } catch (cause) {
    throw new Error(
      `tool package ${JSON.stringify(name)} could not be resolved from the workflow package at ${workflowDir}; it must be installed as a direct dependency`,
      { cause },
    );
  }
  const parsed = PackageJSON(await readJSON(dir, `tool package ${name}`));
  if (parsed instanceof ArkErrors) {
    throw new Error(
      `tool package ${JSON.stringify(name)} at ${dir} has an invalid package.json: ${String(parsed)}`,
    );
  }
  if (parsed.name !== name) {
    throw new Error(
      `tool package at ${dir} names itself ${JSON.stringify(parsed.name)} but was resolved as ${JSON.stringify(name)}`,
    );
  }
  const entryRel = parsed.interchange?.tools;
  if (entryRel === undefined) {
    throw new Error(
      `tool package ${JSON.stringify(name)} at ${dir} declares no "interchange.tools" entry; it is not a tool package`,
    );
  }
  if (!isContainedEntryPath(entryRel)) {
    throw new Error(
      `tool package ${JSON.stringify(name)} at ${dir} declares an "interchange.tools" entry ${JSON.stringify(entryRel)} that escapes its directory`,
    );
  }
  // Realpath containment, mirroring the vendored workflow-definition-loader:
  // the string check above rejects `..`/absolute paths, and this check
  // rejects an escape through a file or directory symlink inside the package.
  // Both sides are realpath'd so the comparison holds under a symlinked
  // parent (e.g. macOS `/tmp` -> `/private/tmp`).
  const entryAbs = join(dir, entryRel);
  let realDir: string;
  let realEntry: string;
  try {
    realDir = await realpath(dir);
    realEntry = await realpath(entryAbs);
  } catch (cause) {
    throw new Error(
      `tool package ${JSON.stringify(name)} at ${dir} declares an "interchange.tools" entry ${JSON.stringify(entryRel)} that could not be resolved`,
      { cause },
    );
  }
  const containmentRoot = realDir.endsWith(sep) ? realDir : realDir + sep;
  if (realEntry !== realDir && !realEntry.startsWith(containmentRoot)) {
    throw new Error(
      `tool package ${JSON.stringify(name)} at ${dir} declares an "interchange.tools" entry ${JSON.stringify(entryRel)} that escapes its directory via a symlink`,
    );
  }
  return {
    name,
    version: parsed.version,
    dir,
    toolsEntry: entryAbs,
  };
}

// Resolve a workflow package's declared tool-package dependencies to their
// `interchange.tools` entries. Names must appear in the workflow package's
// `dependencies` (or `peerDependencies`); anything else is rejected even when
// present on disk, so the declaration — not the layout — is authoritative.
export async function resolveWorkflowToolPackages(
  workflowDir: string,
  toolPackageNames: readonly string[],
): Promise<WorkflowToolPackage[]> {
  const raw = await readJSON(workflowDir, "workflow package");
  const parsed = WorkflowPackageJSON(raw);
  if (parsed instanceof ArkErrors) {
    throw new Error(
      `workflow package at ${workflowDir} has an invalid package.json: ${String(parsed)}`,
    );
  }
  const declared = new Set([
    ...Object.keys(parsed.dependencies ?? {}),
    ...Object.keys(parsed.peerDependencies ?? {}),
  ]);
  const unique = [...new Set(toolPackageNames)];
  return Promise.all(
    unique.map((name) => resolveOne(workflowDir, declared, name)),
  );
}
