import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAuthState, saveAuthState, updateAuthState } from "./auth-store.js";

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mcp-auth-"));
}

describe("mcp auth-store", () => {
  test("updateAuthState merges concurrent field writes without losing tokens", async () => {
    const home = await tempHome();
    await saveAuthState(
      "linear",
      {
        clientInformation: {
          client_id: "c1",
          redirect_uris: ["http://127.0.0.1:1/callback"],
          client_id_issued_at: 1,
        },
      },
      home,
    );

    // Reproduce the bug: one writer saves tokens while another overwrites with a
    // fresh codeVerifier from a concurrent OAuth start. With full-snapshot
    // persists, the verifier write wiped tokens; with updateAuthState, both land.
    const writes = await Promise.all([
      updateAuthState(
        "linear",
        (state) => {
          state.tokens = {
            access_token: "tok",
            token_type: "bearer",
            expires_in: 3600,
            refresh_token: "ref",
          };
        },
        home,
      ),
      updateAuthState(
        "linear",
        (state) => {
          state.codeVerifier = "verifier-from-other-session";
        },
        home,
      ),
    ]);

    const final = await loadAuthState("linear", home);
    expect(final.tokens?.access_token).toBe("tok");
    expect(final.codeVerifier).toBe("verifier-from-other-session");
    expect(final.clientInformation?.client_id).toBe("c1");
    expect(
      writes[0].tokens?.access_token === "tok" || writes[1].tokens?.access_token === "tok",
    ).toBe(true);
  });

  test("concurrent saveAuthState calls do not throw ENOENT on temp rename", async () => {
    const home = await tempHome();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        saveAuthState("linear", { codeVerifier: `v${String(i)}` }, home),
      ),
    );
    const final = await loadAuthState("linear", home);
    expect(final.codeVerifier?.startsWith("v")).toBe(true);
    // No leftover temp files from failed renames.
    const dir = join(home, ".corbits", "mcp-auth");
    const raw = await readFile(join(dir, "linear.json"), "utf8");
    expect(JSON.parse(raw).codeVerifier).toBe(final.codeVerifier);
  });
});
