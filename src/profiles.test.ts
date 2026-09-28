import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadProfile,
  projectProfilePath,
  profilesDir,
  resolveProfile,
} from "./config/profiles.js";

function makeTmp(): string {
  return join(
    tmpdir(),
    `interchange-profiles-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value));
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

test.each([
  [{ model: "claude-opus-4-8" }],
  [{ systemPromptExtensions: ["no-destructive-migrations"] }],
  [{ promptSectionOmit: ["toolChoice" as const, "orchestration" as const] }],
])("loadProfile parses %j", async (profile) => {
  const dir = makeTmp();
  await mkdir(dir, { recursive: true });
  const path = join(dir, "profile.json");
  await writeJson(path, profile);
  expect(await loadProfile(path)).toEqual(profile);
});

test.each([
  [{ promptSectionOmit: ["no-such-block"] }, /promptSectionOmit/],
  [{ model: "x", unknownKey: true }, /unknownKey must be removed/],
  [{ workflow: "build" }, /workflow must be removed/],
  [{ systemPromptExtensions: "bad" }, /systemPromptExtensions/],
])("loadProfile rejects %j", async (profile, pattern) => {
  const dir = makeTmp();
  await mkdir(dir, { recursive: true });
  const path = join(dir, "profile.json");
  await writeJson(path, profile);
  await expect(loadProfile(path)).rejects.toThrow(pattern);
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

test("resolveProfile throws when --profile names a missing file", async () => {
  const home = makeTmp();
  const cwd = makeTmp();
  await mkdir(cwd, { recursive: true });
  const name = "does-not-exist";
  const missingPath = join(profilesDir(home), `${name}.json`);
  expect(await loadProfile(missingPath)).toBeNull();
  await expect(resolveProfile(cwd, name, home)).rejects.toThrow(missingPath);
});

test("resolveProfile loads a valid named profile", async () => {
  const home = makeTmp();
  const cwd = makeTmp();
  await mkdir(cwd, { recursive: true });
  const namedDir = join(home, ".corbits", "profiles");
  await mkdir(namedDir, { recursive: true });
  await writeJson(join(namedDir, "work.json"), { model: "named-model" });
  const result = await resolveProfile(cwd, "work", home);
  expect(result.model).toBe("named-model");
  expect(result.profile).toBe("work");
});

test("resolveProfile applies project profile fields", async () => {
  const cwd = makeTmp();
  const dir = join(cwd, ".corbits");
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, "profile.json"), {
    model: "claude-sonnet",
    systemPromptExtensions: ["ext1"],
  });
  const result = await resolveProfile(cwd);
  expect(result.model).toBe("claude-sonnet");
  expect(result.systemPromptExtensions).toEqual(["ext1"]);
});

test("resolveProfile throws when a named profile key points at a missing file", async () => {
  const home = makeTmp();
  const cwd = makeTmp();
  const dir = join(cwd, ".corbits");
  await mkdir(dir, { recursive: true });
  const name = "no-such-named-profile";
  await writeJson(join(dir, "profile.json"), { profile: name });
  const missingPath = join(profilesDir(home), `${name}.json`);
  await expect(resolveProfile(cwd, undefined, home)).rejects.toThrow(
    missingPath,
  );
});

test("resolveProfile: project profile fields override named profile fields", async () => {
  const home = makeTmp();
  const cwd = makeTmp();
  const namedDir = join(home, ".corbits", "profiles");
  await mkdir(namedDir, { recursive: true });
  await writeJson(join(namedDir, "work.json"), {
    model: "base-model",
    systemPromptExtensions: ["ext1"],
  });
  const localDir = join(cwd, ".corbits");
  await mkdir(localDir, { recursive: true });
  await writeJson(join(localDir, "profile.json"), {
    profile: "work",
    model: "override-model",
  });

  const result = await resolveProfile(cwd, undefined, home);
  expect(result.model).toBe("override-model");
  expect(result.systemPromptExtensions).toEqual(["ext1"]);
  expect(result.profile).toBe("work");
});
