// Loading the @intx/types/runtime barrel evaluates inference-events.ts and
// builds the InferenceEvent union. Session modules that need runtime values
// import @intx/types/runtime-core so that boot does not pay for the union.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const probe = `
import { mock } from "bun:test";
mock.module("@intx/types/inference-events", () => {
  throw new Error("evaluated-inference-events");
});
const specifier = process.env.PROBE_SPECIFIER;
if (specifier === undefined || specifier.length === 0) {
  throw new Error("missing PROBE_SPECIFIER");
}
for (const target of specifier.split(",")) {
  await import(target);
}
`;

function importUnderProbe(specifier: string): {
  status: number | null;
  stderr: string;
} {
  const result = spawnSync("bun", ["-e", probe], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, PROBE_SPECIFIER: specifier },
  });
  return {
    status: result.status,
    stderr: result.stderr,
  };
}

const sessionBootModules = [
  "./src/session/optimized-context-store.ts",
  "./src/session/pending-approval-record.ts",
  "./src/session/summarizer.ts",
].join(",");

test("the runtime barrel evaluates the inference event union", () => {
  const result = importUnderProbe("@intx/types/runtime");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("evaluated-inference-events");
});

test(
  "session value imports do not evaluate the inference event union",
  () => {
    const result = importUnderProbe(sessionBootModules);
    expect(result.stderr).not.toContain("evaluated-inference-events");
    expect(result.status).toBe(0);
  },
  { timeout: 60_000 },
);

test(
  "importing reactor-authorize does not evaluate inference-events",
  () => {
    const result = importUnderProbe("./src/permission/reactor-authorize.ts");
    expect(result.stderr).not.toContain("evaluated-inference-events");
    expect(result.status).toBe(0);
  },
  { timeout: 60_000 },
);
