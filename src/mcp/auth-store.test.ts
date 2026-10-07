import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  authFilePath,
  deleteAuthState,
  loadAuthState,
  saveAuthState,
  updateAuthState,
} from "./auth-store.js";

const linear = {
  serverName: "linear",
  serverURL: "https://mcp.linear.app/mcp",
};

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

    // Reproduce the bug: a concurrent registration write must not wipe the
    // other writer's tokens (updateAuthState merges).
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
          state.clientInformation = {
            client_id: "c1",
            redirect_uris: ["http://127.0.0.1:1/callback"],
            client_id_issued_at: 1,
            client_name: "other-session",
          };
        },
        home,
      ),
    ]);

    const final = await loadAuthState(linear, home);
    expect(final.tokens?.access_token).toBe("tok");
    expect(final.clientInformation?.client_name).toBe("other-session");
    expect(final.clientInformation?.client_id).toBe("c1");
    expect(
      writes[0].tokens?.access_token === "tok" ||
        writes[1].tokens?.access_token === "tok",
    ).toBe(true);
  });

  test("overlapping updateAuthState from two processes keeps tokens and client registration", async () => {
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

    const storePath = join(import.meta.dirname, "auth-store.ts");
    const barrier = join(home, "start");
    const script = `
      import { updateAuthState } from ${JSON.stringify(storePath)};
      const home = process.argv[1];
      const field = process.argv[2];
      const barrier = process.argv[3];
      const identity = { serverName: "linear", serverURL: "https://mcp.linear.app/mcp" };
      while (!(await Bun.file(barrier).exists())) await Bun.sleep(5);
      await updateAuthState(
        identity,
        (state) => {
          Bun.sleepSync(150);
          if (field === "tokens") {
            state.tokens = {
              access_token: "tok",
              token_type: "bearer",
              expires_in: 3600,
              refresh_token: "ref",
            };
          } else {
            state.clientInformation = {
              client_id: "c1",
              redirect_uris: ["http://127.0.0.1:1/callback"],
              client_id_issued_at: 1,
              client_name: "other-session",
            };
          }
        },
        home,
      );
    `;
    const processes = [
      Bun.spawn(
        [process.execPath, "-e", script, "--", home, "tokens", barrier],
        {
          stdout: "ignore",
          stderr: "pipe",
        },
      ),
      Bun.spawn(
        [process.execPath, "-e", script, "--", home, "client", barrier],
        {
          stdout: "ignore",
          stderr: "pipe",
        },
      ),
    ];
    await Bun.sleep(50);
    await writeFile(barrier, "go");
    const exitCodes = await Promise.all(processes.map((child) => child.exited));
    const errors = await Promise.all(
      processes.map((child) => new Response(child.stderr).text()),
    );
    expect(exitCodes, errors.join("\n")).toEqual([0, 0]);

    const final = await loadAuthState(linear, home);
    expect(final.tokens?.access_token).toBe("tok");
    expect(final.clientInformation?.client_name).toBe("other-session");
    expect(final.clientInformation?.client_id).toBe("c1");
  });

  test("concurrent saveAuthState calls do not throw ENOENT on temp rename", async () => {
    const home = await tempHome();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        saveAuthState(
          linear,
          {
            tokens: { access_token: `v${String(i)}`, token_type: "bearer" },
          },
          home,
        ),
      ),
    );
    const final = await loadAuthState(linear, home);
    expect(final.tokens?.access_token?.startsWith("v")).toBe(true);
    // No leftover temp files from failed renames.
    const dir = join(home, ".corbits", "mcp-auth");
    const files = await Array.fromAsync(
      new Bun.Glob("linear-*.json").scan(dir),
    );
    expect(files).toHaveLength(1);
    const raw = await readFile(join(dir, files[0] ?? "missing"), "utf8");
    expect(JSON.parse(raw).tokens).toEqual(final.tokens);
  });

  test("scopes credentials to normalized endpoint identity", async () => {
    const home = await tempHome();
    const originA = { serverName: "exa", serverURL: "https://one.example/mcp" };
    const originB = { serverName: "exa", serverURL: "https://two.example/mcp" };
    const pathB = {
      serverName: "exa",
      serverURL: "https://one.example/other?mode=full",
    };
    const queryB = {
      serverName: "exa",
      serverURL: "https://one.example/mcp?mode=full",
    };
    const equivalent = {
      serverName: "exa",
      serverURL: "https://ONE.example:443/mcp#ignored",
    };

    await saveAuthState(
      originA,
      { tokens: { access_token: "only-a", token_type: "bearer" } },
      home,
    );

    expect((await loadAuthState(originA, home)).tokens?.access_token).toBe(
      "only-a",
    );
    expect(await loadAuthState(originB, home)).toEqual({});
    expect(await loadAuthState(pathB, home)).toEqual({});
    expect(await loadAuthState(queryB, home)).toEqual({});
    expect((await loadAuthState(equivalent, home)).tokens?.access_token).toBe(
      "only-a",
    );
  });

  test("ignores legacy name-only auth state without modifying it", async () => {
    const home = await tempHome();
    const dir = join(home, ".corbits", "mcp-auth");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "exa.json"),
      JSON.stringify({ codeVerifier: "legacy-secret" }),
    );

    expect(
      await loadAuthState(
        { serverName: "exa", serverURL: "https://mcp.exa.ai/mcp" },
        home,
      ),
    ).toEqual({});
    expect(JSON.parse(await readFile(join(dir, "exa.json"), "utf8"))).toEqual({
      codeVerifier: "legacy-secret",
    });
  });

  test("updateAuthState strips a legacy PKCE verifier instead of persisting it", async () => {
    const home = await tempHome();
    const path = authFilePath(linear, home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        tokens: { access_token: "tok", token_type: "bearer" },
        codeVerifier: "legacy-secret",
      }),
    );

    const written = await updateAuthState(
      linear,
      (state) => {
        state.tokens = { access_token: "tok2", token_type: "bearer" };
      },
      home,
    );

    expect(written.tokens?.access_token).toBe("tok2");
    expect("codeVerifier" in written).toBe(false);
    expect(await readFile(path, "utf8")).not.toContain("codeVerifier");
    expect((await loadAuthState(linear, home)).tokens?.access_token).toBe(
      "tok2",
    );
  });

  test("bounds the display slug without weakening scoped identity", async () => {
    const home = await tempHome();
    const dir = join(home, ".corbits", "mcp-auth");
    const prefixName = "a".repeat(48);
    const longName = `${prefixName}/long`;
    await saveAuthState(
      { serverName: longName, serverURL: "https://long.example/mcp" },
      { tokens: { access_token: "scoped-secret", token_type: "bearer" } },
      home,
    );

    const scopedFiles = await Array.fromAsync(
      new Bun.Glob(`${prefixName}-*.json`).scan(dir),
    );
    expect(scopedFiles).toEqual([
      `${prefixName}-825ce19c43a3d0135fa8efda61d61c23a13e6917eb90ea42a6cc43744c0b8b5d.json`,
    ]);
  });

  test("deleteAuthState removes an existing file", async () => {
    const home = await tempHome();
    await saveAuthState(
      linear,
      { tokens: { access_token: "secret", token_type: "bearer" } },
      home,
    );
    expect((await loadAuthState(linear, home)).tokens?.access_token).toBe(
      "secret",
    );

    await deleteAuthState(linear, home);
    expect(await loadAuthState(linear, home)).toEqual({});
  });

  test("deleteAuthState succeeds when the file was never written or already gone", async () => {
    const home = await tempHome();
    await deleteAuthState(linear, home);
    await deleteAuthState(linear, home);
    expect(await loadAuthState(linear, home)).toEqual({});
  });

  test("concurrent updateAuthState and deleteAuthState do not throw ENOENT on rename", async () => {
    const home = await tempHome();
    await saveAuthState(
      linear,
      { tokens: { access_token: "v0", token_type: "bearer" } },
      home,
    );

    await Promise.all([
      updateAuthState(
        linear,
        (state) => {
          state.tokens = { access_token: "v1", token_type: "bearer" };
        },
        home,
      ),
      deleteAuthState(linear, home),
    ]);

    const final = await loadAuthState(linear, home);
    expect(
      final.tokens === undefined || final.tokens.access_token === "v1",
    ).toBe(true);
  });
});
