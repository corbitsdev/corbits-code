import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAuthState, saveAuthState } from "./token-store.js";

let home: string | undefined;

afterEach(async () => {
  if (home !== undefined) await rm(home, { recursive: true, force: true });
  home = undefined;
});

describe("token-store", () => {
  test("round-trips fake tokens through the auth file", async () => {
    home = await mkdtemp(join(tmpdir(), "mcp-adapter-auth-"));
    await saveAuthState(
      "test-seam",
      { tokens: { access_token: "fake-access-token-not-real", token_type: "bearer" } },
      home,
    );
    const reloaded = await loadAuthState("test-seam", home);
    expect(reloaded.tokens?.access_token).toBe("fake-access-token-not-real");
  });

  test("auth directory is created with owner-only permissions", async () => {
    home = await mkdtemp(join(tmpdir(), "mcp-adapter-auth-"));
    await saveAuthState("test-seam", { codeVerifier: "fake-verifier" }, home);
    const info = await stat(join(home, ".corbits", "mcp-auth"));
    expect(info.mode & 0o777).toBe(0o700);
  });

  test("server names are slugged so they cannot escape the auth directory", async () => {
    home = await mkdtemp(join(tmpdir(), "mcp-adapter-auth-"));
    await saveAuthState("../../evil", { codeVerifier: "fake" }, home);
    const reloaded = await loadAuthState("../../evil", home);
    expect(reloaded.codeVerifier).toBe("fake");
    const escaped = await stat(join(home, "..", "..", "evil.json")).catch(() => undefined);
    expect(escaped).toBeUndefined();
  });

  test("missing auth file returns empty state instead of throwing", async () => {
    home = await mkdtemp(join(tmpdir(), "mcp-adapter-auth-"));
    const state = await loadAuthState("never-connected", home);
    expect(state).toEqual({});
  });
});
