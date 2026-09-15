import { describe, expect, test, afterEach } from "bun:test";
import {
  findLinks,
  hitUrlAt,
  isOpenableUrl,
  isUrlOpenClick,
  linkColumnHits,
  openUrl,
  platformUrlCommand,
  setUrlOpener,
  resetUrlOpener,
  splitLinkSpans,
  splitWrappedLinkSpans,
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
    const out = splitLinkSpans([{ text: "plain", fg: "#fff", bold: true }]);
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe("plain");
    expect(out[0]?.fg).toBe("#fff");
    expect(out[0]?.bold).toBe(true);
    expect(out[0]?.url).toBeNull();
  });

  test("splits a URL run into its own span, keeping style", () => {
    const input = "see https://example.com/x ok";
    const out = splitLinkSpans([{ text: input, fg: "#abc" }]);
    expect(out.map((span) => span.text).join("")).toBe(input);
    const linked = out.filter((span) => span.url !== null);
    expect(linked).toHaveLength(1);
    const target = linked[0]?.url;
    if (typeof target !== "string") throw new Error("expected a link target");
    expect(linked[0]?.text).toBe(target);
    for (const span of out) {
      expect(span.fg).toBe("#abc");
    }
  });
});

describe("splitWrappedLinkSpans", () => {
  const urls = (rows: { url: string | null }[][]): (string | null)[][] =>
    rows.map((row) => row.map((span) => span.url));

  test("a URL broken across two lines resolves to one target", () => {
    const full = "https://example.com/ab";
    const inputs = [
      { text: "x https://example.co", fg: "#abc" },
      { text: "m/ab", fg: "#abc" },
    ];
    const rows = splitWrappedLinkSpans(inputs, 20);
    expect(urls(rows)).toEqual([[null, full], [full]]);
    expect(
      rows
        .flat()
        .map((span) => span.text)
        .join(""),
    ).toBe(inputs.map((row) => row.text).join(""));
  });

  test("a chain runs through a full middle line to a mid-line end", () => {
    const full = "https://example.com/ab";
    const rows = splitWrappedLinkSpans(
      [
        { text: "o https://", fg: "#abc" },
        { text: "example.co", fg: "#abc" },
        { text: "m/ab end", fg: "#abc" },
      ],
      10,
    );
    expect(urls(rows)).toEqual([[null, full], [full], [full, null]]);
  });

  test("a short seed line never starts a chain", () => {
    const rows = splitWrappedLinkSpans(
      [
        { text: "x https://", fg: "#abc" },
        { text: "example.com", fg: "#abc" },
      ],
      10,
    );
    expect(urls(rows)).toEqual([[null], [null]]);
  });

  test("a short continuation with text after it is a natural break", () => {
    const rows = splitWrappedLinkSpans(
      [
        { text: "x https://example.co", fg: "#abc" },
        { text: "m/ab", fg: "#abc" },
        { text: "more words here", fg: "#abc" },
      ],
      20,
    );
    expect(urls(rows)).toEqual([[null, "https://example.co"], [null], [null]]);
  });

  test("a blank continuation line breaks the chain", () => {
    const rows = splitWrappedLinkSpans(
      [
        { text: "o https://", fg: "#abc" },
        { text: "", fg: "#abc" },
      ],
      10,
    );
    expect(urls(rows)).toEqual([[null], [null]]);
  });

  test("a user-bubble pad row ends the chain", () => {
    const full = "https://example.com/ab";
    const rows = splitWrappedLinkSpans(
      [
        { text: "o https://", fg: "#abc" },
        { text: "example.co", fg: "#abc" },
        { text: "m/ab", fg: "#abc" },
        { text: "▍", fg: "#abc" },
      ],
      10,
    );
    expect(urls(rows)).toEqual([[null, full], [full], [full], [null]]);
  });

  test("a hitless seed with a short tail fuses against its source URL", () => {
    // Geometry alone reads this as prose that happens to scan (see the
    // short-seed test above), but the row's pre-wrap text settles it: the
    // fragments reassemble to a link the row actually holds.
    const full = "https://x.y";
    const rows = splitWrappedLinkSpans(
      [
        { text: "o https://", fg: "#abc" },
        { text: "x.y", fg: "#abc" },
      ],
      10,
      [full],
    );
    expect(urls(rows)).toEqual([[null, full], [full]]);
  });

  test("a fused candidate the source never held stays unfused", () => {
    const rows = splitWrappedLinkSpans(
      [
        { text: "x https://example.co", fg: "#abc" },
        { text: "m/ab", fg: "#abc" },
      ],
      20,
      ["https://other.example/z"],
    );
    expect(urls(rows)).toEqual([[null, "https://example.co"], [null]]);
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

describe("platformUrlCommand", () => {
  test("windows opens without cmd /c so metacharacters never parse", () => {
    const url = "https://example.com/x?a=1&b=2";
    expect(platformUrlCommand("win32", url)).toEqual([
      "rundll32",
      "url.dll,FileProtocolHandler",
      url,
    ]);
    expect(platformUrlCommand("win32", url)).not.toContain("cmd");
  });

  test("darwin and linux use their openers with the URL as argv", () => {
    expect(platformUrlCommand("darwin", "https://example.com")).toEqual([
      "open",
      "https://example.com",
    ]);
    expect(platformUrlCommand("linux", "https://example.com")).toEqual([
      "xdg-open",
      "https://example.com",
    ]);
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

describe("linkColumnHits/hitUrlAt edges", () => {
  const one = "https://example.com/x";
  const hits = linkColumnHits(
    splitLinkSpans([{ text: `see ${one} ok`, fg: "#fff" }]),
  );

  test("one line maps to one inclusive-start, exclusive-end range", () => {
    expect(hits).toEqual([{ url: one, start: 4, end: 25 }]);
  });

  test.each([
    ["before the line", -1, null],
    ["prose", 0, null],
    ["last prose column", 3, null],
    ["inclusive start", 4, one],
    ["mid-link", 14, one],
    ["inclusive end", 24, one],
    ["exclusive end", 25, null],
    ["trailing prose", 26, null],
    ["past the line end", 100, null],
  ])("column %s resolves", (_label, column, expected) => {
    expect(hitUrlAt(hits, column)).toBe(expected);
  });

  test.each([
    ["first link tail", 20, "https://one.example"],
    ["gap between links", 21, null],
    ["gap prose", 23, null],
    ["second link head", 24, "http://two.example/c"],
    ["second link tail", 43, "http://two.example/c"],
    ["past the second link", 44, null],
  ])("adjacent links: column %s resolves", (_label, column, expected) => {
    const adjacent = linkColumnHits(
      splitLinkSpans([
        { text: "a https://one.example b http://two.example/c", fg: "#fff" },
      ]),
    );
    expect(adjacent).toHaveLength(2);
    expect(hitUrlAt(adjacent, column)).toBe(expected);
  });

  test("a non-openable span url never becomes a hit", () => {
    expect(
      linkColumnHits([{ text: "x", fg: "#fff", url: "javascript:alert(1)" }]),
    ).toEqual([]);
    expect(linkColumnHits([])).toEqual([]);
    expect(hitUrlAt([], 0)).toBeNull();
  });
});
