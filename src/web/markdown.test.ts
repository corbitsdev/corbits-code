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

test("converts tables", () => {
  const html = "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>";
  expect(htmlToMarkdown(html)).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
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

test("strips blocked tag with no closing tag", () => {
  // When there is no closing </script> tag the open tag itself is stripped
  const html = `<p>Before</p><script src="evil.js"><p>After</p>`;
  const md = htmlToMarkdown(html);
  expect(md).toContain("Before");
  expect(md).toContain("After");
  expect(md).not.toContain("evil.js");
});

test("decodes numeric hex entities", () => {
  // &#x41; = 'A', &#x42; = 'B'
  expect(htmlToMarkdown("&#x41;&#x42;")).toBe("AB");
});

test("decodes decimal numeric entities", () => {
  // &#65; = 'A'
  expect(htmlToMarkdown("&#65;")).toBe("A");
});

test("decodes &nbsp;", () => {
  expect(htmlToMarkdown("hello&nbsp;world")).toBe("hello world");
});

test("converts h4, h5, h6 headings", () => {
  const html = "<h4>H4</h4><h5>H5</h5><h6>H6</h6>";
  const md = htmlToMarkdown(html);
  expect(md).toContain("#### H4");
  expect(md).toContain("##### H5");
  expect(md).toContain("###### H6");
});

test("converts images", () => {
  const html = `<img src="https://example.com/pic.png" alt="pic">`;
  expect(htmlToMarkdown(html)).toContain("![image](https://example.com/pic.png)");
});

test("converts pre/code blocks", () => {
  const html = "<pre>const x = 1;</pre>";
  const md = htmlToMarkdown(html);
  const fences = md.split("```");
  expect(fences.length).toBe(3); // before, content, after
  expect(fences[1]).toContain("const x = 1;");
});

test("converts <b> and <i> tags", () => {
  const html = "<b>bold</b> and <i>italic</i>";
  expect(htmlToMarkdown(html)).toBe("**bold** and *italic*");
});

test("converts table with unequal row widths", () => {
  // Body row with fewer cells than header — should be padded
  const html = "<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td>1</td><td>2</td></tr></table>";
  const md = htmlToMarkdown(html);
  expect(md).toContain("| A | B | C |");
  expect(md).toContain("| 1 | 2 | |");
});

test("returns empty string for table with no rows", () => {
  expect(htmlToMarkdown("<table></table>")).toBe("");
});

test("strips all blocked tags", () => {
  const tags = [
    "header", "footer", "aside", "iframe", "canvas",
    "svg", "noscript", "form", "input", "button",
    "select", "textarea", "label",
  ];
  for (const tag of tags) {
    const html = `<${tag}>content</${tag}><p>visible</p>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain("visible");
    expect(md).not.toContain("content");
  }
});
