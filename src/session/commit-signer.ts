import fs from "node:fs";
import path from "node:path";
import { type } from "arktype";
import { createSSHSignature, generateKeyPair } from "@intx/crypto";
import type { CommitSigner } from "@intx/storage-isogit/node";
import { getLogger } from "@intx/log";

import { LOG_NAMESPACE_ROOT } from "../branding.js";

const KEY_DIR = "keys";
const KEY_FILE = "commit-ed25519.json";

const log = getLogger([LOG_NAMESPACE_ROOT, "session", "commit-signer"]);

const PersistedKeyPair = type({
  privateKey: "string",
  publicKey: "string",
});

function decodeKey(label: string, value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32) {
    throw new Error(`${label} must be 32 bytes, got ${bytes.length}`);
  }
  return new Uint8Array(bytes);
}

async function loadPersistedKeyPair(
  filePath: string,
): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array } | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
    throw cause;
  }
  const parsed = PersistedKeyPair(JSON.parse(raw) as unknown);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid commit signing key at ${filePath}: ${parsed.summary}`);
  }
  return {
    privateKey: decodeKey("privateKey", parsed.privateKey),
    publicKey: decodeKey("publicKey", parsed.publicKey),
  };
}

export async function loadOrCreateCommitSigner(dir: string): Promise<CommitSigner> {
  const keyDir = path.join(dir, KEY_DIR);
  const filePath = path.join(keyDir, KEY_FILE);
  let keyPair = await loadPersistedKeyPair(filePath);
  if (keyPair === null) {
    const generated = await generateKeyPair();
    await fs.promises.mkdir(keyDir, { recursive: true });
    await fs.promises.writeFile(
      filePath,
      JSON.stringify({
        privateKey: Buffer.from(generated.privateKey).toString("base64"),
        publicKey: Buffer.from(generated.publicKey).toString("base64"),
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    log.debug?.("wrote session commit signing key");
    keyPair = generated;
  }
  return (payload) => createSSHSignature(payload, keyPair.privateKey, keyPair.publicKey);
}
