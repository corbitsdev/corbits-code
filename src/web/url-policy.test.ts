import { describe, expect, test } from "bun:test";
import { isBlockedURL } from "./url-policy.js";

describe("isBlockedURL", () => {
  const allowed = [
    "https://example.com",
    "https://example.com/path",
    "https://example.com:8080/path",
    "http://example.com",
    "https://en.wikipedia.org/wiki/Main_Page",
    "https://api.github.com/repos/owner/repo",
  ];
  for (const url of allowed) {
    test(`allows ${url}`, () => {
      const result = isBlockedURL(url);
      expect(result.blocked).toBe(false);
    });
  }

  const blocked = [
    { url: "file:///etc/passwd", reason: "protocol" },
    { url: "ftp://example.com/file", reason: "protocol" },
    { url: "javascript:alert(1)", reason: "protocol" },
    { url: "https://localhost/path", reason: "host" },
    { url: "https://127.0.0.1/path", reason: "host" },
    { url: "https://127.0.0.2/path", reason: "host" },
    { url: "http://10.0.0.1/api", reason: "host" },
    { url: "https://192.168.1.1/", reason: "host" },
    { url: "https://172.16.0.1/", reason: "host" },
    { url: "https://172.31.255.255/", reason: "host" },
    { url: "https://169.254.169.254/latest/meta-data/", reason: "host" },
    { url: "https://169.254.1.1/", reason: "host" },
    { url: "https://[::1]/", reason: "host" },
    { url: "https://[::ffff:127.0.0.1]/", reason: "host" },
    { url: "https://[::ffff:0a00:0001]/", reason: "host" },
    { url: "https://[::ffff:c0a8:0101]/", reason: "host" },
    { url: "https://[::ffff:a9fe:a9fe]/", reason: "host" },
    { url: "https://[fe80::1]/", reason: "host" },
    { url: "https://[fd00::1]/", reason: "host" },
    { url: "https://0.0.0.0/", reason: "host" },
    { url: "https://metadata.google.internal/", reason: "host" },
    { url: "https://user:pass@example.com/", reason: "credentials" },
    { url: "not-a-url", reason: "invalid" },
  ];
  for (const { url, reason } of blocked) {
    test(`blocks ${url} (${reason})`, () => {
      const result = isBlockedURL(url);
      expect(result.blocked).toBe(true);
      if (result.blocked) {
        expect(result.reason).toBeDefined();
      }
    });
  }
});
