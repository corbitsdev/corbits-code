import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAtSuggestions } from "./list.js";

const fixture = join(tmpdir(), "at-mention-list-test-" + process.pid);

beforeAll(async () => {
  await mkdir(join(fixture, "src/utils"), { recursive: true });
  await mkdir(join(fixture, "tests"), { recursive: true });
  await writeFile(join(fixture, "src", "index.ts"), "");
  await writeFile(join(fixture, "src", "index.test.ts"), "");
  await writeFile(join(fixture, "src", "utils", "helper.ts"), "");
  await writeFile(join(fixture, "README.md"), "");
});

afterAll(async () => {
  await rm(fixture, { recursive: true, force: true });
});

describe("listAtSuggestions", () => {
  test("lists entries in a directory when prefix is a dir path with trailing slash", async () => {
    const results = await listAtSuggestions(fixture + "/", fixture);
    expect(results).toContain(fixture + "/src/");
    expect(results).toContain(fixture + "/tests/");
    expect(results).toContain(fixture + "/README.md");
  });

  test("filters by basename fragment", async () => {
    const results = await listAtSuggestions(fixture + "/src/index", fixture);
    expect(results).toContain(fixture + "/src/index.ts");
    expect(results).toContain(fixture + "/src/index.test.ts");
    expect(results.every((r) => r.includes("index"))).toBe(true);
  });

  test("appends / to directories", async () => {
    const results = await listAtSuggestions(fixture + "/", fixture);
    const dirs = results.filter((r) => r.endsWith("/"));
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs).toContain(fixture + "/src/");
  });

  test("empty prefix lists cwd (@ alone)", async () => {
    const results = await listAtSuggestions("", fixture);
    expect(results).toContain("src/");
    expect(results).toContain("tests/");
    expect(results).toContain("README.md");
    // Results should NOT include parent-directory entries
    expect(results.every((r) => !r.startsWith("/"))).toBe(true);
  });

  test("bare fragment filters cwd entries", async () => {
    const results = await listAtSuggestions("RE", fixture);
    expect(results).toContain("README.md");
    expect(results.every((r) => r.startsWith("RE"))).toBe(true);
  });

  test("resolves bare path with slash relative to cwd", async () => {
    const results = await listAtSuggestions("src/", fixture);
    expect(results).toContain("src/index.ts");
    expect(results).toContain("src/index.test.ts");
    expect(results).toContain("src/utils/");
  });

  test("returns [] for a nonexistent path", async () => {
    expect(await listAtSuggestions("/nonexistent-path-12345/", fixture)).toEqual([]);
  });

  test("returns [] for a path with no matching entries", async () => {
    expect(await listAtSuggestions(fixture + "/src/zzz", fixture)).toEqual([]);
  });

  test("caps results at 20", async () => {
    // Create 25 files in a temp subdir
    const many = join(fixture, "many");
    await mkdir(many, { recursive: true });
    for (let i = 0; i < 25; i++) {
      await writeFile(join(many, `file${i}.ts`), "");
    }
    const results = await listAtSuggestions(many + "/", fixture);
    expect(results.length).toBeLessThanOrEqual(20);
  });
});
