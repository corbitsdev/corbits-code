import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { schemaMaterializations } from "../schema/lazy.js";

test("importing settings does not build schemas; a malformed file fails when read", async () => {
  const before = schemaMaterializations();
  const settings = await import("./settings.js");
  expect(schemaMaterializations()).toBe(before);

  const dir = await mkdtemp(join(tmpdir(), "lazy-settings-"));
  try {
    const path = join(dir, "settings.json");
    await writeFile(path, JSON.stringify({ providers: "nope" }));
    await expect(settings.loadSettings(path)).rejects.toThrow(
      /Invalid settings schema/,
    );
    expect(schemaMaterializations()).toBeGreaterThan(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
