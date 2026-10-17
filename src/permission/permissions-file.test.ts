import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLogger } from "@intx/log";

import { LOG_NAMESPACE_ROOT } from "../branding.js";
import { canonicalGrantFilePath, loadPermissionsFile } from "./store.js";

const grantsFileLog = getLogger([
  LOG_NAMESPACE_ROOT,
  "permission",
  "grants-file",
]);

describe("grant-file canonical logging", () => {
  let dir = "";

  beforeEach(() => {
    spyOn(grantsFileLog, "info");
  });

  afterEach(async () => {
    mock.restore();
    if (dir !== "") await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  test("loading through a symlink logs the canonical realpath target", async () => {
    dir = await mkdtemp(join(tmpdir(), "grants-file-"));
    const target = join(dir, "grants.json");
    await writeFile(
      target,
      JSON.stringify({
        approvals: [
          { tool: "run_shell", pattern: "bun install*" },
          {
            tool: "run_shell",
            pattern: "scoped cargo *",
            providerModel: "openai:gpt-5",
          },
        ],
      }),
    );
    const link = join(dir, "link.json");
    await symlink(target, link);

    const approvals = await loadPermissionsFile(link);

    expect(approvals).toHaveLength(2);
    expect(grantsFileLog.info).toHaveBeenCalledWith(
      "Grant file loaded: {path} ({count} approvals)",
      { path: await realpath(link), count: 2 },
    );
  });

  test("a file without an approvals key logs an empty load", async () => {
    dir = await mkdtemp(join(tmpdir(), "grants-file-"));
    const path = join(dir, "grants.json");
    await writeFile(path, JSON.stringify({}));

    const approvals = await loadPermissionsFile(path);

    expect(approvals).toEqual([]);
    expect(grantsFileLog.info).toHaveBeenCalledWith(
      "Grant file loaded: {path} ({count} approvals)",
      { path: await realpath(path), count: 0 },
    );
  });

  test("a missing file fails closed without a load log", async () => {
    dir = await mkdtemp(join(tmpdir(), "grants-file-"));

    await expect(
      loadPermissionsFile(join(dir, "missing.json")),
    ).rejects.toThrow(/not found/);
    expect(grantsFileLog.info).not.toHaveBeenCalled();
  });

  test("canonicalGrantFilePath falls back to the given path when unreadable", async () => {
    dir = await mkdtemp(join(tmpdir(), "grants-file-"));
    const missing = join(dir, "missing.json");

    await expect(canonicalGrantFilePath(missing)).resolves.toBe(missing);
  });
});
