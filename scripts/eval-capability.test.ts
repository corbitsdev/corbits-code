import { describe, expect, test } from "bun:test";

import { parseArgs } from "./eval-capability.ts";

describe("parseArgs", () => {
  test("--help does not require provider or model", () => {
    const opts = parseArgs(["--help"]);
    expect(opts.help).toBe(true);
    expect(opts.provider).not.toBe("xai/thegreataxios");
    expect(opts.model).not.toBe("xai/thegreataxios");
  });

  test("no flags throws", () => {
    expect(() => parseArgs([])).toThrow(/--provider/);
    expect(() => parseArgs([])).toThrow(/--model/);
  });

  test("--provider without --model throws", () => {
    expect(() => parseArgs(["--provider", "foo"])).toThrow(/--model/);
  });

  test("--model without --provider throws", () => {
    expect(() => parseArgs(["--model", "bar"])).toThrow(/--provider/);
  });

  test("--provider foo --model bar parses those values", () => {
    const opts = parseArgs(["--provider", "foo", "--model", "bar"]);
    expect(opts.provider).toBe("foo");
    expect(opts.model).toBe("bar");
  });

  test("--dry-run without pair throws", () => {
    expect(() => parseArgs(["--dry-run"])).toThrow(/--provider/);
    expect(() => parseArgs(["--dry-run"])).toThrow(/--model/);
  });

  test("--matrix xai:grok-4.5 is enough without top-level flags", () => {
    const opts = parseArgs(["--matrix", "xai:grok-4.5"]);
    expect(opts.matrix).toBe("xai:grok-4.5");
  });

  test("incomplete matrix cell throws", () => {
    expect(() => parseArgs(["--matrix", "xai:"])).toThrow(/both provider and model/);
    expect(() => parseArgs(["--matrix", ":grok-4.5"])).toThrow(/both provider and model/);
  });

  test("parsed defaults never equal xai/thegreataxios", () => {
    const help = parseArgs(["--help"]);
    const pair = parseArgs(["--provider", "foo", "--model", "bar"]);
    expect(help.provider).not.toBe("xai/thegreataxios");
    expect(help.model).not.toBe("xai/thegreataxios");
    expect(pair.provider).not.toBe("xai/thegreataxios");
    expect(pair.model).not.toBe("xai/thegreataxios");
    expect(pair.provider).toBe("foo");
    expect(pair.model).toBe("bar");
  });
});
