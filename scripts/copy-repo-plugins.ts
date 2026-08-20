import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Copy first-party plugins/ next to the build output so discoverRepoPlugins
// finds dist/plugins (bundle) or dirname(execPath)/plugins (compiled binary).
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "plugins");
const dest = join(root, "dist", "plugins");

if (!existsSync(src) || !statSync(src).isDirectory()) {
  process.exit(0);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(join(root, "dist"), { recursive: true });
cpSync(src, dest, { recursive: true });
