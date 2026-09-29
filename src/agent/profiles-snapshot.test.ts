import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  currentProfileSnapshotRevision,
  loadAgentProfiles,
  loadAgentProfilesWithDiagnostics,
} from "./profiles.js";

async function makeAgentsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cl9476-profiles-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return dir;
}

const VALID_PROFILE = JSON.stringify({
  id: "local-reader",
  systemPromptRole: "You read files.",
  capabilities: { mode: "allow", tools: ["read_file"] },
});

describe("loadAgentProfilesWithDiagnostics", () => {
  test("malformed file is reported and never poisons the load", async () => {
    const dir = await makeAgentsDir({
      "good.json": VALID_PROFILE,
      "broken.json": "{ not valid json",
      "notes.txt": "ignored, not a profile extension",
    });

    const { profiles, diagnostics } =
      await loadAgentProfilesWithDiagnostics(dir);

    expect(profiles.some((p) => p.id === "local-reader")).toBe(true);
    expect(diagnostics.malformed).toHaveLength(1);
    expect(diagnostics.malformed[0]?.path).toBe(join(dir, "broken.json"));
    expect(diagnostics.malformed[0]?.reason).toBe("invalid JSON");
    expect(typeof diagnostics.revision).toBe("number");
  });

  test("schema-invalid file is reported with its reason", async () => {
    const dir = await makeAgentsDir({
      "bad-shape.json": JSON.stringify({ id: 42 }),
    });

    const { profiles, diagnostics } =
      await loadAgentProfilesWithDiagnostics(dir);

    expect(profiles.some((p) => p.id === "local-reader")).toBe(false);
    expect(diagnostics.malformed).toHaveLength(1);
    expect(diagnostics.malformed[0]?.reason).toBe("schema validation failed");
  });

  test("loadAgentProfiles delegates and resolves identically", async () => {
    const dir = await makeAgentsDir({
      "good.json": VALID_PROFILE,
      "broken.json": "{ nope",
    });

    const viaDiagnostics = await loadAgentProfilesWithDiagnostics(dir);
    const direct = await loadAgentProfiles(dir);

    expect(direct.map((p) => p.id).sort()).toEqual(
      viaDiagnostics.profiles.map((p) => p.id).sort(),
    );
  });

  test("every load bumps the snapshot revision", async () => {
    const dir = await makeAgentsDir({ "good.json": VALID_PROFILE });
    const before = currentProfileSnapshotRevision();

    const first = await loadAgentProfilesWithDiagnostics(dir);
    const second = await loadAgentProfilesWithDiagnostics(dir);

    expect(second.diagnostics.revision).toBeGreaterThan(
      first.diagnostics.revision,
    );
    expect(first.diagnostics.revision).toBeGreaterThan(before);
    expect(currentProfileSnapshotRevision()).toBe(second.diagnostics.revision);
  });

  test("missing directory resolves defaults with no malformed entries", async () => {
    const { profiles, diagnostics } = await loadAgentProfilesWithDiagnostics(
      join(tmpdir(), "cl9476-does-not-exist"),
    );

    expect(profiles.length).toBeGreaterThan(0);
    expect(diagnostics.malformed).toEqual([]);
  });
});
