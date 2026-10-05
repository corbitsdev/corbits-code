import { describe, expect, test } from "bun:test";
import { checkUrlForSsrf, isPrivateAddress } from "./ssrf-guard.js";
import { runWithEvalHttpEnv } from "./eval-http-env.js";

describe("isPrivateAddress", () => {
  test("rejects loopback, link-local, and RFC1918 ranges", () => {
    for (const address of [
      "127.0.0.1", // loopback
      "169.254.169.254", // link-local, cloud metadata range
      "10.0.0.5", // RFC1918 10.x
      "172.16.0.1", // RFC1918 172.16-31.x
      "172.31.255.255",
      "192.168.1.1", // RFC1918 192.168.x
      "::1", // IPv6 loopback
      "fe80::1", // IPv6 link-local
    ]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
  });
});

describe("checkUrlForSsrf", () => {
  test("rejects non-http(s) schemes, invalid URLs, and private targets", async () => {
    for (const url of [
      "file:///etc/passwd",
      "not a url",
      "http://127.0.0.1:9999/",
      "http://localhost:9999/",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.1.2.3/",
    ]) {
      expect((await checkUrlForSsrf(url)).ok).toBe(false);
    }
  });
  test("bracketed IPv6 loopback refuses as a private address, not a DNS error", async () => {
    expect(isPrivateAddress("[::1]")).toBe(true);
    expect(isPrivateAddress("[::ffff:127.0.0.1]")).toBe(true);
    for (const url of ["http://[::1]/", "http://[::ffff:127.0.0.1]/"]) {
      const result = await checkUrlForSsrf(url);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/private\/loopback\/link-local/);
        expect(result.reason).not.toMatch(/Could not resolve/);
      }
    }
  });
  test("allows the eval fixture URL exactly when EVAL_HTTP_URL is set", async () => {
    const prior = process.env.EVAL_HTTP_URL;
    process.env.EVAL_HTTP_URL = "http://127.0.0.1:54321/";
    try {
      const allowed = await checkUrlForSsrf("http://127.0.0.1:54321/");
      expect(allowed.ok).toBe(true);
      const other = await checkUrlForSsrf("http://127.0.0.1:1/");
      expect(other.ok).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.EVAL_HTTP_URL;
      else process.env.EVAL_HTTP_URL = prior;
    }
  });
  test("allows the eval fixture URL from the ALS overlay without writing process.env", async () => {
    await runWithEvalHttpEnv(
      { EVAL_HTTP_URL: "http://127.0.0.1:54321/" },
      async () => {
        const allowed = await checkUrlForSsrf("http://127.0.0.1:54321/");
        expect(allowed.ok).toBe(true);
        const other = await checkUrlForSsrf("http://127.0.0.1:1/");
        expect(other.ok).toBe(false);
      },
    );
  });
});
