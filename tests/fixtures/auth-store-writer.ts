import { readFile } from "node:fs/promises";
import { type } from "arktype";

import { createAuthStore, type BaseTokens } from "../../src/auth/store.js";

type TestTokens = BaseTokens & { accountId?: string };

const TestTokensShape = type({
  access: "string",
  refresh: "string",
  expiresAt: "number",
});

function isTestTokens(value: unknown): value is TestTokens {
  return !(TestTokensShape(value) instanceof type.errors);
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
if (
  home === undefined ||
  barrier === undefined ||
  operation === undefined ||
  value === undefined
) {
  throw new Error("Expected home, barrier, operation, and value arguments");
}

const store = createAuthStore<TestTokens>({
  filename: "concurrent-auth.json",
  settingsDirName: ".test-settings",
  isTokens: isTestTokens,
});

await waitForBarrier(barrier);
if (operation === "save") {
  await store.saveProfile(
    {
      name: value,
      tokens: {
        access: `access-${value}`,
        refresh: `refresh-${value}`,
        expiresAt: 1,
      },
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
