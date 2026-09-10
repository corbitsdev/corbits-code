import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "../..");
const oxlintrc = join(repoRoot, ".oxlintrc.json");
const ruleCode = "corbits(no-bare-mock-module)";

interface OxlintJson {
  diagnostics?: { code?: string; message?: string }[];
}

async function runOxlint(
  file: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    ["bunx", "oxlint", "-c", oxlintrc, "-f", "json", file],
    {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function findingsForRule(stdout: string): unknown[] {
  const parsed = JSON.parse(stdout) as OxlintJson;
  return (parsed.diagnostics ?? []).filter((item) => item.code === ruleCode);
}

test("oxlint reports bare mock.module in a *.test.ts file", async () => {
  const dir = await mkdtemp(
    join(import.meta.dirname, "oxlint-mock-module-banned-"),
  );
  const file = join(dir, "banned.test.ts");
  try {
    await writeFile(
      file,
      `import { mock } from "bun:test";
mock.module("./example.js", () => ({}));
`,
    );
    const { stdout, stderr } = await runOxlint(file);
    expect(findingsForRule(stdout).length, stderr || stdout).toBeGreaterThan(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("oxlint is clean when a *.test.ts file only uses withMockedModule", async () => {
  const dir = await mkdtemp(
    join(import.meta.dirname, "oxlint-mock-module-clean-"),
  );
  const file = join(dir, "clean.test.ts");
  try {
    await writeFile(
      file,
      `import { withMockedModule } from "../helpers/mock-module.ts";
await withMockedModule("./example.js", () => ({}));
`,
    );
    const { stdout, stderr } = await runOxlint(file);
    expect(findingsForRule(stdout), stderr || stdout).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
