import { describe, expect, test } from "bun:test";

import {
  PRODUCT_GITHUB_LABEL,
  PRODUCT_GITHUB_URL,
  PRODUCT_SITE_LABEL,
  PRODUCT_SITE_URL,
} from "../branding.js";
import { callbackPageHtml, humanizeIdentifier } from "./callback-page.js";
import { authorizationDoneHtml } from "./oauth/callback-server.js";

describe("humanizeIdentifier", () => {
  test("machine identifiers lose their separators and lead with a capital", () => {
    expect(humanizeIdentifier("access_denied")).toBe("Access denied");
    expect(humanizeIdentifier("granola")).toBe("Granola");
    expect(humanizeIdentifier("claude-ai-gamma")).toBe("Claude ai gamma");
    expect(humanizeIdentifier("googleDrive")).toBe("Google Drive");
  });

  test("an empty identifier is returned untouched rather than as a stray capital", () => {
    expect(humanizeIdentifier("")).toBe("");
  });
});

describe("callbackPageHtml", () => {
  test("success names the server that connected", () => {
    const html = callbackPageHtml({ subject: "linear" });
    expect(html).toContain("Linear connected successfully");
    expect(html).not.toContain("access_denied");
  });

  test("provider authorization waits for native setup before claiming connection", () => {
    const html = authorizationDoneHtml("Codex");
    expect(html).toContain("Codex authorization received");
    expect(html).toContain("finish setup");
    expect(html).not.toContain("connected successfully");
  });

  test("failure names the server and the humanized reason", () => {
    const html = callbackPageHtml({ subject: "granola", error: "access_denied" });
    expect(html).toContain("Granola failed to connect");
    expect(html).toContain("Access denied.");
    expect(html).not.toContain("access_denied");
  });

  test("an unnamed authorization still renders both outcomes", () => {
    expect(callbackPageHtml()).toContain("Authorization complete");
    expect(callbackPageHtml({ error: "server_error" })).toContain("Authorization did not complete");
  });

  test("the subject is escaped rather than pasted into markup", () => {
    expect(callbackPageHtml({ subject: "<script>x</script>" })).not.toContain("<script>x");
  });

  test("the footer links to the product site and the GitHub org", () => {
    const html = callbackPageHtml({ subject: "linear" });
    const link = (url: string, label: string) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    expect(html).toContain(link(PRODUCT_SITE_URL, PRODUCT_SITE_LABEL));
    expect(html).toContain(link(PRODUCT_GITHUB_URL, PRODUCT_GITHUB_LABEL));
  });

  test("each footer label names the destination its URL actually points at", () => {
    expect(PRODUCT_SITE_URL).toContain(PRODUCT_SITE_LABEL);
    expect(PRODUCT_GITHUB_URL).toContain(PRODUCT_GITHUB_LABEL);
  });

  // An allowlist rather than a shape match: an unexpected origin fails loudly
  // instead of passing because it happened to be wrapped in an anchor tag.
  const allowedOrigins = new Set([
    PRODUCT_SITE_URL,
    PRODUCT_GITHUB_URL,
    // The SVG namespace the wordmark declares; a URI, never fetched.
    "http://www.w3.org/2000/svg",
  ]);

  const offMachineOrigins = (html: string): readonly string[] => {
    // Scheme-qualified and protocol-relative alike, since either would load.
    const found =
      html.match(/(?:[a-z][a-z0-9+.-]*:)?\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+[^"'`)\s<>]*/gi) ?? [];
    return found.filter((ref) => ![...allowedOrigins].some((origin) => ref.startsWith(origin)));
  };

  for (const [outcome, page] of [
    ["success", { subject: "linear" }],
    ["failure", { subject: "linear", error: "access_denied" }],
  ] as const) {
    test(`the ${outcome} page names no off-machine origin beyond the footer links`, () => {
      const html = callbackPageHtml(page);
      expect(offMachineOrigins(html)).toEqual([]);
      expect(html).not.toMatch(
        /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\s*\(/,
      );
    });
  }
});
