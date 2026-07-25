#!/usr/bin/env bash
# Behavioral grader: unauthenticated protected routes must 401; valid JWT must
# authorize; fixture tests must pass. Avoids grepping source for "JWT"/"401".
set -euo pipefail

if [[ ! -f package.json ]]; then
  echo "FAIL: package.json missing in workdir"
  exit 1
fi

bun -e '
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const SECRET = "demo-secret";

function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signJwt(payload, secret) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = createHmac("sha256", secret)
    .update(data)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${data}.${sig}`;
}

const entryCandidates = ["./src/index.ts", "./src/index.js"];
let mod = null;
for (const c of entryCandidates) {
  if (!existsSync(resolve(c))) continue;
  try {
    mod = await import(pathToFileURL(resolve(c)).href);
    break;
  } catch (e) {
    console.error("import failed for", c, e);
  }
}
if (mod === null || typeof mod.handleRequest !== "function") {
  console.error("FAIL: handleRequest not importable from src/index");
  process.exit(1);
}

const handle = mod.handleRequest;

function asStatus(res) {
  if (typeof res === "object" && res !== null && "status" in res) return Number(res.status);
  if (typeof res === "string") {
    try {
      const j = JSON.parse(res);
      if (j && typeof j.status === "number") return j.status;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// Try several call shapes the agent might have introduced for auth headers.
function call(method, path, opts = {}) {
  const { body, headers, auth } = opts;
  const hdrs = { ...(headers ?? {}) };
  if (auth !== undefined) hdrs.Authorization = auth;
  const attempts = [
    () => handle(method, path, body, hdrs),
    () => handle(method, path, { body, headers: hdrs }),
    () => handle({ method, path, body, headers: hdrs }),
    () => handle(method, path, body),
    () => handle(method, path),
  ];
  let lastErr;
  for (const fn of attempts) {
    try {
      return fn();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("all handleRequest call shapes failed");
}

// 1) Unauthenticated access to a protected product route should be 401.
const unauth = call("GET", "/products");
const unauthStatus = asStatus(unauth);
if (unauthStatus !== 401) {
  console.error("FAIL: unauthenticated GET /products expected 401, got", unauthStatus, unauth);
  process.exit(1);
}

// 2) Valid JWT with demo-secret should authorize.
const token = signJwt({ sub: "eval-user", exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
const authz = call("GET", "/products", { auth: `Bearer ${token}` });
const authStatus = asStatus(authz);
if (authStatus !== 200) {
  console.error(
    "FAIL: authenticated GET /products expected 200 with demo-secret JWT, got",
    authStatus,
    authz,
  );
  process.exit(1);
}

// 3) Fixture unit tests must pass (agent should have added JWT coverage).
const test = spawnSync("bun", ["test"], { encoding: "utf8" });
if (test.status !== 0) {
  console.error(test.stdout || "");
  console.error(test.stderr || "");
  console.error("FAIL: bun test failed");
  process.exit(1);
}

console.log("PASS: unauth 401, auth 200, bun test green");
'
