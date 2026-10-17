import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { evaluate, type CheckValue, type Run } from "@corbits/evals";
import {
  ROUTE_BUDGET_MS,
  evaluateRouting,
  routesCheck,
} from "./eval-prompts-dispatch.js";

const ROSTER =
  "explorer, planner, coder, reviewer, designer, artist, warden, shakespeare, prober, qa-lead";

function passed(value: CheckValue | Promise<CheckValue>): boolean {
  if (typeof value === "object" && value !== null && "then" in value) {
    throw new Error("expected a sync check");
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  return value.pass;
}

function routingRun(
  output: string,
  expect: { route: string; decoys: readonly string[] },
): Run<string, string, { route: string; decoys: readonly string[] }> {
  return {
    input: "task",
    output,
    expect,
    steps: [],
    ms: 1,
  };
}

describe("routes scores the first line", () => {
  const coder = { route: "coder", decoys: ["explorer", "reviewer"] };

  test("a roster-only reply does not pass", () => {
    expect(passed(routesCheck(routingRun(ROSTER, coder)))).toBe(false);
    expect(
      passed(routesCheck(routingRun(`${ROSTER}\nI would spawn coder.`, coder))),
    ).toBe(false);
  });

  test("a decoy on the first line does not pass", () => {
    expect(
      passed(
        routesCheck(routingRun("reviewer\nI will not change code.", coder)),
      ),
    ).toBe(false);
    expect(
      passed(
        routesCheck(
          routingRun("I would not spawn explorer; spawn coder.", {
            route: "explorer",
            decoys: ["coder", "planner"],
          }),
        ),
      ),
    ).toBe(false);
  });

  test("the specialist alone on the first line passes", () => {
    expect(
      passed(
        routesCheck(
          routingRun(
            "coder\nI will just patch the login flow and add a test.",
            coder,
          ),
        ),
      ),
    ).toBe(true);
    expect(passed(routesCheck(routingRun("Coder\nbrief", coder)))).toBe(true);
  });
});

describe("drop baseline", () => {
  const coderCase = {
    name: "fix-token-refresh",
    input: "Fix the login flow.",
    expect: { route: "coder", decoys: ["explorer", "reviewer"] },
  };

  function stored(routesPass: boolean): string {
    return `${JSON.stringify(
      {
        format: 1,
        eval: "dispatch-routing",
        cases: {
          "fix-token-refresh": {
            routes: { pass: routesPass, value: routesPass ? 1 : 0 },
            fast: { pass: true, value: 1 },
          },
        },
      },
      null,
      2,
    )}\n`;
  }

  test("a failing run does not replace the baseline and the next run still drops", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-routing-"));
    const baselinePath = join(dir, "baseline.json");
    const lastPath = join(dir, "last.json");
    const before = stored(true);
    await writeFile(baselinePath, before);
    const timeouts: (number | string | undefined)[] = [];
    const run = async () => "reviewer\nI refuse.";
    try {
      const first = await evaluateRouting({
        cases: [coderCase],
        run,
        lastPath,
        baselinePath,
        evaluateFn: (name, options) => {
          timeouts.push(options.timeout);
          return evaluate(name, options);
        },
      });
      expect(first).toBe(1);
      expect(await readFile(baselinePath, "utf8")).toBe(before);
      expect(await readFile(lastPath, "utf8")).not.toBe(before);

      const second = await evaluateRouting({
        cases: [coderCase],
        run,
        lastPath,
        baselinePath,
      });
      expect(second).toBe(1);
      expect(await readFile(baselinePath, "utf8")).toBe(before);
      expect(timeouts).toEqual([ROUTE_BUDGET_MS]);
      expect(ROUTE_BUDGET_MS).toBe(120_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a passing run updates the baseline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-routing-"));
    const baselinePath = join(dir, "baseline.json");
    const lastPath = join(dir, "last.json");
    await writeFile(baselinePath, stored(false));
    try {
      const code = await evaluateRouting({
        cases: [coderCase],
        run: async () => "coder\nAdd a regression test for token refresh.",
        lastPath,
        baselinePath,
      });
      expect(code).toBe(0);
      const after = JSON.parse(await readFile(baselinePath, "utf8")) as {
        cases: { "fix-token-refresh": { routes: { pass: boolean } } };
      };
      expect(after.cases["fix-token-refresh"].routes.pass).toBe(true);
      expect(await readFile(lastPath, "utf8")).toBe(
        await readFile(baselinePath, "utf8"),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a missing baseline fails closed and is not created", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-routing-"));
    const baselinePath = join(dir, "baseline.json");
    const lastPath = join(dir, "last.json");
    const run = async () => "reviewer\nI refuse.";
    try {
      const first = await evaluateRouting({
        cases: [coderCase],
        run,
        lastPath,
        baselinePath,
      });
      expect(first).not.toBe(0);
      await expect(access(baselinePath)).rejects.toThrow();

      const second = await evaluateRouting({
        cases: [coderCase],
        run,
        lastPath,
        baselinePath,
      });
      expect(second).not.toBe(0);
      await expect(access(baselinePath)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a clean pass seeds a missing baseline and the next run compares", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-routing-"));
    const baselinePath = join(dir, "baseline.json");
    const lastPath = join(dir, "last.json");
    try {
      const seeded = await evaluateRouting({
        cases: [coderCase],
        run: async () => "coder\nAdd a regression test for token refresh.",
        lastPath,
        baselinePath,
      });
      expect(seeded).toBe(0);
      const seededText = await readFile(baselinePath, "utf8");
      const parsed = JSON.parse(seededText) as {
        cases: { "fix-token-refresh": { routes: { pass: boolean } } };
      };
      expect(parsed.cases["fix-token-refresh"].routes.pass).toBe(true);

      const dropped = await evaluateRouting({
        cases: [coderCase],
        run: async () => "reviewer\nI refuse.",
        lastPath,
        baselinePath,
      });
      expect(dropped).not.toBe(0);
      expect(await readFile(baselinePath, "utf8")).toBe(seededText);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a within-budget miss leaves an existing baseline unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-routing-"));
    const baselinePath = join(dir, "baseline.json");
    const lastPath = join(dir, "last.json");
    const before = stored(false);
    await writeFile(baselinePath, before);
    try {
      const code = await evaluateRouting({
        cases: [coderCase],
        run: async () => "reviewer\nI refuse.",
        lastPath,
        baselinePath,
      });
      expect(code).toBe(0);
      expect(await readFile(baselinePath, "utf8")).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an unbaselined routes miss fails and is not stored as a pass", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-routing-"));
    const baselinePath = join(dir, "baseline.json");
    const lastPath = join(dir, "last.json");
    const before = stored(true);
    await writeFile(baselinePath, before);
    const unknown = {
      name: "map-the-repo",
      input: "Where is the login handler?",
      expect: { route: "explorer", decoys: ["coder", "reviewer"] },
    };
    try {
      const code = await evaluateRouting({
        cases: [coderCase, unknown],
        run: async (input) =>
          input === unknown.input
            ? "coder\nwrong specialist"
            : "coder\nAdd a regression test for token refresh.",
        lastPath,
        baselinePath,
      });
      expect(code).not.toBe(0);
      const after = JSON.parse(await readFile(baselinePath, "utf8")) as {
        cases: Record<string, { routes?: { pass: boolean } } | undefined>;
      };
      expect(after.cases["map-the-repo"]?.routes?.pass).not.toBe(true);
      expect(after.cases["fix-token-refresh"]?.routes?.pass).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a new pass beside a baselined miss is stored and a later flip drops", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-routing-"));
    const baselinePath = join(dir, "baseline.json");
    const lastPath = join(dir, "last.json");
    await writeFile(baselinePath, stored(false));
    const added = {
      name: "map-the-repo",
      input: "Where is the login handler?",
      expect: { route: "explorer", decoys: ["coder", "reviewer"] },
    };
    try {
      const storedPass = await evaluateRouting({
        cases: [coderCase, added],
        run: async (input) =>
          input === added.input
            ? "explorer\nLook up the handler."
            : "reviewer\nI refuse.",
        lastPath,
        baselinePath,
      });
      expect(storedPass).toBe(0);
      const after = JSON.parse(await readFile(baselinePath, "utf8")) as {
        cases: {
          "fix-token-refresh": { routes: { pass: boolean } };
          "map-the-repo": { routes: { pass: boolean } };
        };
      };
      expect(after.cases["fix-token-refresh"].routes.pass).toBe(false);
      expect(after.cases["map-the-repo"].routes.pass).toBe(true);
      const passedText = await readFile(baselinePath, "utf8");

      const flipped = await evaluateRouting({
        cases: [coderCase, added],
        run: async (input) =>
          input === added.input
            ? "coder\nwrong specialist"
            : "reviewer\nI refuse.",
        lastPath,
        baselinePath,
      });
      expect(flipped).not.toBe(0);
      expect(await readFile(baselinePath, "utf8")).toBe(passedText);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
