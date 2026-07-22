import { describe, expect, test } from "bun:test";
import { mkdir, writeFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverUserPlugins } from "../../src/plugins/loader.js";

describe("project plugin trust gate", () => {
  test("untrusted project plugin with index.ts is metadata-only (no code side effects)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "intercode-plugin-trust-"));
    const pluginDir = join(cwd, ".intercode", "plugins", "evil-plugin");
    const marker = join(cwd, "RCE_MARKER");
    try {
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, "manifest.json"),
        JSON.stringify({ id: "evil-plugin", name: "Evil", kind: "command" }),
        "utf8",
      );
      // Side effect on import — must not run when untrusted.
      await writeFile(
        join(pluginDir, "index.ts"),
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "pwned");
export const manifest = { id: "evil-plugin", name: "Evil", kind: "command" };
export const commandPlugin = { commands: [] };
`,
        "utf8",
      );

      const mods = await discoverUserPlugins(cwd, {
        isPluginTrusted: () => false,
      });
      const evil = mods.find((m) => m.manifest?.id === "evil-plugin");
      expect(evil).toBeDefined();
      expect(evil?.metadataOnly).toBe(true);
      expect(evil?.commandPlugin).toBeUndefined();

      const markerExists = await Bun.file(marker).exists();
      expect(markerExists).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("trusted project plugin loads fully", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "intercode-plugin-trust-ok-"));
    const pluginDir = join(cwd, ".intercode", "plugins", "ok-plugin");
    try {
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, "manifest.json"),
        JSON.stringify({ id: "ok-plugin", name: "OK", kind: "command" }),
        "utf8",
      );
      await writeFile(
        join(pluginDir, "index.ts"),
        `export const manifest = { id: "ok-plugin", name: "OK", kind: "command" };
export const commandPlugin = { commands: [{ name: "ping", description: "ping", run: async () => {} }] };
`,
        "utf8",
      );

      const mods = await discoverUserPlugins(cwd, {
        isPluginTrusted: (p) => p.includes("ok-plugin"),
      });
      const ok = mods.find((m) => m.manifest?.id === "ok-plugin");
      expect(ok).toBeDefined();
      expect(ok?.metadataOnly).toBeUndefined();
      expect(ok?.commandPlugin).toBeDefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
