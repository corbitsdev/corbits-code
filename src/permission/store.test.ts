import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadGlobalApprovals,
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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "perm-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("project store", () => {
  test("round-trips approvals at <cwd>/.corbits/permissions.json", async () => {
    expect(await loadProjectApprovals(dir)).toEqual([]);
    await saveProjectApproval(dir, { tool: "run_shell", pattern: "npm *" });
    await saveProjectApproval(dir, { tool: "write_file", pattern: "src/*" });
    expect(await loadProjectApprovals(dir)).toEqual([
      { tool: "run_shell", pattern: "npm *" },
      { tool: "write_file", pattern: "src/*" },
    ]);
  });

  test("drops an over-broad pattern at load so a poisoned file cannot over-grant", async () => {
    await saveProjectApproval(dir, { tool: "run_shell", pattern: "*" });
    await saveProjectApproval(dir, { tool: "run_shell", pattern: "npm *" });
    expect(await loadProjectApprovals(dir)).toEqual([{ tool: "run_shell", pattern: "npm *" }]);
  });

  test("removeProjectApproval drops only the matching entry", async () => {
    await saveProjectApproval(dir, { tool: "run_shell", pattern: "npm *" });
    await saveProjectApproval(dir, { tool: "write_file", pattern: "src/*" });
    await removeProjectApproval(dir, { tool: "run_shell", pattern: "npm *" });
    expect(await loadProjectApprovals(dir)).toEqual([{ tool: "write_file", pattern: "src/*" }]);
  });
});

describe("revocation across the shared global file", () => {
  test("removeGlobalApproval leaves provider-model grants intact", async () => {
    await saveGlobalApproval({ tool: "run_shell", pattern: "git *" }, dir);
    await saveProviderModelApproval("openai:gpt-5", { tool: "run_shell", pattern: "npm *" }, dir);
    await removeGlobalApproval({ tool: "run_shell", pattern: "git *" }, dir);
    expect(await loadGlobalApprovals(dir)).toEqual([]);
    expect(await loadProviderModelApprovals(dir)).toEqual([
      { tool: "run_shell", pattern: "npm *", providerModel: "openai:gpt-5" },
    ]);
  });

  test("removeProviderModelApproval drops only that key's entry", async () => {
    await saveProviderModelApproval("openai:gpt-5", { tool: "run_shell", pattern: "npm *" }, dir);
    await saveProviderModelApproval("anthropic:opus", { tool: "run_shell", pattern: "ls *" }, dir);
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
    expect(await loadGlobalApprovals(dir)).toEqual([{ tool: "run_shell", pattern: "git *" }]);
  });
});

describe("provider-model store", () => {
  test("keys approvals by providerModel and tags them on load", async () => {
    expect(await loadProviderModelApprovals(dir)).toEqual([]);
    await saveProviderModelApproval("openai:gpt-5", { tool: "run_shell", pattern: "npm *" }, dir);
    await saveProviderModelApproval("anthropic:opus", { tool: "run_shell", pattern: "ls *" }, dir);
    const loaded = await loadProviderModelApprovals(dir);
    expect(loaded).toContainEqual({ tool: "run_shell", pattern: "npm *", providerModel: "openai:gpt-5" });
    expect(loaded).toContainEqual({ tool: "run_shell", pattern: "ls *", providerModel: "anthropic:opus" });
  });

  test("global and provider-model grants share one file without clobbering", async () => {
    await saveGlobalApproval({ tool: "run_shell", pattern: "git *" }, dir);
    await saveProviderModelApproval("openai:gpt-5", { tool: "run_shell", pattern: "npm *" }, dir);
    expect(await loadGlobalApprovals(dir)).toEqual([{ tool: "run_shell", pattern: "git *" }]);
    expect(await loadProviderModelApprovals(dir)).toEqual([
      { tool: "run_shell", pattern: "npm *", providerModel: "openai:gpt-5" },
    ]);
  });
});
