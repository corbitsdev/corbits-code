import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";

// Guard against the gate drifting apart again (CL-7300): `bun run check` and
// CI's test jobs must resolve to the same seeded path union, and the projects-dir
// guard must delegate to the `test` script (or `test:paths` for shard filters)
// rather than duplicate its command. Local `bun run test` is one process; CI
// shards that union via `test:paths`.

const repoRoot = join(import.meta.dir, "..");
const pkg = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
) as {
  scripts: Record<string, string>;
};
const ci = readFileSync(
  join(repoRoot, ".github", "workflows", "ci.yml"),
  "utf8",
);
const guardSource = readFileSync(
  join(repoRoot, "scripts", "guard-real-projects-dir.ts"),
  "utf8",
);

const GUARD_SCRIPT = "check:projects-dir-guard";
const TEST_SUITE =
  "bun test ./src ./e2e ./evals ./scripts --randomize --seed 424242";

function expandToTestFiles(filters: string[]): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name.endsWith(".test.ts"))
        files.push(relative(repoRoot, absolute).split("/").join("/"));
    }
  };
  for (const filter of filters) {
    const absolute = join(repoRoot, filter.replace(/^\.\//, ""));
    if (statSync(absolute).isFile())
      files.push(relative(repoRoot, absolute).split("/").join("/"));
    else walk(absolute);
  }
  return files.sort();
}

describe("check gate", () => {
  test("`test` is the seeded, randomized one-process suite whose path union CI shards", () => {
    expect(pkg.scripts.test).toBe(TEST_SUITE);
  });

  test("`test:paths` is the seeded suite accepting CI shard path filters", () => {
    // Same seed as `test`; the guard passes shard filters as arguments, which
    // cannot be appended to `bun run test` because bun's filters are additive.
    // Zero args would be a whole-tree `bun test` including vendor/, so the
    // wrapper requires at least one path.
    expect(pkg.scripts["test:paths"]).toBe("bun scripts/test-paths.ts");
    expect(guardSource).toContain('"run", "test:paths"');
    const testPathsSource = readFileSync(
      join(repoRoot, "scripts", "test-paths.ts"),
      "utf8",
    );
    expect(testPathsSource).toContain("--randomize");
    expect(testPathsSource).toContain("--seed");
    expect(testPathsSource).toContain("424242");
    expect(testPathsSource).toContain("requires at least one path filter");
  });

  test("`check` runs the suite through the projects-dir guard", () => {
    expect(pkg.scripts[GUARD_SCRIPT]).toContain(
      "scripts/guard-real-projects-dir.ts",
    );
    expect(pkg.scripts.check).toContain(`bun run ${GUARD_SCRIPT}`);
    // The guard delegates to `bun run test` so the suite command has one home.
    expect(guardSource).toContain('"run", "test"');
  });

  test("CI's test job invokes the same script, not a raw test command", () => {
    expect(ci).toContain(`run: bun run ${GUARD_SCRIPT}`);
    // An unguarded suite step here would reintroduce the local-green/CI
    // mismatch (and skip the projects-dir sandbox) this gate exists to prevent.
    expect(ci).not.toMatch(/^\s*run: bun test(\s|$)/m);
    expect(ci).not.toMatch(/^\s*run: bun run test(\s|$)/m);
  });

  test("CI test shards cover exactly the suite's paths", () => {
    // Time-balanced --shard slices each run the full union (bun partitions
    // files across the slices, balanced by --timings), so coverage holds
    // when the matrix has all four slices and the shard command template
    // carries the suite's paths plus the interpolated --shard flag.
    // Sharding must never silently drop (or double-run) part of the suite:
    // expanding the template's filters to test files has to equal the
    // unsharded `test` script's paths expanded the same way.
    for (const shard of ["1/4", "2/4", "3/4", "4/4"]) {
      expect(ci).toContain(`"${shard}"`);
    }
    const runArgs = [
      ...ci.matchAll(/^\s*run: bun run check:projects-dir-guard(.+)$/gm),
    ]
      .map((match) => match[1] ?? "")
      .find((args) => args.includes("--shard=${{ matrix.shard }}"));
    expect(runArgs).toBeDefined();
    const shardFilters = (runArgs ?? "")
      .split(/\s+/)
      .filter((part) => part.startsWith("./"));
    const suiteFilters = TEST_SUITE.split(" ").filter((part) =>
      part.startsWith("./"),
    );
    expect(expandToTestFiles(shardFilters)).toEqual(
      expandToTestFiles(suiteFilters),
    );
    expect(runArgs).toContain("--timings=./scripts/ci-timings.json");
  });
});
