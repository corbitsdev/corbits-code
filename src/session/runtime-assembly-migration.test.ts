import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withMockedModuleDuring } from "../../tests/helpers/mock-module.js";
import type * as migrationModule from "../permission/approval-store-migration.js";
import { generateSessionId, initSessionDir, sessionDir } from "./index.js";

describe("loadSeededApprovals migration guard", () => {
  let cwd = "";
  let home = "";
  let sessionId = "";

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "migration-guard-"));
    home = await mkdtemp(join(tmpdir(), "migration-guard-home-"));
    sessionId = generateSessionId();
    await initSessionDir(cwd, sessionId, home);
  });

  afterEach(async () => {
    if (cwd !== "") await rm(cwd, { recursive: true, force: true });
    if (home !== "") await rm(home, { recursive: true, force: true });
    cwd = "";
    home = "";
    sessionId = "";
  });

  test("session start proceeds when the migration throws", async () => {
    await mkdir(sessionDir(cwd, sessionId, home), { recursive: true });
    await writeFile(
      join(sessionDir(cwd, sessionId, home), "permissions.json"),
      JSON.stringify({
        approvals: [{ tool: "run_shell", pattern: "session npm *" }],
      }),
    );

    let migrationCalls = 0;
    const seeded = await withMockedModuleDuring(
      import.meta.resolve("../permission/approval-store-migration.js"),
      (real: typeof migrationModule) => ({
        ...real,
        migratePersistedApprovalStores: (): Promise<never> => {
          migrationCalls += 1;
          return Promise.reject(new Error("migration boom"));
        },
      }),
      async () => {
        const { loadSeededApprovals } = await import("./runtime-assembly.js");
        return loadSeededApprovals(cwd, sessionId, home);
      },
    );

    expect(migrationCalls).toBe(1);

    expect(seeded).toContainEqual({
      tool: "run_shell",
      pattern: "session npm *",
    });
  });
});
