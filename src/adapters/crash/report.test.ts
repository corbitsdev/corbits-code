import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectSessionsRoot } from "../../session/project-key.js";
import { crashReportDir, primeCrashReporting, writeCrashReport } from "./report.js";

let home: string | undefined;

afterEach(async () => {
  if (home !== undefined) {
    await rm(home, { recursive: true, force: true });
    home = undefined;
  }
});

describe("primeCrashReporting", () => {
  test("resolves the project root exactly once; crashReportDir never re-resolves it", () => {
    home = "/tmp/corbits-crash-key-check";
    let resolverCalls = 0;
    primeCrashReporting("/Users/dev/some project!!", home, (_cwd, h) => {
      resolverCalls += 1;
      return join(h, "primed-root");
    });
    expect(resolverCalls).toBe(1);

    const first = crashReportDir(home);
    const second = crashReportDir(home);
    expect(resolverCalls).toBe(1); // reading the cached dir does no further resolution
    expect(first).toBe(second);
    expect(first).toBe(join(home, "primed-root", "errors"));
  });

  test("a resolver that throws (simulating a hung or failing git) never propagates and never runs again", () => {
    home = "/tmp/corbits-crash-key-check-2";
    let resolverCalls = 0;
    primeCrashReporting("/Users/dev/some project!!", home, () => {
      resolverCalls += 1;
      throw new Error("git hung");
    });
    expect(resolverCalls).toBe(1);

    // The crash path must fall back without ever calling the resolver again.
    const dir = crashReportDir(home);
    expect(resolverCalls).toBe(1);
    expect(dir).toContain("unresolved");
  });

  test("matches the real project-key scheme when given the real resolver", () => {
    home = "/tmp/corbits-crash-key-check-3";
    const cwd = "/Users/dev/some project!!";
    primeCrashReporting(cwd, home);
    expect(crashReportDir(home)).toBe(join(projectSessionsRoot(cwd, home), "errors"));
  });
});

describe("writeCrashReport", () => {
  test("writes a report under the primed project directory", async () => {
    home = await mkdtemp(join(tmpdir(), "corbits-crash-"));
    const cwd = "/Users/dev/some project!!";
    primeCrashReporting(cwd, home);
    const file = await writeCrashReport("uncaughtException", new Error("boom"), cwd, home);

    expect(file).not.toBeNull();
    const dir = crashReportDir(home);
    const entries = await readdir(dir);
    expect(entries).toHaveLength(1);

    const body = await readFile(join(dir, entries[0]!), "utf8");
    expect(body).toContain("kind: uncaughtException");
    expect(body).toContain(`cwd: ${cwd}`);
    expect(body).toContain("boom");
  });

  test("returns null instead of throwing when the report cannot be written", async () => {
    // A path segment that is a file, not a directory, makes mkdir fail.
    home = await mkdtemp(join(tmpdir(), "corbits-crash-"));
    primeCrashReporting("/Users/dev/some project!!", home, () => join(home!, "blocked-root"));
    await Bun.write(join(home, "blocked-root"), "not a directory");
    const file = await writeCrashReport("unhandledRejection", "oops", "/whatever", home);
    expect(file).toBeNull();
  });
});
