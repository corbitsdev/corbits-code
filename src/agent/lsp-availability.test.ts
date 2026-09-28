import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectLanguageServerAvailable } from "./lsp-availability.js";

const dirsToClean: string[] = [];

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "corbits-lsp-availability-"));
  dirsToClean.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    dirsToClean
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function seedTsserver(dir: string): Promise<void> {
  const tsserverDir = path.join(dir, "node_modules", "typescript", "lib");
  await mkdir(tsserverDir, { recursive: true });
  await writeFile(path.join(tsserverDir, "tsserver.js"), "");
}

describe("detectLanguageServerAvailable", () => {
  test("false when typescript is not installed in the project", async () => {
    const dir = await tempProject();
    expect(detectLanguageServerAvailable(dir)).toBe(false);
  });

  test("true when tsserver is resolvable and a local .bin binary exists", async () => {
    const dir = await tempProject();
    await seedTsserver(dir);
    const bin = path.join(
      dir,
      "node_modules",
      ".bin",
      "typescript-language-server",
    );
    await mkdir(path.dirname(bin), { recursive: true });
    await writeFile(bin, "#!/usr/bin/env node\n");
    expect(detectLanguageServerAvailable(dir)).toBe(true);
  });
});
