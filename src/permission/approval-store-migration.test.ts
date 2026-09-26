import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateSessionId, sessionDir } from "../session/index.js";
import { loadSeededApprovals } from "../session/runtime-assembly.js";
import { normalizeSeededApprovals } from "./authz-grants.js";
import { migratePersistedApprovalStores } from "./approval-store-migration.js";
import { saveGlobalApproval } from "./store.js";

let cwd = "";
let home = "";
let sessionId = "";

const sessionStorePath = (): string =>
  join(sessionDir(cwd, sessionId, home), "permissions.json");
const projectStorePath = (): string =>
  join(cwd, ".corbits", "permissions.json");
const globalStorePath = (): string =>
  join(home, ".corbits", "permissions.json");
const backupPath = (path: string): string => `${path}.bak`;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf-8")) as unknown;
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "approval-migration-"));
  home = await mkdtemp(join(tmpdir(), "approval-migration-home-"));
  sessionId = generateSessionId();
  await mkdir(sessionDir(cwd, sessionId, home), { recursive: true });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("migratePersistedApprovalStores", () => {
  test("purges update_plan keys from every store, backs up, and re-runs as a no-op", async () => {
    const sessionOriginal = {
      approvals: [
        { tool: "update_plan", pattern: "plan *" },
        { tool: "run_shell", pattern: "npm *" },
        { tool: "bash", pattern: "git *" },
      ],
    };
    const projectOriginal = {
      approvals: [
        { tool: "update_plan", pattern: "plan *" },
        { tool: "manage_tasks", pattern: "tasks *" },
      ],
    };
    const globalOriginal = {
      approvals: [
        { tool: "update_plan", pattern: "plan *" },
        { tool: "run_shell", pattern: "git *" },
      ],
      providerModels: {
        "openai:gpt-5": [
          { tool: "update_plan", pattern: "plan *" },
          { tool: "run_shell", pattern: "npm *" },
        ],
        "anthropic:opus": [{ tool: "run_shell", pattern: "ls *" }],
      },
    };
    await writeFile(sessionStorePath(), JSON.stringify(sessionOriginal));
    await mkdir(join(cwd, ".corbits"), { recursive: true });
    await writeFile(projectStorePath(), JSON.stringify(projectOriginal));
    await mkdir(join(home, ".corbits"), { recursive: true });
    await writeFile(globalStorePath(), JSON.stringify(globalOriginal));

    const first = await migratePersistedApprovalStores(cwd, sessionId, home);

    expect(first.purged).toBe(4);
    expect(first.backups).toHaveLength(3);

    expect(await readJson(sessionStorePath())).toEqual({
      approvals: [
        { tool: "run_shell", pattern: "npm *" },
        { tool: "bash", pattern: "git *" },
      ],
    });
    expect(await readJson(projectStorePath())).toEqual({
      approvals: [{ tool: "manage_tasks", pattern: "tasks *" }],
    });
    expect(await readJson(globalStorePath())).toEqual({
      approvals: [{ tool: "run_shell", pattern: "git *" }],
      providerModels: {
        "openai:gpt-5": [{ tool: "run_shell", pattern: "npm *" }],
        "anthropic:opus": [{ tool: "run_shell", pattern: "ls *" }],
      },
    });

    for (const [path, original] of [
      [sessionStorePath(), sessionOriginal],
      [projectStorePath(), projectOriginal],
      [globalStorePath(), globalOriginal],
    ] as const) {
      expect(await readJson(backupPath(path))).toEqual(original);
    }

    const sessionAfterFirst = await readFile(sessionStorePath(), "utf-8");
    const second = await migratePersistedApprovalStores(cwd, sessionId, home);
    expect(second.purged).toBe(0);
    expect(second.backups).toEqual([]);
    expect(await readFile(sessionStorePath(), "utf-8")).toBe(sessionAfterFirst);
  });

  test("leaves clean stores untouched with no backup written", async () => {
    const sessionOriginal = {
      approvals: [{ tool: "run_shell", pattern: "npm *" }],
    };
    await writeFile(sessionStorePath(), JSON.stringify(sessionOriginal));

    const result = await migratePersistedApprovalStores(cwd, sessionId, home);

    expect(result.purged).toBe(0);
    expect(result.backups).toEqual([]);
    expect(await readJson(sessionStorePath())).toEqual(sessionOriginal);
    await expect(
      readFile(backupPath(sessionStorePath()), "utf-8"),
    ).rejects.toThrow();
  });

  test("treats missing and corrupt stores as no-ops", async () => {
    await mkdir(join(cwd, ".corbits"), { recursive: true });
    await writeFile(projectStorePath(), "not json{{{");

    const result = await migratePersistedApprovalStores(cwd, sessionId, home);

    expect(result.purged).toBe(0);
    expect(result.backups).toEqual([]);
    expect(await readFile(projectStorePath(), "utf-8")).toBe("not json{{{");
  });

  test("purges exactly the keys the load-time normalizer drops", async () => {
    const tools = [
      "update_plan",
      "Update_Plan",
      "default.update_plan",
      "manage_tasks",
      "run_shell",
    ];
    await writeFile(
      sessionStorePath(),
      JSON.stringify({
        approvals: tools.map((tool) => ({ tool, pattern: "x *" })),
      }),
    );

    const result = await migratePersistedApprovalStores(cwd, sessionId, home);

    const seeded = tools.map((tool) => ({ tool, pattern: "x *" }));
    const droppedByNormalizer = seeded.filter(
      (approval) =>
        !normalizeSeededApprovals([approval]).some(
          (kept: { tool: string }) => kept.tool === approval.tool,
        ),
    );
    expect(result.purged).toBe(droppedByNormalizer.length);
    expect(result.purged).toBe(3);
    const remaining = (
      (await readJson(sessionStorePath())) as {
        approvals: { tool: string }[];
      }
    ).approvals.map((approval) => approval.tool);
    expect(remaining).toEqual(["manage_tasks", "run_shell"]);
  });

  test("a grant minted while the migration runs is not lost and the file stays valid", async () => {
    await mkdir(join(home, ".corbits"), { recursive: true });
    await writeFile(
      globalStorePath(),
      JSON.stringify({
        approvals: [
          { tool: "update_plan", pattern: "plan *" },
          { tool: "run_shell", pattern: "git *" },
        ],
      }),
    );

    const minted = { tool: "run_shell", pattern: "npm *" };
    const [result] = await Promise.all([
      migratePersistedApprovalStores(cwd, sessionId, home),
      saveGlobalApproval(minted, home),
    ]);

    expect(result.purged).toBe(1);
    const final = (await readJson(globalStorePath())) as {
      approvals: { tool: string; pattern: string }[];
    };
    expect(
      final.approvals.some((approval) => approval.tool === "update_plan"),
    ).toBe(false);
    expect(final.approvals).toContainEqual({
      tool: "run_shell",
      pattern: "git *",
    });
    expect(final.approvals).toContainEqual(minted);
    const backup = (await readJson(backupPath(globalStorePath()))) as {
      approvals: { tool: string; pattern: string }[];
    };
    expect(backup.approvals).toContainEqual({
      tool: "update_plan",
      pattern: "plan *",
    });
  });

  test("a storm of concurrent grants around the migration loses nothing", async () => {
    await mkdir(join(home, ".corbits"), { recursive: true });
    await writeFile(
      globalStorePath(),
      JSON.stringify({
        approvals: [{ tool: "update_plan", pattern: "plan *" }],
      }),
    );

    const minted = Array.from({ length: 10 }, (_, i) => ({
      tool: "run_shell",
      pattern: `storm-${i} *`,
    }));
    await Promise.all([
      migratePersistedApprovalStores(cwd, sessionId, home),
      ...minted.map((approval) => saveGlobalApproval(approval, home)),
    ]);

    const final = (await readJson(globalStorePath())) as {
      approvals: { tool: string; pattern: string }[];
    };
    expect(
      final.approvals.some((approval) => approval.tool === "update_plan"),
    ).toBe(false);
    for (const approval of minted) {
      expect(final.approvals).toContainEqual(approval);
    }
  });

  test("seed loading purges on-disk update_plan keys while the normalizer still drops them in memory", async () => {
    await writeFile(
      sessionStorePath(),
      JSON.stringify({
        approvals: [
          { tool: "update_plan", pattern: "plan *" },
          { tool: "run_shell", pattern: "npm *" },
        ],
      }),
    );
    await mkdir(join(cwd, ".corbits"), { recursive: true });
    await writeFile(
      projectStorePath(),
      JSON.stringify({
        approvals: [{ tool: "update_plan", pattern: "plan *" }],
      }),
    );

    const seeded = await loadSeededApprovals(cwd, sessionId, home);

    expect(seeded).toEqual(
      expect.arrayContaining([{ tool: "run_shell", pattern: "npm *" }]),
    );
    expect(seeded.some((approval) => approval.tool === "update_plan")).toBe(
      false,
    );
    expect(await readJson(sessionStorePath())).toEqual({
      approvals: [{ tool: "run_shell", pattern: "npm *" }],
    });
    expect(await readJson(projectStorePath())).toEqual({ approvals: [] });
  });

  test("EACCES writing the backup leaves live bytes unchanged", async () => {
    const path = sessionStorePath();
    const original = {
      approvals: [
        { tool: "update_plan", pattern: "plan *" },
        { tool: "run_shell", pattern: "npm *" },
      ],
    };
    await writeFile(path, JSON.stringify(original));
    const liveBytes = await readFile(path, "utf-8");
    const dir = dirname(path);
    await chmod(dir, 0o555);
    try {
      const result = await migratePersistedApprovalStores(cwd, sessionId, home);
      expect(result.purged).toBe(0);
      expect(result.backups).toEqual([]);
      expect(await readFile(path, "utf-8")).toBe(liveBytes);
    } finally {
      await chmod(dir, 0o755);
    }
  });

  test("existing torn .bak plus live update_plan still purges live", async () => {
    const path = sessionStorePath();
    const original = {
      approvals: [
        { tool: "update_plan", pattern: "plan *" },
        { tool: "run_shell", pattern: "npm *" },
      ],
    };
    await writeFile(path, JSON.stringify(original));
    const torn = '{"approvals":[{"tool":"update_plan"';
    await writeFile(backupPath(path), torn);

    const result = await migratePersistedApprovalStores(cwd, sessionId, home);

    expect(result.purged).toBe(1);
    expect(result.backups).toEqual([backupPath(path)]);
    expect(await readFile(backupPath(path), "utf-8")).toBe(torn);
    expect(await readJson(path)).toEqual({
      approvals: [{ tool: "run_shell", pattern: "npm *" }],
    });
  });
});
