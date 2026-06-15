import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasTestFiles } from "./critic.js";

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), "critic-test-"));
}

describe("hasTestFiles", () => {
  test("finds test files in the workspace", async () => {
    const dir = await fixture();
    try {
      await writeFile(join(dir, "example.test.ts"), "test('x', () => {});\n");
      expect(await hasTestFiles(dir)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ignores heavy generated and dependency directories", async () => {
    const dir = await fixture();
    try {
      await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
      await mkdir(join(dir, "dist"), { recursive: true });
      await writeFile(join(dir, "node_modules", "pkg", "hidden.test.ts"), "test('x', () => {});\n");
      await writeFile(join(dir, "dist", "bundle.test.ts"), "test('x', () => {});\n");

      expect(await hasTestFiles(dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
