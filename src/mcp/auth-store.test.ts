import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAuthState, saveAuthState, updateAuthState } from "./auth-store.js";

const linear = { serverName: "linear", serverURL: "https://mcp.linear.app/mcp" };

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mcp-auth-"));
}

describe("mcp auth-store", () => {
  test("updateAuthState merges concurrent field writes without losing tokens", async () => {
    const home = await tempHome();
    await saveAuthState(
      linear,
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
        linear,
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
        linear,
        (state) => {
          state.codeVerifier = "verifier-from-other-session";
        },
        home,
      ),
    ]);

    const final = await loadAuthState(linear, home);
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
        saveAuthState(linear, { codeVerifier: `v${String(i)}` }, home),
      ),
    );
    const final = await loadAuthState(linear, home);
    expect(final.codeVerifier?.startsWith("v")).toBe(true);
    // No leftover temp files from failed renames.
    const dir = join(home, ".corbits", "mcp-auth");
    const files = await Array.fromAsync(new Bun.Glob("linear-*.json").scan(dir));
    expect(files).toHaveLength(1);
    const raw = await readFile(join(dir, files[0] ?? "missing"), "utf8");
    expect(JSON.parse(raw).codeVerifier).toBe(final.codeVerifier);
  });

  test("scopes credentials to normalized endpoint identity", async () => {
    const home = await tempHome();
    const originA = { serverName: "exa", serverURL: "https://one.example/mcp" };
    const originB = { serverName: "exa", serverURL: "https://two.example/mcp" };
    const pathB = { serverName: "exa", serverURL: "https://one.example/other?mode=full" };
    const queryB = { serverName: "exa", serverURL: "https://one.example/mcp?mode=full" };
    const equivalent = { serverName: "exa", serverURL: "https://ONE.example:443/mcp#ignored" };

    await saveAuthState(originA, { codeVerifier: "only-a" }, home);

    expect((await loadAuthState(originA, home)).codeVerifier).toBe("only-a");
    expect(await loadAuthState(originB, home)).toEqual({});
    expect(await loadAuthState(pathB, home)).toEqual({});
    expect(await loadAuthState(queryB, home)).toEqual({});
    expect((await loadAuthState(equivalent, home)).codeVerifier).toBe("only-a");
  });

  test("ignores legacy name-only auth state without modifying it", async () => {
    const home = await tempHome();
    const dir = join(home, ".corbits", "mcp-auth");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "exa.json"), JSON.stringify({ codeVerifier: "legacy-secret" }));

    expect(
      await loadAuthState({ serverName: "exa", serverURL: "https://mcp.exa.ai/mcp" }, home),
    ).toEqual({});
    expect(JSON.parse(await readFile(join(dir, "exa.json"), "utf8"))).toEqual({
      codeVerifier: "legacy-secret",
    });
  });

  test("bounds the display slug without weakening scoped identity", async () => {
    const home = await tempHome();
    const dir = join(home, ".corbits", "mcp-auth");
    const prefixName = "a".repeat(48);
    const longName = `${prefixName}/long`;
    await saveAuthState(
      { serverName: longName, serverURL: "https://long.example/mcp" },
      { codeVerifier: "scoped-secret" },
      home,
    );

    const scopedFiles = await Array.fromAsync(new Bun.Glob(`${prefixName}-*.json`).scan(dir));
    expect(scopedFiles).toEqual([
      `${prefixName}-825ce19c43a3d0135fa8efda61d61c23a13e6917eb90ea42a6cc43744c0b8b5d.json`,
    ]);
  });
});
