import { describe, expect, test } from "bun:test";

import { callbackPageHtml, humanizeIdentifier } from "./callback-page.js";

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

  test("failure names the server and the humanized reason", () => {
    const html = callbackPageHtml({ subject: "granola", error: "access_denied" });
    expect(html).toContain("Granola failed to connect");
    expect(html).toContain("Access denied.");
    expect(html).not.toContain("access_denied");
  });

  test("an unnamed authorization still renders both outcomes", () => {
    expect(callbackPageHtml()).toContain("Authorization complete");
    expect(callbackPageHtml({ error: "server_error" })).toContain(
      "Authorization did not complete",
    );
  });

  test("the subject is escaped rather than pasted into markup", () => {
    expect(callbackPageHtml({ subject: "<script>x</script>" })).not.toContain(
      "<script>x",
    );
  });

  test("the page reaches for nothing off the machine", () => {
    const html = callbackPageHtml({ subject: "linear" });
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });
});
