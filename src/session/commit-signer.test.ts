import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadOrCreateCommitSigner } from "./commit-signer.js";

const KEY_FILE = path.join("keys", "commit-ed25519.json");

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "commit-signer-"));
}

function keyPath(dir: string): string {
  return path.join(dir, KEY_FILE);
}

function publicKeyInFile(dir: string): string {
  const parsed = JSON.parse(fs.readFileSync(keyPath(dir), "utf8")) as {
    publicKey: string;
  };
  return parsed.publicKey;
}

describe("loadOrCreateCommitSigner", () => {
  test("first call creates a signed-able signer and a 0600 key file", async () => {
    const dir = tempDir();
    const signer = await loadOrCreateCommitSigner(dir);
    const signature = await signer("payload");
    expect(typeof signature).toBe("string");
    expect(signature.length).toBeGreaterThan(0);

    const st = fs.statSync(keyPath(dir));
    expect(st.mode & 0o777).toBe(0o600);
  });

  test("second call reloads the same key (same publicKey bytes in the file)", async () => {
    const dir = tempDir();
    await loadOrCreateCommitSigner(dir);
    const firstPublic = publicKeyInFile(dir);
    await loadOrCreateCommitSigner(dir);
    expect(publicKeyInFile(dir)).toBe(firstPublic);
  });

  test("concurrent first-time create: both succeed, only one key file, both signers work", async () => {
    const dir = tempDir();
    const [a, b] = await Promise.all([
      loadOrCreateCommitSigner(dir),
      loadOrCreateCommitSigner(dir),
    ]);
    const sigA = await a("a");
    const sigB = await b("b");
    expect(typeof sigA).toBe("string");
    expect(typeof sigB).toBe("string");
    expect(sigA.length).toBeGreaterThan(0);
    expect(sigB.length).toBeGreaterThan(0);
    expect(fs.readdirSync(path.join(dir, "keys"))).toEqual([
      "commit-ed25519.json",
    ]);
  });

  test("corrupt JSON throws Invalid commit signing key", async () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "keys"));
    fs.writeFileSync(keyPath(dir), "{not-json");
    await expect(loadOrCreateCommitSigner(dir)).rejects.toThrow(
      `Invalid commit signing key at ${keyPath(dir)}`,
    );
  });

  test("invalid arktype shape throws Invalid commit signing key", async () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "keys"));
    fs.writeFileSync(keyPath(dir), JSON.stringify({ privateKey: 1 }));
    await expect(loadOrCreateCommitSigner(dir)).rejects.toThrow(
      `Invalid commit signing key at ${keyPath(dir)}`,
    );
  });
});
