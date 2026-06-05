import { expect, test } from "bun:test";
import { htmlToMarkdown } from "./markdown.js";

test("strips script and style tags with content", () => {
  const html = `<p>Hello</p><script>alert(1)</script><style>body{color:red}</style><p>World</p>`;
  expect(htmlToMarkdown(html)).toBe("Hello\n\nWorld");
});

test("converts headings", () => {
  const html = "<h1>Title</h1><h2>Subtitle</h2><h3>Section</h3>";
  const md = htmlToMarkdown(html);
  expect(md).toContain("# Title");
  expect(md).toContain("## Subtitle");
  expect(md).toContain("### Section");
});

test("converts links", () => {
  const html = '<a href="https://example.com">Example</a>';
  expect(htmlToMarkdown(html)).toBe("[Example](https://example.com)");
});

test("converts bold and italic", () => {
  const html = "<strong>Bold</strong> and <em>italic</em>";
  expect(htmlToMarkdown(html)).toBe("**Bold** and *italic*");
});

test("converts code inline", () => {
  const html = "Use <code>npm install</code> to install";
  expect(htmlToMarkdown(html)).toBe("Use `npm install` to install");
});

test("converts unordered lists", () => {
  const html = "<ul><li>One</li><li>Two</li></ul>";
  const md = htmlToMarkdown(html);
  expect(md).toContain("- One");
  expect(md).toContain("- Two");
});

test("converts ordered lists", () => {
  const html = "<ol><li>First</li><li>Second</li></ol>";
  const md = htmlToMarkdown(html);
  expect(md).toContain("1. First");
  expect(md).toContain("1. Second");
});

test("converts paragraphs", () => {
  const html = "<p>First paragraph.</p><p>Second paragraph.</p>";
  const md = htmlToMarkdown(html);
  expect(md).toContain("First paragraph.");
  expect(md).toContain("Second paragraph.");
});

test("converts br to newlines", () => {
  const html = "Line one<br>Line two<br/>Line three";
  expect(htmlToMarkdown(html)).toBe("Line one\nLine two\nLine three");
});

test("decodes common entities", () => {
  const html = "&lt;div&gt; &amp; &quot;test&quot;";
  expect(htmlToMarkdown(html)).toBe('<div> & "test"');
});

test("handles nav tag stripping", () => {
  const html = "<nav><a href='/'>Home</a><a href='/about'>About</a></nav><p>Content</p>";
  expect(htmlToMarkdown(html)).toBe("Content");
});

test("handles nested tags", () => {
  const html = "<p><strong>Bold</strong> and <em>italic</em> text</p>";
  expect(htmlToMarkdown(html)).toBe("**Bold** and *italic* text");
});

test("returns empty string for empty input", () => {
  expect(htmlToMarkdown("")).toBe("");
});

test("returns plain text when no tags present", () => {
  expect(htmlToMarkdown("Just plain text")).toBe("Just plain text");
});
