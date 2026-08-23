import { describe, expect, test } from "bun:test";
import { htmlToMarkdown, htmlToText } from "./html-convert.js";

describe("htmlToText", () => {
  test("strips tags and decodes entities", () => {
    const html = "<html><body><h1>Hi &amp; Bye</h1><p>Body text</p></body></html>";
    expect(htmlToText(html)).toBe("Hi & Bye\nBody text");
  });
  test("drops script and style content", () => {
    const html = "<p>keep</p><script>evil()</script><style>.x{}</style>";
    expect(htmlToText(html)).toBe("keep");
  });
});

describe("htmlToMarkdown", () => {
  test("converts headings, bold, links, and list items", () => {
    const html =
      '<h1>Title</h1><p>See <a href="https://example.com">the docs</a> and <strong>note</strong>.</p><ul><li>one</li><li>two</li></ul>';
    const md = htmlToMarkdown(html);
    expect(md).toContain("# Title");
    expect(md).toContain("[the docs](https://example.com)");
    expect(md).toContain("**note**");
    expect(md).toContain("- one");
    expect(md).toContain("- two");
  });
});
