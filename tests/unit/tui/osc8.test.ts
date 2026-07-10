import { test, expect } from "bun:test";
import { isSafeOsc8Url, osc8Hyperlink } from "../../../src/tui/osc8.js";

test("wraps label with OSC 8 hyperlink sequences", () => {
  const out = osc8Hyperlink("https://example.com", "docs");
  expect(out).toContain("https://example.com");
  expect(out).toContain("docs");
  expect(out).toContain("\x1b]8;;");
  expect(out.startsWith("\x1b]8;;https://example.com\x07")).toBe(true);
  expect(out.endsWith("\x1b]8;;\x07")).toBe(true);
});

test("rejects control characters in the URL and returns bare label", () => {
  expect(osc8Hyperlink("https://evil.com/\x1b[31m", "x")).toBe("x");
  expect(isSafeOsc8Url("https://ok.com")).toBe(true);
  expect(isSafeOsc8Url("javascript:alert(1)")).toBe(false);
  expect(isSafeOsc8Url("")).toBe(false);
});

test("rejects schemes outside the allowlist", () => {
  expect(isSafeOsc8Url("https://ok.com/path")).toBe(true);
  expect(isSafeOsc8Url("http://ok.com")).toBe(true);
  expect(isSafeOsc8Url("mailto:a@b.c")).toBe(true);
  expect(isSafeOsc8Url("file:///tmp/x")).toBe(true);
  expect(isSafeOsc8Url("./rel")).toBe(true);
  expect(isSafeOsc8Url("/abs")).toBe(true);
  expect(isSafeOsc8Url("#frag")).toBe(true);
  expect(isSafeOsc8Url("ftp://evil")).toBe(false);
  expect(isSafeOsc8Url("data://text/html,hi")).toBe(false);
  expect(isSafeOsc8Url("javascript://comment")).toBe(false);
  expect(isSafeOsc8Url("vbscript://x")).toBe(false);
  expect(isSafeOsc8Url("git://host/repo")).toBe(false);
});

test("strips controls from the visible label", () => {
  const out = osc8Hyperlink("https://example.com", "hi\x1b[0m");
  expect(out).not.toContain("\x1b[0m");
  expect(out).toContain("hi");
});
