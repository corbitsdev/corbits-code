import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, rm, symlink, mkdtemp } from "node:fs/promises";
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
  test("lists entries in a workspace-relative directory when prefix is a dir path with trailing slash", async () => {
    const results = await listAtSuggestions("src/", fixture);
    expect(results).toContain("src/index.ts");
    expect(results).toContain("src/index.test.ts");
    expect(results).toContain("src/utils/");
  });

  test("filters by basename fragment", async () => {
    const results = await listAtSuggestions("src/index", fixture);
    expect(results).toContain("src/index.ts");
    expect(results).toContain("src/index.test.ts");
    expect(results.every((r) => r.includes("index"))).toBe(true);
  });

  test("appends / to directories", async () => {
    const results = await listAtSuggestions("", fixture);
    const dirs = results.filter((r) => r.endsWith("/"));
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs).toContain("src/");
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

  test("does not browse absolute paths", async () => {
    expect(await listAtSuggestions(fixture + "/", fixture)).toEqual([]);
  });

  test("does not browse home-relative paths", async () => {
    expect(await listAtSuggestions("~/", fixture)).toEqual([]);
  });

  test("does not follow symlinked directories outside the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "at-mention-list-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "");
      await symlink(outside, join(fixture, "escape"));

      expect(await listAtSuggestions("escape/", fixture)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(join(fixture, "escape"), { force: true });
    }
  });

  test("returns [] for a path with no matching entries", async () => {
    expect(await listAtSuggestions("src/zzz", fixture)).toEqual([]);
  });

  test("caps results at 20", async () => {
    // Create 25 files in a temp subdir
    const many = join(fixture, "many");
    await mkdir(many, { recursive: true });
    for (let i = 0; i < 25; i++) {
      await writeFile(join(many, `file${i}.ts`), "");
    }
    const results = await listAtSuggestions("many/", fixture);
    expect(results.length).toBeLessThanOrEqual(20);
  });
});
