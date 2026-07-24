import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  legacyGlobalDirPath,
  migrateLegacyGlobalDir,
  migrateLegacyLocalDir,
  newGlobalDirPath,
} from "./migrate-legacy-dir.js";
import { loadSettings, markLegacyDirMigrated } from "./settings.js";

async function makeTempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "migrate-legacy-dir-test-"));
}

describe("migrateLegacyGlobalDir", () => {
  test("copies legacy dir contents when new dir is missing", async () => {
    const home = await makeTempHome();
    try {
      const legacy = legacyGlobalDirPath(home);
      await mkdir(legacy, { recursive: true });
      await writeFile(join(legacy, "settings.json"), '{"providers":{}}');
      await mkdir(join(legacy, "hooks"), { recursive: true });
      await writeFile(join(legacy, "hooks", "pre.sh"), "#!/bin/sh\n");

      const result = await migrateLegacyGlobalDir(home);

      expect(result.copied).toBe(true);
      const newDir = newGlobalDirPath(home);
      expect(await readFile(join(newDir, "settings.json"), "utf8")).toBe('{"providers":{}}');
      expect(await readFile(join(newDir, "hooks", "pre.sh"), "utf8")).toBe("#!/bin/sh\n");
      // Legacy dir is left untouched.
      expect(await readFile(join(legacy, "settings.json"), "utf8")).toBe('{"providers":{}}');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("copies when new dir exists but is empty", async () => {
    const home = await makeTempHome();
    try {
      const legacy = legacyGlobalDirPath(home);
      await mkdir(legacy, { recursive: true });
      await writeFile(join(legacy, "MEMORY.md"), "notes");
      await mkdir(newGlobalDirPath(home), { recursive: true });

      const result = await migrateLegacyGlobalDir(home);

      expect(result.copied).toBe(true);
      expect(await readFile(join(newGlobalDirPath(home), "MEMORY.md"), "utf8")).toBe("notes");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("copies when new dir only has a pricing cache", async () => {
    const home = await makeTempHome();
    try {
      const legacy = legacyGlobalDirPath(home);
      await mkdir(legacy, { recursive: true });
      await writeFile(join(legacy, "settings.json"), '{"providers":{"legacy":{}}}');

      const newDir = newGlobalDirPath(home);
      await mkdir(join(newDir, "cache"), { recursive: true });
      await writeFile(join(newDir, "cache", "pricing.json"), "{}");

      const result = await migrateLegacyGlobalDir(home);

      expect(result.copied).toBe(true);
      expect(await readFile(join(newDir, "settings.json"), "utf8")).toBe(
        '{"providers":{"legacy":{}}}',
      );
      // Existing cache left in place.
      expect(await readFile(join(newDir, "cache", "pricing.json"), "utf8")).toBe("{}");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("never overwrites when new dir already has content", async () => {
    const home = await makeTempHome();
    try {
      const legacy = legacyGlobalDirPath(home);
      await mkdir(legacy, { recursive: true });
      await writeFile(join(legacy, "settings.json"), '{"providers":{"legacy":{}}}');

      const newDir = newGlobalDirPath(home);
      await mkdir(newDir, { recursive: true });
      await writeFile(join(newDir, "settings.json"), '{"providers":{"current":{}}}');

      const result = await migrateLegacyGlobalDir(home);

      expect(result.copied).toBe(false);
      expect(await readFile(join(newDir, "settings.json"), "utf8")).toBe('{"providers":{"current":{}}}');
      // Legacy dir also untouched.
      expect(await readFile(join(legacy, "settings.json"), "utf8")).toBe('{"providers":{"legacy":{}}}');
      expect((await readdir(newDir)).length).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("no-op when legacy dir is absent", async () => {
    const home = await makeTempHome();
    try {
      const result = await migrateLegacyGlobalDir(home);
      expect(result.copied).toBe(false);
      await expect(readdir(newGlobalDirPath(home))).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("copy failure leaves both dirs intact and does not throw", async () => {
    const home = await makeTempHome();
    try {
      const legacy = legacyGlobalDirPath(home);
      await mkdir(legacy, { recursive: true });
      await writeFile(join(legacy, "settings.json"), '{"providers":{}}');

      // Make the new dir's parent path a file instead of a directory, so
      // mkdir/cp against it fails.
      const newDir = newGlobalDirPath(home);
      await writeFile(newDir, "not a directory");

      const result = await migrateLegacyGlobalDir(home);

      expect(result.copied).toBe(false);
      // Legacy dir untouched.
      expect(await readFile(join(legacy, "settings.json"), "utf8")).toBe('{"providers":{}}');
      // The bogus file at the new dir path is untouched too (nothing thrown, nothing deleted).
      expect(await readFile(newDir, "utf8")).toBe("not a directory");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("does not treat non-cache junk as unclaimed", async () => {
    const home = await makeTempHome();
    try {
      const legacy = legacyGlobalDirPath(home);
      await mkdir(legacy, { recursive: true });
      await writeFile(join(legacy, "settings.json"), '{"providers":{"legacy":{}}}');

      const newDir = newGlobalDirPath(home);
      await mkdir(newDir, { recursive: true });
      await writeFile(join(newDir, ".DS_Store"), "");

      const result = await migrateLegacyGlobalDir(home);

      expect(result.copied).toBe(false);
      expect(await readFile(join(legacy, "settings.json"), "utf8")).toBe(
        '{"providers":{"legacy":{}}}',
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("migrateLegacyLocalDir", () => {
  test("copies per-repo legacy dir into the new one", async () => {
    const cwd = await makeTempHome();
    try {
      await mkdir(join(cwd, ".intercode"), { recursive: true });
      await writeFile(join(cwd, ".intercode", "settings.json"), '{"provider":"x"}');

      const result = await migrateLegacyLocalDir(cwd);

      expect(result.copied).toBe(true);
      expect(await readFile(join(cwd, ".corbits", "settings.json"), "utf8")).toBe('{"provider":"x"}');
      // Legacy dir kept.
      expect(await readFile(join(cwd, ".intercode", "settings.json"), "utf8")).toBe('{"provider":"x"}');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("markLegacyDirMigrated", () => {
  const validSettings = JSON.stringify({
    providers: { legacy: { baseURL: "https://example.com", models: ["m"] } },
  });

  test("stamps migrationLegacyDirCopied after a successful copy", async () => {
    const home = await makeTempHome();
    try {
      const legacy = legacyGlobalDirPath(home);
      await mkdir(legacy, { recursive: true });
      await writeFile(join(legacy, "settings.json"), validSettings);

      expect((await migrateLegacyGlobalDir(home)).copied).toBe(true);

      const settingsPath = join(newGlobalDirPath(home), "settings.json");
      await markLegacyDirMigrated(settingsPath);

      const stamped = await loadSettings(settingsPath);
      expect(stamped?.migrationLegacyDirCopied).toBe(true);
      expect(stamped?.providers.legacy?.baseURL).toBe("https://example.com");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("is a no-op when the flag is already true", async () => {
    const home = await makeTempHome();
    try {
      const settingsPath = join(newGlobalDirPath(home), "settings.json");
      await mkdir(newGlobalDirPath(home), { recursive: true });
      await writeFile(
        settingsPath,
        JSON.stringify({
          providers: { legacy: { baseURL: "https://example.com", models: ["m"] } },
          migrationLegacyDirCopied: true,
        }),
      );

      await markLegacyDirMigrated(settingsPath);
      const stamped = await loadSettings(settingsPath);
      expect(stamped?.migrationLegacyDirCopied).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
