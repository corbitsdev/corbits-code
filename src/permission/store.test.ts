import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SETTINGS_DIR_NAME } from "../branding.js";
import {
  loadGlobalApprovals,
  loadPendingProjectApprovals,
  loadProjectApprovals,
  loadProviderModelApprovals,
  saveGlobalApproval,
  saveProjectApproval,
  saveProviderModelApproval,
  removeProjectApproval,
  removeGlobalApproval,
  removeProviderModelApproval,
} from "./store.js";

let dir: string;
let home: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "perm-store-"));
  home = await mkdtemp(join(tmpdir(), "perm-store-home-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("project store", () => {
  test("round-trips approvals at <cwd>/.corbits/permissions.json", async () => {
    expect(await loadProjectApprovals(dir, home)).toEqual([]);
    await saveProjectApproval(
      dir,
      { tool: "run_shell", pattern: "npm *" },
      home,
    );
    await saveProjectApproval(
      dir,
      { tool: "write_file", pattern: "src/*" },
      home,
    );
    expect(await loadProjectApprovals(dir, home)).toEqual([
      { tool: "run_shell", pattern: "npm *" },
      { tool: "write_file", pattern: "src/*" },
    ]);
  });

  test("drops an over-broad pattern at load so a poisoned file cannot over-grant", async () => {
    await saveProjectApproval(dir, { tool: "run_shell", pattern: "*" }, home);
    await saveProjectApproval(
      dir,
      { tool: "run_shell", pattern: "npm *" },
      home,
    );
    expect(await loadProjectApprovals(dir, home)).toEqual([
      { tool: "run_shell", pattern: "npm *" },
    ]);
  });

  test("removeProjectApproval drops only the matching entry", async () => {
    await saveProjectApproval(
      dir,
      { tool: "run_shell", pattern: "npm *" },
      home,
    );
    await saveProjectApproval(
      dir,
      { tool: "write_file", pattern: "src/*" },
      home,
    );
    await removeProjectApproval(
      dir,
      { tool: "run_shell", pattern: "npm *" },
      home,
    );
    expect(await loadProjectApprovals(dir, home)).toEqual([
      { tool: "write_file", pattern: "src/*" },
    ]);
  });

  test("an unconfirmed hand-written file contributes zero approvals but stays visible as pending", async () => {
    const settingsDir = join(dir, ".corbits");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      join(settingsDir, "permissions.json"),
      JSON.stringify({
        approvals: [
          { tool: "run_shell", pattern: "npm *" },
          { tool: "write_file" }, // missing pattern
          { pattern: "src/*" }, // missing tool
        ],
      }),
    );
    expect(await loadProjectApprovals(dir, home)).toEqual([]);
    expect(await loadPendingProjectApprovals(dir, home)).toEqual([
      { tool: "run_shell", pattern: "npm *" },
    ]);
  });
});

describe("revocation across the shared global file", () => {
  test("removeGlobalApproval leaves provider-model grants intact", async () => {
    await saveGlobalApproval({ tool: "run_shell", pattern: "git *" }, dir);
    await saveProviderModelApproval(
      "openai:gpt-5",
      { tool: "run_shell", pattern: "npm *" },
      dir,
    );
    await removeGlobalApproval({ tool: "run_shell", pattern: "git *" }, dir);
    expect(await loadGlobalApprovals(dir)).toEqual([]);
    expect(await loadProviderModelApprovals(dir)).toEqual([
      { tool: "run_shell", pattern: "npm *", providerModel: "openai:gpt-5" },
    ]);
  });

  test("removeProviderModelApproval drops only that key's entry", async () => {
    await saveProviderModelApproval(
      "openai:gpt-5",
      { tool: "run_shell", pattern: "npm *" },
      dir,
    );
    await saveProviderModelApproval(
      "anthropic:opus",
      { tool: "run_shell", pattern: "ls *" },
      dir,
    );
    await removeProviderModelApproval(
      "openai:gpt-5",
      { tool: "run_shell", pattern: "npm *", providerModel: "openai:gpt-5" },
      dir,
    );
    expect(await loadProviderModelApprovals(dir)).toEqual([
      { tool: "run_shell", pattern: "ls *", providerModel: "anthropic:opus" },
    ]);
  });
});

