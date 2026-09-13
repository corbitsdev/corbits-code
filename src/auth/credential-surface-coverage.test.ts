import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_AUTH_FILENAME } from "./codex/store.js";
import {
  buildCredentialPatterns,
  credentialDirDescriptors,
  credentialFileDescriptors,
} from "./credential-surface.js";
import { MCP_AUTH_DIRNAME } from "../mcp/auth-store.js";
import { XAI_AUTH_FILENAME } from "./xai/store.js";

const here = dirname(fileURLToPath(import.meta.url));

// Auth-owned credential literals live in exactly these store modules. Test
// fixtures (concurrent-auth.json, test-auth.json) live in *.test.ts, which the
// scan below excludes, so fixture names can never become denylist patterns.
const STORE_FILES = [
  join(here, "codex", "store.ts"),
  join(here, "xai", "store.ts"),
  join(here, "..", "mcp", "auth-store.ts"),
];

async function scanStoreSources(): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  const glob = new Glob("**/*.ts");
  for await (const entry of glob.scan({ cwd: here, absolute: true })) {
    if (entry.endsWith(".test.ts")) continue;
    sources.set(entry, await Bun.file(entry).text());
  }
  for (const file of STORE_FILES) {
    if (!sources.has(file)) sources.set(file, await Bun.file(file).text());
  }
  return sources;
}

function authFileLiterals(source: string): string[] {
  const found: string[] = [];
  const pattern = /["']([A-Za-z0-9_.-]+-auth\.json)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const literal = match[1];
    if (literal !== undefined && !found.includes(literal)) found.push(literal);
  }
  return found;
}

describe("CL-7789 credential-surface coverage", () => {
  test("every *-auth.json literal in auth-owned stores is denied", async () => {
    const sources = await scanStoreSources();
    const patterns = buildCredentialPatterns();
    const seen = new Set<string>();
    for (const source of sources.values()) {
      for (const literal of authFileLiterals(source)) {
        seen.add(literal);
        const probe = join("~", ".corbits", literal);
        expect(
          patterns.some((pattern) => pattern.test(probe)),
          `${literal} has no denylist pattern`,
        ).toBe(true);
      }
    }
    expect([...seen].sort()).toEqual(
      [CODEX_AUTH_FILENAME, XAI_AUTH_FILENAME].sort(),
    );
  });

  test("every registry descriptor resolves back to a store literal", async () => {
    const sources = await scanStoreSources();
    const texts = [...sources.values()];
    for (const { filename } of credentialFileDescriptors) {
      expect(
        texts.some((source) => source.includes(`"${filename}"`)),
        `${filename} is registered but no store writes it`,
      ).toBe(true);
    }
    for (const { dirname } of credentialDirDescriptors) {
      expect(
        texts.some((source) => source.includes(`"${dirname}"`)),
        `${dirname} is registered but no store writes it`,
      ).toBe(true);
    }
    expect(texts.some((source) => source.includes(MCP_AUTH_DIRNAME))).toBe(
      true,
    );
  });
});
