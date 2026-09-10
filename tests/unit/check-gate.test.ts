import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// Guard against the gate drifting apart again (CL-7300): `bun run check` and
// CI's test jobs must resolve to the same seeded path union, and the projects-dir
// guard must delegate to the `test` script (or `test:paths` for shard filters)
// rather than duplicate its command. Local `bun run test` is one process; CI
// shards that union via `test:paths`.

const repoRoot = join(import.meta.dir, "..", "..");
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
  "bun test ./src ./tests ./evals ./scripts --randomize --seed 424242";

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
    // Sharding must never silently drop part of the suite: the union of the
    // matrix shards has to equal the unsharded `test` script's paths.
    const shardPaths = [...ci.matchAll(/^\s+paths: (.+)$/gm)]
      .flatMap((match) => match[1]?.trim().split(/\s+/) ?? [])
      .sort();
    const suitePaths = TEST_SUITE.split(" ")
      .filter((part) => part.startsWith("./"))
      .sort();
    expect(shardPaths).toEqual(suitePaths);
  });
});
