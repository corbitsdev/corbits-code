import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addProjectPathGrant,
  getProjectPathGrants,
  getProjectPathGrantsForCwd,
  isPathCoveredByReadGrant,
  mintPathGrant,
  removeProjectPathGrant,
  type PathGrant,
} from "./path-grants.js";
import { projectKeyFor } from "../session/project-key.js";
import type { Settings } from "../config/settings.js";

function emptySettings(): Settings {
  return { providers: {} };
}

describe("path-grants", () => {
  describe("isPathCoveredByReadGrant", () => {
    test("file grant covers exact file only", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "pg-cover-"));
      try {
        const file = join(tmp, "a.txt");
        await writeFile(file, "a");
        const sibling = join(tmp, "b.txt");
        await writeFile(sibling, "b");
        const grants: PathGrant[] = [mintPathGrant(file, "file")];

        expect(isPathCoveredByReadGrant(file, grants)).toBe(true);
        expect(isPathCoveredByReadGrant(sibling, grants)).toBe(false);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });

    test("dir grant covers nested paths", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "pg-dir-"));
      try {
        const nested = join(tmp, "sub", "deep", "x.txt");
        await mkdir(join(tmp, "sub", "deep"), { recursive: true });
        await writeFile(nested, "x");
        const grants: PathGrant[] = [mintPathGrant(tmp, "dir")];

        expect(isPathCoveredByReadGrant(tmp, grants)).toBe(true);
        expect(isPathCoveredByReadGrant(nested, grants)).toBe(true);
        expect(isPathCoveredByReadGrant(join(tmpdir(), "sibling-not-granted"), grants)).toBe(false);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("addProjectPathGrant", () => {
    test("adds a file grant and is idempotent", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "pg-add-"));
      try {
        const file = join(tmp, "a.txt");
        await writeFile(file, "a");
        const grant = mintPathGrant(file, "file");

        const a = addProjectPathGrant(emptySettings(), "pk", grant);
        const b = addProjectPathGrant(a, "pk", grant);

        expect(getProjectPathGrants(a, "pk")).toEqual([grant]);
        expect(getProjectPathGrants(b, "pk")).toEqual([grant]);
        expect(b).toBe(a);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });

    test("dir grant supersedes file grants under it", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "pg-supersede-"));
      try {
        const fileA = join(tmp, "a.txt");
        const fileB = join(tmp, "b.txt");
        await writeFile(fileA, "a");
        await writeFile(fileB, "b");

        let s = addProjectPathGrant(emptySettings(), "pk", mintPathGrant(fileA, "file"));
        s = addProjectPathGrant(s, "pk", mintPathGrant(fileB, "file"));
        s = addProjectPathGrant(s, "pk", mintPathGrant(tmp, "dir"));

        const grants = getProjectPathGrants(s, "pk");
        expect(grants).toEqual([mintPathGrant(tmp, "dir")]);

        // Adding a file under the dir grant is a no-op.
        const before = s;
        const next = addProjectPathGrant(before, "pk", mintPathGrant(join(tmp, "c.txt"), "file"));
        expect(next).toBe(before);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("removeProjectPathGrant", () => {
    test("removes by path and drops empty projectKey", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "pg-rm-"));
      try {
        const file = join(tmp, "a.txt");
        await writeFile(file, "a");
        const grant = mintPathGrant(file, "file");

        const seeded = addProjectPathGrant(emptySettings(), "pk", grant);
        expect(seeded.projectPathGrants?.["pk"]).toHaveLength(1);

        const after = removeProjectPathGrant(seeded, "pk", file);
        expect(after.projectPathGrants ?? {}).toEqual({});
        // Removing a non-existent path is a no-op.
        expect(removeProjectPathGrant(after, "pk", join(tmp, "missing.txt"))).toBe(after);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("getProjectPathGrantsForCwd", () => {
    test("reads grants via projectKeyFor(cwd)", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "pg-cwd-"));
      try {
        const file = join(tmp, "outside.txt");
        await writeFile(file, "x");
        const grant = mintPathGrant(file, "file");

        // Realpath the cwd so the project key matches what projectKeyFor would compute.
        const realCwd = realpathSync(tmp);
        const seeded = addProjectPathGrant(emptySettings(), projectKeyFor(realCwd), grant);

        expect(getProjectPathGrantsForCwd(seeded, realCwd)).toEqual([grant]);
        expect(getProjectPathGrantsForCwd(seeded, join(tmpdir(), "different-project"))).toEqual([]);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });
  });
});
