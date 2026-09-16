import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Shared directory walk for the forensics scripts: recursively collects the
// paths of every file named `name` under `dir`.
//
// lstat, and skip symlinks: session dirs carry a `latest` symlink to a real
// session, and following it double-counts every record in that session.
export function findAll(dir: string, name: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(path);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) findAll(path, name, out);
    else if (entry === name) out.push(path);
  }
}
