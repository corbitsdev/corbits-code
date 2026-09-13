import { describe, expect, test, afterEach } from "bun:test";
import {
  findLinks,
  isOpenableUrl,
  isUrlOpenClick,
  openUrl,
  setUrlOpener,
  resetUrlOpener,
  splitLinkSpans,
} from "../../../src/tui/url-links.js";

afterEach(() => {
  resetUrlOpener();
});

describe("isOpenableUrl", () => {
  test("opens http and https targets", () => {
    expect(isOpenableUrl("http://example.com")).toBe(true);
    expect(isOpenableUrl("https://example.com/docs?q=1#frag")).toBe(true);
    expect(isOpenableUrl("https://localhost:11434")).toBe(true);
  });

  test("never opens non-http(s) schemes", () => {
    expect(isOpenableUrl("ftp://example.com/x")).toBe(false);
    expect(isOpenableUrl("file:///etc/hosts")).toBe(false);
    expect(isOpenableUrl("mailto:a@b.com")).toBe(false);
    expect(isOpenableUrl("javascript:alert(1)")).toBe(false);
    expect(isOpenableUrl("data:text/plain,hi")).toBe(false);
  });

  test("rejects non-URLs", () => {
    expect(isOpenableUrl("")).toBe(false);
    expect(isOpenableUrl("not a url")).toBe(false);
    expect(isOpenableUrl("example.com")).toBe(false);
  });
});

describe("findLinks", () => {
  test("finds an http(s) URL with exact offsets", () => {
    const text = "see https://example.com/docs ok";
    expect(findLinks(text)).toEqual([
      {
        url: "https://example.com/docs",
        start: 4,
        end: 4 + "https://example.com/docs".length,
      },
    ]);
  });

  test("finds several URLs on one line", () => {
    const hits = findLinks("a https://one.example b http://two.example/c");
    expect(hits.map((hit) => hit.url)).toEqual([
      "https://one.example",
      "http://two.example/c",
    ]);
  });

  test("strips trailing prose punctuation", () => {
    expect(findLinks("see https://example.com/x.").map((h) => h.url)).toEqual([
      "https://example.com/x",
    ]);
    expect(
      findLinks("(see https://example.com/x), ok").map((h) => h.url),
    ).toEqual(["https://example.com/x"]);
  });

  test("keeps balanced parens, drops a wrapping one", () => {
    expect(
      findLinks("https://en.wikipedia.org/wiki/PC_(personal)").map(
        (h) => h.url,
      ),
    ).toEqual(["https://en.wikipedia.org/wiki/PC_(personal)"]);
    expect(findLinks("(https://example.com/y)").map((h) => h.url)).toEqual([
      "https://example.com/y",
    ]);
  });

  test("ignores non-http(s) schemes and bare words", () => {
    expect(findLinks("grab ftp://x/y or mailto:a@b, see example.com")).toEqual(
      [],
    );
  });

  test("matches uppercase schemes", () => {
    expect(findLinks("see HTTP://EXAMPLE.COM/x ok").map((h) => h.url)).toEqual([
      "HTTP://EXAMPLE.COM/x",
    ]);
  });
});

describe("splitLinkSpans", () => {
  test("passes URL-free segments through untouched", () => {
    expect(splitLinkSpans([{ text: "plain", fg: "#fff", bold: true }])).toEqual(
      [{ text: "plain", fg: "#fff", bold: true, url: null }],
    );
  });

  test("splits a URL run into its own span, keeping style", () => {
    expect(
      splitLinkSpans([{ text: "see https://example.com/x ok", fg: "#abc" }]),
    ).toEqual([
      { text: "see ", fg: "#abc", bold: undefined, url: null },
      {
        text: "https://example.com/x",
        fg: "#abc",
        bold: undefined,
        url: "https://example.com/x",
      },
      { text: " ok", fg: "#abc", bold: undefined, url: null },
    ]);
  });
});

describe("isUrlOpenClick", () => {
  test("is a left press with Ctrl held, and nothing else", () => {
    const none = { shift: false, alt: false, ctrl: false } as const;
    const ctrl = { shift: false, alt: false, ctrl: true } as const;
    const base = { x: 1, y: 1, modifiers: none } as const;
    expect(isUrlOpenClick({ ...base, button: 0, modifiers: ctrl })).toBe(true);
    expect(isUrlOpenClick({ ...base, button: 0 })).toBe(false);
    expect(isUrlOpenClick({ ...base, button: 2, modifiers: ctrl })).toBe(false);
    expect(isUrlOpenClick({ ...base, button: 1, modifiers: ctrl })).toBe(false);
  });
});

describe("openUrl", () => {
  test("calls the opener with the exact URL (mocked)", () => {
    const calls: string[] = [];
    setUrlOpener((url) => {
      calls.push(url);
    });
    openUrl("https://example.com/docs?a=1");
    expect(calls).toEqual(["https://example.com/docs?a=1"]);
  });

  test("never calls the opener for non-http(s) targets", () => {
    const calls: string[] = [];
    setUrlOpener((url) => {
      calls.push(url);
    });
    openUrl("file:///etc/hosts");
    openUrl("javascript:alert(1)");
    expect(calls).toEqual([]);
  });

  test("a throwing opener does not propagate", () => {
    setUrlOpener(() => {
      throw new Error("no browser");
    });
    expect(() => openUrl("https://example.com")).not.toThrow();
  });

  test("an uppercase URL round-trips through the opener", () => {
    const calls: string[] = [];
    setUrlOpener((url) => {
      calls.push(url);
    });
    openUrl("HTTP://EXAMPLE.COM/x");
    expect(calls).toEqual(["HTTP://EXAMPLE.COM/x"]);
  });
});