describe("global store", () => {
  test("round-trips approvals under the home permissions file", async () => {
    expect(await loadGlobalApprovals(dir)).toEqual([]);
    await saveGlobalApproval({ tool: "run_shell", pattern: "git *" }, dir);
    expect(await loadGlobalApprovals(dir)).toEqual([
      { tool: "run_shell", pattern: "git *" },
    ]);
  });
});

describe("provider-model store", () => {
  test("keys approvals by providerModel and tags them on load", async () => {
    expect(await loadProviderModelApprovals(dir)).toEqual([]);
    await saveProviderModelApproval(
      "openai:gpt-5",
      { tool: "run_shell", pattern: "npm *" },
      dir,
    );
    await saveProviderModelApproval(
      "anthropic:opus",
      { tool: "run_shell", pattern: "ls *" },
      dir,
    );
    const loaded = await loadProviderModelApprovals(dir);
    expect(loaded).toContainEqual({
      tool: "run_shell",
      pattern: "npm *",
      providerModel: "openai:gpt-5",
    });
    expect(loaded).toContainEqual({
      tool: "run_shell",
      pattern: "ls *",
      providerModel: "anthropic:opus",
    });
  });

  test("global and provider-model grants share one file without clobbering", async () => {
    await saveGlobalApproval({ tool: "run_shell", pattern: "git *" }, dir);
    await saveProviderModelApproval(
      "openai:gpt-5",
      { tool: "run_shell", pattern: "npm *" },
      dir,
    );
    expect(await loadGlobalApprovals(dir)).toEqual([
      { tool: "run_shell", pattern: "git *" },
    ]);
    expect(await loadProviderModelApprovals(dir)).toEqual([
      { tool: "run_shell", pattern: "npm *", providerModel: "openai:gpt-5" },
    ]);
  });
});

// A torn (non-JSON) store file must surface, never silently report an empty
// store: the empty read is the first half of read-modify-write, so a swallowed
// corruption reconciles the file's grants away on the next write. Repairs
// always work because the write path refuses to touch the corrupt bytes.
describe("torn store recovery", () => {
  const globalStorePathFor = (): string =>
    join(home, SETTINGS_DIR_NAME, "permissions.json");

  test("a corrupt global store surfaces on load instead of reporting zero grants", async () => {
    await saveGlobalApproval({ tool: "run_shell", pattern: "git *" }, home);
    await writeFile(globalStorePathFor(), "{torn");
    await expect(loadGlobalApprovals(home)).rejects.toThrow(
      /permissions store is corrupt/,
    );
  });

  test("a corrupt provider-model store surfaces on load instead of reporting zero grants", async () => {
    await saveProviderModelApproval(
      "openai:gpt-5",
      { tool: "run_shell", pattern: "npm *" },
      home,
    );
    await writeFile(globalStorePathFor(), "{torn");
    await expect(loadProviderModelApprovals(home)).rejects.toThrow(
      /permissions store is corrupt/,
    );
  });

  test("a later grant write cannot clobber a torn store's prior grants", async () => {
    await saveGlobalApproval({ tool: "run_shell", pattern: "git *" }, home);
    await saveGlobalApproval({ tool: "run_shell", pattern: "npm *" }, home);
    const path = globalStorePathFor();
    const original = await readFile(path, "utf-8");
    // Simulate a torn write: the bytes are a shortened prefix of the store.
    const torn = original.slice(0, Math.max(original.length - 4, 0));
    await writeFile(path, torn);

    await expect(
      saveGlobalApproval({ tool: "run_shell", pattern: "cargo *" }, home),
    ).rejects.toThrow(/permissions store is corrupt/);

    // The failed write left the corrupt bytes untouched for an operator repair.
    expect(await readFile(path, "utf-8")).toBe(torn);

    // Repair regains the prior grants; the deferred grant re-applies on retry.
    await writeFile(path, original);
    await saveGlobalApproval({ tool: "run_shell", pattern: "cargo *" }, home);
    expect(await loadGlobalApprovals(home)).toEqual([
      { tool: "run_shell", pattern: "git *" },
      { tool: "run_shell", pattern: "npm *" },
      { tool: "run_shell", pattern: "cargo *" },
    ]);
  });
});
