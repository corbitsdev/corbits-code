import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";

// CL-9021: the root pin for the sessions package was dropped because no
// first-party tree imports it. The only remaining references are the inert
// `vendor/intx-workflow-host/` provenance files (not a workspace member,
// excluded from typecheck/test/build per docs/VENDORING.md) plus prose
// comments. Fail if a built tree gains an import or the pin creeps back.

const repoRoot = join(import.meta.dir, "..");
const pkg = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
) as {
  dependencies: Record<string, string>;
};

// Trees that participate in typecheck (tsconfig include) and the test suite.
const FIRST_PARTY_TREES = [
  "src",
  "packages",
  "scripts",
  "e2e",
  "evals",
  "testkit",
];

const SESSIONS_IMPORT =
  /(?:from\s+|require\(\s*|import\(\s*)["']@intx\/hub-sessions(?:\/[^"']*)?["']\s*\)?/;

function tsFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name.endsWith(".ts")) files.push(absolute);
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

describe("no sessions package", () => {
  test("package.json carries no dependency on the sessions package", () => {
    expect(pkg.dependencies["@intx/hub-sessions"]).toBeUndefined();
  });

  test("no first-party tree imports the sessions package", () => {
    const offenders: string[] = [];
    for (const tree of FIRST_PARTY_TREES) {
      for (const file of tsFiles(join(repoRoot, tree))) {
        if (SESSIONS_IMPORT.test(readFileSync(file, "utf8")))
          offenders.push(relative(repoRoot, file).split("/").join("/"));
      }
    }
    expect(offenders).toEqual([]);
  });
});
