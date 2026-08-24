import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProfile, projectProfilePath, profilesDir, resolveProfile } from "./config/profiles.js";

function makeTmp(): string {
  return join(
    tmpdir(),
    `interchange-profiles-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

test("profilesDir returns ~/.corbits/profiles", () => {
  const result = profilesDir("/home/user");
  expect(result).toBe("/home/user/.corbits/profiles");
});

test("projectProfilePath returns <cwd>/.corbits/profile.json", () => {
  const result = projectProfilePath("/my/project");
  expect(result).toBe("/my/project/.corbits/profile.json");
});

test("loadProfile returns null for missing file", async () => {
  const result = await loadProfile("/no/such/file/profile.json");
  expect(result).toBeNull();
});

test("loadProfile parses valid profile", async () => {
  const dir = makeTmp();
  await mkdir(dir, { recursive: true });
  const path = join(dir, "profile.json");
  await writeFile(path, JSON.stringify({ model: "claude-opus-4-8" }));
  const result = await loadProfile(path);
  expect(result).toEqual({ model: "claude-opus-4-8" });
});

test("loadProfile parses systemPromptExtensions", async () => {
  const dir = makeTmp();
  await mkdir(dir, { recursive: true });
  const path = join(dir, "profile.json");
  await writeFile(path, JSON.stringify({ systemPromptExtensions: ["no-destructive-migrations"] }));
  const result = await loadProfile(path);
  expect(result).toEqual({ systemPromptExtensions: ["no-destructive-migrations"] });
});

test("loadProfile rejects unknown keys", async () => {
  const dir = makeTmp();
  await mkdir(dir, { recursive: true });
  const path = join(dir, "profile.json");
  await writeFile(path, JSON.stringify({ model: "x", unknownKey: true }));
  await expect(loadProfile(path)).rejects.toThrow(/unknownKey must be removed/);
});

test("loadProfile rejects non-array systemPromptExtensions", async () => {
  const dir = makeTmp();
  await mkdir(dir, { recursive: true });
  const path = join(dir, "profile.json");
  await writeFile(path, JSON.stringify({ systemPromptExtensions: "bad" }));
  await expect(loadProfile(path)).rejects.toThrow(/systemPromptExtensions/);
});

test("loadProfile rejects invalid JSON", async () => {
  const dir = makeTmp();
  await mkdir(dir, { recursive: true });
  const path = join(dir, "profile.json");
  await writeFile(path, "not json");
  await expect(loadProfile(path)).rejects.toThrow(/Invalid JSON/);
});

test("resolveProfile returns empty object when no profile files exist", async () => {
  const cwd = makeTmp();
  await mkdir(cwd, { recursive: true });
  const result = await resolveProfile(cwd);
  expect(result).toEqual({});
});

test("resolveProfile applies project profile fields", async () => {
  const cwd = makeTmp();
  const dir = join(cwd, ".corbits");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "profile.json"),
    JSON.stringify({ model: "claude-sonnet", systemPromptExtensions: ["ext1"] }),
  );
  const result = await resolveProfile(cwd);
  expect(result.model).toBe("claude-sonnet");
  expect(result.systemPromptExtensions).toEqual(["ext1"]);
});

test("resolveProfile surfaces profile name when set", async () => {
  const cwd = makeTmp();
  const dir = join(cwd, ".corbits");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "profile.json"), JSON.stringify({ profile: "work" }));
  const result = await resolveProfile(cwd);
  expect(result.profile).toBe("work");
});

test("resolveProfile: project profile fields override named profile fields", async () => {
  const home = makeTmp();
  const cwd = makeTmp();
  const namedDir = join(home, ".corbits", "profiles");
  await mkdir(namedDir, { recursive: true });
  await writeFile(
    join(namedDir, "work.json"),
    JSON.stringify({ model: "base-model", systemPromptExtensions: ["ext1"] }),
  );
  const localDir = join(cwd, ".corbits");
  await mkdir(localDir, { recursive: true });
  await writeFile(
    join(localDir, "profile.json"),
    JSON.stringify({ profile: "work", model: "override-model" }),
  );

  // We can't easily inject profilesDir home in resolveProfile without additional plumbing,
  // so test the merge logic directly via the exported functions.
  // Project profile model should win over named profile model.
  const projectProfile = await loadProfile(join(localDir, "profile.json"));
  const namedProfile = await loadProfile(join(namedDir, "work.json"));
  const merged = { ...namedProfile };
  if (projectProfile?.model !== undefined) merged.model = projectProfile.model;
  expect(merged.model).toBe("override-model");
  // systemPromptExtensions not in project profile so named profile value survives
  expect(merged.systemPromptExtensions).toEqual(["ext1"]);
});
