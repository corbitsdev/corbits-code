import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// Guard against the gate drifting apart again (CL-7300): `bun run check` and
// CI's test job must resolve to the same seeded suite, and the projects-dir
// guard must delegate to the `test` script rather than duplicate its command.

const repoRoot = join(import.meta.dir, "..", "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const ci = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
const guardSource = readFileSync(join(repoRoot, "scripts", "guard-real-projects-dir.ts"), "utf8");

const GUARD_SCRIPT = "check:projects-dir-guard";
const BUDGET_SCRIPT = "check:tui-budget";
const TEST_SUITE = "bun test ./src ./tests ./evals --randomize --seed 424242";

describe("check gate", () => {
  test("`test` is the seeded, randomized suite CI runs", () => {
    expect(pkg.scripts.test).toBe(TEST_SUITE);
  });

  test("`check` runs the suite through the projects-dir guard", () => {
    expect(pkg.scripts[GUARD_SCRIPT]).toContain("scripts/guard-real-projects-dir.ts");
    expect(pkg.scripts.check).toContain(`bun run ${GUARD_SCRIPT}`);
    // The guard delegates to `bun run test` so the suite command has one home.
    expect(guardSource).toContain('"run", "test"');
  });

  test("`check` and CI both run the TUI file-budget ratchet", () => {
    expect(pkg.scripts[BUDGET_SCRIPT]).toContain("scripts/guard-tui-file-budget.ts");
    expect(pkg.scripts.check).toContain(`bun run ${BUDGET_SCRIPT}`);
    // Without a CI step the ratchet gates nothing on merge; without the
    // check-chain entry local `bun run check` goes green while CI fails.
    expect(ci).toContain(`run: bun run ${BUDGET_SCRIPT}`);
  });

  test("CI's test job invokes the same script, not a raw test command", () => {
    expect(ci).toContain(`run: bun run ${GUARD_SCRIPT}`);
    // An unguarded suite step here would reintroduce the local-green/CI
    // mismatch (and skip the projects-dir sandbox) this gate exists to prevent.
    expect(ci).not.toMatch(/^\s*run: bun test(\s|$)/m);
    expect(ci).not.toMatch(/^\s*run: bun run test(\s|$)/m);
  });
});
