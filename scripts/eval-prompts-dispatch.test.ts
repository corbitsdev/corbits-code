import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { evaluate, type CheckValue, type Run } from "@corbits/evals";
import {
  ROUTE_BUDGET_MS,
  evaluateRouting,
  noDiyCheck,
  routeLine,
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

describe("noDiy ignores the brief line", () => {
  test("DIY verbs in the brief do not fail", () => {
    expect(
      passed(
        noDiyCheck(
          routingRun(
            "coder\nI will just patch the login flow and add a test.",
            {
              route: "coder",
              decoys: ["explorer"],
            },
          ),
        ),
      ),
    ).toBe(true);
    expect(
      passed(
        noDiyCheck(
          routingRun("shakespeare\nI'll write the architecture doc", {
            route: "shakespeare",
            decoys: ["explorer", "planner"],
          }),
        ),
      ),
    ).toBe(true);
  });

  test("DIY on the route line still fails", () => {
    expect(
      passed(
        noDiyCheck(
          routingRun("I'll write the architecture doc\nshakespeare", {
            route: "shakespeare",
            decoys: ["explorer"],
          }),
        ),
      ),
    ).toBe(false);
    expect(
      passed(
        noDiyCheck(
          routingRun("I'll fix the login bug", {
            route: "coder",
            decoys: ["reviewer"],
          }),
        ),
      ),
    ).toBe(false);
    expect(routeLine("coder\nI'll fix it")).toBe("coder");
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
            noDiy: { pass: true, value: 1 },
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
});
