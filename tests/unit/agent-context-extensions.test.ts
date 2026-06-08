import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAgentContextExtensions } from "../../src/run-agent.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentsmd-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("AGENTS.md present and non-empty returns content with prefix", async () => {
  const content = "Do the thing.\n";
  await writeFile(join(dir, "AGENTS.md"), content);
  const result = await loadAgentContextExtensions(dir);
  expect(result).toHaveLength(1);
  expect(result[0]).toBe(`## AGENTS.md\n\n${content}`);
});

test("AGENTS.md absent returns empty array without throwing", async () => {
  const result = await loadAgentContextExtensions(dir);
  expect(result).toHaveLength(0);
});

test("AGENTS.md exceeds 32000 bytes is truncated to 32000 bytes", async () => {
  const MAX = 32_000;
  const content = "x".repeat(MAX + 500);
  await writeFile(join(dir, "AGENTS.md"), content);
  const result = await loadAgentContextExtensions(dir);
  expect(result).toHaveLength(1);
  const prefix = "## AGENTS.md\n\n";
  expect(result[0]).toBe(`${prefix}${"x".repeat(MAX)}`);
});

test("AGENTS.md empty (whitespace only) returns empty array", async () => {
  await writeFile(join(dir, "AGENTS.md"), "   \n  ");
  const result = await loadAgentContextExtensions(dir);
  expect(result).toHaveLength(0);
});

test("non-ENOENT read error returns empty array without throwing", async () => {
  // Pass a path where AGENTS.md is a directory (can't be read as a file).
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "AGENTS.md"));
  const result = await loadAgentContextExtensions(dir);
  expect(result).toHaveLength(0);
});
