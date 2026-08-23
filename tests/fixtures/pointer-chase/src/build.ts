import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Load the production build token from the keys directory. */
export function loadBuildToken(root = process.cwd()): string {
  return readFileSync(join(root, "keys", "production.token"), "utf8").trim();
}

export function isReady(root = process.cwd()): boolean {
  return loadBuildToken(root) === "ok-7f3a";
}
