import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

// bun test ./tests collects leftover *.test.ts under tests/; keep fixtures off that glob.
async function withFixture(
  prefix: string,
  name: string,
  source: string,
  run: (file: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const file = join(dir, name);
  try {
    await writeFile(file, source);
    await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("oxlint reports bare mock.module in a *.test.ts file", async () => {
  await withFixture(
    "oxlint-mock-module-banned-",
    "banned.test.ts",
    `import { mock } from "bun:test";
mock.module("./example.js", () => ({}));
`,
    async (file) => {
      const { stdout, stderr } = await runOxlint(file);
      expect(findingsForRule(stdout).length, stderr || stdout).toBeGreaterThan(
        0,
      );
    },
  );
});

test("oxlint is clean when a *.test.ts file only uses withMockedModule", async () => {
  await withFixture(
    "oxlint-mock-module-clean-",
    "clean.test.ts",
    `import { withMockedModule } from "../helpers/mock-module.ts";
await withMockedModule("./example.js", () => ({}));
`,
    async (file) => {
      const { stdout, stderr } = await runOxlint(file);
      expect(findingsForRule(stdout), stderr || stdout).toEqual([]);
    },
  );
});
