import { readFile } from "node:fs/promises";

import { createAuthStore, type BaseTokens } from "../../src/auth/oauth/store.js";

type TestTokens = BaseTokens & { accountId?: string };

function isTestTokens(value: unknown): value is TestTokens {
  if (typeof value !== "object" || value === null) return false;
  const tokens = value as Record<string, unknown>;
  return (
    typeof tokens.access === "string" &&
    typeof tokens.refresh === "string" &&
    typeof tokens.expiresAt === "number"
  );
}

async function waitForBarrier(path: string): Promise<void> {
  while (true) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      await Bun.sleep(5);
    }
  }
}

const [home, barrier, operation, value] = Bun.argv.slice(2);
if (home === undefined || barrier === undefined || operation === undefined || value === undefined) {
  throw new Error("Expected home, barrier, operation, and value arguments");
}

const store = createAuthStore<TestTokens>({
  filename: "concurrent-auth.json",
  isTokens: isTestTokens,
});

await waitForBarrier(barrier);
if (operation === "save") {
  await store.saveProfile(
    {
      name: value,
      tokens: { access: `access-${value}`, refresh: `refresh-${value}`, expiresAt: 1 },
      createdAt: 1,
    },
    home,
  );
} else if (operation === "update") {
  await store.updateTokens(
    "existing",
    { access: value, refresh: `refresh-${value}`, expiresAt: 2 },
    home,
  );
} else {
  throw new Error(`Unknown operation: ${operation}`);
}
