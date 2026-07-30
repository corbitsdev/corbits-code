import { describe, expect, test } from "bun:test";
import { checkUrlForSsrf, isPrivateAddress } from "./ssrf-guard.js";

describe("isPrivateAddress", () => {
  test("rejects loopback", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
  });
  test("rejects link-local (169.254.x, cloud metadata range)", () => {
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
  });
  test("rejects RFC1918 10.x", () => {
    expect(isPrivateAddress("10.0.0.5")).toBe(true);
  });
  test("rejects RFC1918 172.16-31.x", () => {
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("172.31.255.255")).toBe(true);
  });
  test("rejects RFC1918 192.168.x", () => {
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
  });
  test("rejects IPv6 loopback and link-local", () => {
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
  });
  test("allows a public IPv4 address", () => {
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
  });
});

describe("checkUrlForSsrf", () => {
  test("rejects non-http(s) schemes", async () => {
    const result = await checkUrlForSsrf("file:///etc/passwd");
    expect(result.ok).toBe(false);
  });
  test("rejects an invalid URL", async () => {
    const result = await checkUrlForSsrf("not a url");
    expect(result.ok).toBe(false);
  });
  test("rejects a literal loopback IP", async () => {
    const result = await checkUrlForSsrf("http://127.0.0.1:9999/");
    expect(result.ok).toBe(false);
  });
  test("rejects localhost by name", async () => {
    const result = await checkUrlForSsrf("http://localhost:9999/");
    expect(result.ok).toBe(false);
  });
  test("rejects a literal link-local IP", async () => {
    const result = await checkUrlForSsrf("http://169.254.169.254/latest/meta-data/");
    expect(result.ok).toBe(false);
  });
  test("rejects a literal 10.x IP", async () => {
    const result = await checkUrlForSsrf("http://10.1.2.3/");
    expect(result.ok).toBe(false);
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
});
