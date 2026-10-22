import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { schemaMaterializations } from "../schema/lazy.js";

// The probe below imports schemaMaterializations from a string, which
// check:dead-exports cannot see; this static import keeps the consumer visible.
void schemaMaterializations;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const probe = `
import { schemaMaterializations } from "./src/schema/lazy.js";
const before = schemaMaterializations();
await import("./src/config/settings.js");
process.stdout.write(JSON.stringify({ before, afterImport: schemaMaterializations() }));
`;

test("importing settings does not build schemas", async () => {
  const child = Bun.spawn([process.execPath, "-e", probe], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode, stderr).toBe(0);
  const materializations = JSON.parse(stdout) as {
    before: number;
    afterImport: number;
  };
  expect(materializations.afterImport).toBe(materializations.before);
});
