import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function probeImport(specifier: string): number | null {
  const script = `
    import { mock } from "bun:test";
    mock.module("@intx/types/inference-events", () => {
      throw new Error("evaluated-inference-events");
    });
    await import(${JSON.stringify(specifier)});
  `;
  const result = spawnSync("bun", ["-e", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (
    result.status !== 0 &&
    !`${result.stderr}${result.stdout}`.includes("evaluated-inference-events")
  ) {
    throw new Error(
      `probe of ${specifier} failed without evaluated-inference-events:\n${result.stderr}\n${result.stdout}`,
    );
  }
  return result.status;
}

describe("runtime-core import boundary", () => {
  test("importing reactor-authorize does not evaluate inference-events", () => {
    expect(probeImport("./src/permission/reactor-authorize.ts")).toBe(0);
  });
});
