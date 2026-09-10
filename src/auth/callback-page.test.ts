import { describe, expect, test } from "bun:test";

import {
  authorizationDoneHtml,
  callbackPageHtml,
  humanizeIdentifier,
  type CallbackPageCopy,
} from "./callback-page.js";

const copy: CallbackPageCopy = {
  productName: "Fixture Product",
  siteUrl: "https://fixture.example",
  siteLabel: "fixture.example",
  githubUrl: "https://github.com/fixture",
  githubLabel: "github.com/fixture",
};

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
    const html = callbackPageHtml({ subject: "linear" }, copy);
    expect(html).toContain("Linear connected successfully");
    expect(html).not.toContain("access_denied");
  });

  test("provider authorization waits for native setup before claiming connection", () => {
    const html = authorizationDoneHtml("Codex", copy);
    expect(html).toContain("Codex authorization received");
    expect(html).toContain("finish setup");
    expect(html).not.toContain("connected successfully");
  });

  test("failure names the server and the humanized reason", () => {
    const html = callbackPageHtml(
      {
        subject: "granola",
        error: "access_denied",
      },
      copy,
    );
    expect(html).toContain("Granola failed to connect");
    expect(html).toContain("Access denied.");
    expect(html).not.toContain("access_denied");
  });

  test("an unnamed authorization still renders both outcomes", () => {
    expect(callbackPageHtml({}, copy)).toContain("Authorization complete");
    expect(callbackPageHtml({ error: "server_error" }, copy)).toContain(
      "Authorization did not complete",
    );
  });

  test("the subject is escaped rather than pasted into markup", () => {
    expect(
      callbackPageHtml({ subject: "<script>x</script>" }, copy),
    ).not.toContain("<script>x");
  });

  test("the footer links to the injected site and GitHub copy", () => {
    const html = callbackPageHtml({ subject: "linear" }, copy);
    const link = (url: string, label: string) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    expect(html).toContain(link(copy.siteUrl, copy.siteLabel));
    expect(html).toContain(link(copy.githubUrl, copy.githubLabel));
  });

  // An allowlist rather than a shape match: an unexpected origin fails loudly
  // instead of passing because it happened to be wrapped in an anchor tag.
  const allowedOrigins = new Set([
    copy.siteUrl,
    copy.githubUrl,
    // The SVG namespace the wordmark declares; a URI, never fetched.
    "http://www.w3.org/2000/svg",
  ]);

  const offMachineOrigins = (html: string): readonly string[] => {
    // Scheme-qualified and protocol-relative alike, since either would load.
    const found =
      html.match(
        /(?:[a-z][a-z0-9+.-]*:)?\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+[^"'`)\s<>]*/gi,
      ) ?? [];
    return found.filter(
      (ref) => ![...allowedOrigins].some((origin) => ref.startsWith(origin)),
    );
  };

  for (const [outcome, page] of [
    ["success", { subject: "linear" }],
    ["failure", { subject: "linear", error: "access_denied" }],
  ] as const) {
    test(`the ${outcome} page names no off-machine origin beyond the footer links`, () => {
      const html = callbackPageHtml(page, copy);
      expect(offMachineOrigins(html)).toEqual([]);
      expect(html).not.toMatch(
        /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\s*\(/,
      );
    });
  }
});
