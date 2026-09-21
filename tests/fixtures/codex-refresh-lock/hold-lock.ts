// Test fixture: holds a Codex refresh lock, printing "held" once acquired,
// then exits after holdMs so the lock is released. Spawned by
// src/auth/codex/refresh-lock.test.ts to prove cross-process serialization.
import { withCodexRefreshLock } from "../../../src/auth/codex/refresh-lock.js";

const lockPath = Bun.argv[2];
const holdMs = Number(Bun.argv[3] ?? "1500");
if (lockPath === undefined)
  throw new Error("usage: hold-lock.ts <lockPath> [holdMs]");
await withCodexRefreshLock(lockPath, async () => {
  process.stdout.write("held\n");
  await new Promise((resolve) => setTimeout(resolve, holdMs));
});
