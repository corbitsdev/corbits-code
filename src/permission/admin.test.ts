import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SETTINGS_DIR_NAME } from "../branding.js";
import { generateSessionId, initSessionDir } from "../session/index.js";
import { loadSeededApprovals } from "../session/runtime-assembly.js";
import { createPermissionsAdmin } from "./admin.js";
import { createPermissionGate } from "./gate.js";
import * as permissionStore from "./store.js";

describe("createPermissionsAdmin --permissions reseed", () => {
  let cwd = "";
  let home = "";

  afterEach(async () => {
    mock.restore();
    if (cwd !== "") await rm(cwd, { recursive: true, force: true });
    if (home !== "") await rm(home, { recursive: true, force: true });
    cwd = "";
    home = "";
  });

  test("revoking a project grant keeps the file grant and does not restore or edit user grants", async () => {
    cwd = await mkdtemp(join(tmpdir(), "perm-admin-"));
    home = await mkdtemp(join(tmpdir(), "perm-admin-home-"));
    const sessionId = generateSessionId();
    await initSessionDir(cwd, sessionId, home);

    await permissionStore.saveGlobalApproval(
      { tool: "run_shell", pattern: "global-only git *" },
      home,
    );
    await permissionStore.saveProviderModelApproval(
      "openai:gpt-5",
      { tool: "run_shell", pattern: "provider-only npm *" },
      home,
    );
    await permissionStore.saveProjectApproval(
      cwd,
      { tool: "run_shell", pattern: "project keep *" },
      home,
    );
    await permissionStore.saveProjectApproval(
      cwd,
      { tool: "run_shell", pattern: "project drop *" },
      home,
    );
    const permissionsPath = join(cwd, "grants.json");
    await writeFile(
      permissionsPath,
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
    const userStorePath = join(home, SETTINGS_DIR_NAME, "permissions.json");
    const userStoreBefore = await readFile(userStorePath, "utf-8");

    const seeded = await loadSeededApprovals(cwd, sessionId, home, {
      permissionsPath,
    });
    const gate = createPermissionGate({
      approvals: seeded,
      cwd,
      interactive: false,
      skipPermissions: false,
      reactorGated: false,
    });

    // homedir() is cached, so a no-arg reload of the user store would not see
    // this temp home — and a no-arg remove would edit the real user file.
    // Surface either call as the sentinel grant / a throw instead.
    spyOn(permissionStore, "loadGlobalApprovals").mockResolvedValue([
      { tool: "run_shell", pattern: "global-only git *" },
    ]);
    spyOn(permissionStore, "loadProviderModelApprovals").mockResolvedValue([
      {
        tool: "run_shell",
        pattern: "provider-only npm *",
        providerModel: "openai:gpt-5",
      },
    ]);
    const removeGlobal = spyOn(
      permissionStore,
      "removeGlobalApproval",
    ).mockImplementation(() => {
      throw new Error("user global store must not be mutated");
    });
    const removeProvider = spyOn(
      permissionStore,
      "removeProviderModelApproval",
    ).mockImplementation(() => {
      throw new Error("user provider-model store must not be mutated");
    });

    const admin = createPermissionsAdmin(gate, cwd, { permissionsPath, home });
    await admin.revoke({
      scope: "project",
      tool: "run_shell",
      pattern: "project drop *",
    });

    const patterns = gate.getApprovals().map((approval) => approval.pattern);
    expect(patterns).toContain("bun install*");
    expect(patterns).toContain("scoped cargo *");
    expect(patterns).toContain("project keep *");
    expect(patterns).not.toContain("project drop *");
    expect(patterns).not.toContain("global-only git *");
    expect(patterns).not.toContain("provider-only npm *");
    expect(removeGlobal).not.toHaveBeenCalled();
    expect(removeProvider).not.toHaveBeenCalled();
    expect(await readFile(userStorePath, "utf-8")).toBe(userStoreBefore);

    const listed = await admin.list();
    const fileRow = listed.find((entry) => entry.pattern === "bun install*");
    expect(fileRow).toEqual({
      scope: "global",
      tool: "run_shell",
      pattern: "bun install*",
    });
    await admin.revoke({
      scope: "global",
      tool: "run_shell",
      pattern: "bun install*",
    });
    await admin.revoke({
      scope: "provider-model",
      tool: "run_shell",
      pattern: "scoped cargo *",
      providerModel: "openai:gpt-5",
    });

    const afterFileRevoke = gate
      .getApprovals()
      .map((approval) => approval.pattern);
    expect(afterFileRevoke).not.toContain("bun install*");
    expect(afterFileRevoke).not.toContain("scoped cargo *");
    expect(afterFileRevoke).toContain("project keep *");
    expect(afterFileRevoke).not.toContain("global-only git *");
    expect(afterFileRevoke).not.toContain("provider-only npm *");
    expect(removeGlobal).not.toHaveBeenCalled();
    expect(removeProvider).not.toHaveBeenCalled();
    expect(await readFile(userStorePath, "utf-8")).toBe(userStoreBefore);

    const fileAfter = JSON.parse(await readFile(permissionsPath, "utf-8")) as {
      approvals: { tool: string; pattern: string }[];
      providerModels?: unknown;
    };
    expect(fileAfter.approvals).toEqual([]);
    expect(fileAfter.providerModels).toBeUndefined();

    const reseeded = await loadSeededApprovals(cwd, sessionId, home, {
      permissionsPath,
    });
    const reseededPatterns = reseeded.map((approval) => approval.pattern);
    expect(reseededPatterns).not.toContain("bun install*");
    expect(reseededPatterns).not.toContain("scoped cargo *");
    expect(reseededPatterns).toContain("project keep *");
    expect(reseededPatterns).not.toContain("global-only git *");
  });
});
