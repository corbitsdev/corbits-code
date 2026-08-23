import { describe, expect, test } from "bun:test";

import { parseArgs } from "./eval-public-swe-one.js";

describe("parseArgs", () => {
  test("--help does not require provider or model", () => {
    const opts = parseArgs(["--help"]);
    expect(opts.help).toBe(true);
    expect(opts.provider).not.toBe("xai/thegreataxios");
    expect(opts.model).not.toBe("xai/thegreataxios");
  });

  test("--dry-run alone throws", () => {
    expect(() => parseArgs(["--dry-run"])).toThrow(/--provider/);
    expect(() => parseArgs(["--dry-run"])).toThrow(/--model/);
  });

  test("--dry-run with provider and model parses", () => {
    const opts = parseArgs(["--dry-run", "--provider", "foo", "--model", "bar"]);
    expect(opts.dryRun).toBe(true);
    expect(opts.provider).toBe("foo");
    expect(opts.model).toBe("bar");
  });

  test("agent run without --provider throws", () => {
    expect(() => parseArgs(["--model", "bar"])).toThrow(/--provider/);
  });

  test("agent run without --model throws", () => {
    expect(() => parseArgs(["--provider", "foo"])).toThrow(/--model/);
  });

  test("agent run without either flag throws naming both", () => {
    expect(() => parseArgs([])).toThrow(/--provider/);
    expect(() => parseArgs([])).toThrow(/--model/);
  });

  test("--provider foo --model bar parses those values", () => {
    const opts = parseArgs(["--provider", "foo", "--model", "bar"]);
    expect(opts.provider).toBe("foo");
    expect(opts.model).toBe("bar");
  });

  test("parsed defaults never equal xai/thegreataxios", () => {
    const help = parseArgs(["--help"]);
    expect(help.provider).not.toBe("xai/thegreataxios");
    expect(help.model).not.toBe("xai/thegreataxios");
  });
});
