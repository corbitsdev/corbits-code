import { describe, test, expect } from "bun:test";
import {
  CREDENTIAL_REDACTION,
  scrubSecretShapedContent,
  scrubSecretShapedValue,
} from "./tool-result-secret-scrub.js";
import { toolResultSecretScrubPlugin } from "./tool-result-secret-scrub-plugin.js";
import { resultTruncationPlugin } from "./result-truncation-plugin.js";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

describe("scrubSecretShapedContent", () => {
  test("redacts grep-surfaced .env assignment", () => {
    const text = "./app/.env:3:API_KEY=sk-live-abc123";
    const out = scrubSecretShapedContent(text);
    expect(out).toContain(`API_KEY=${CREDENTIAL_REDACTION}`);
    expect(out).not.toContain("sk-live-abc123");
  });

  test("redacts PEM block in shell output", () => {
    const pem = `-----BEGIN PRIVATE KEY-----
MIIEpAIBAAKCAQEA7
-----END PRIVATE KEY-----`;
    const text = `wrote key:\n${pem}\n`;
    const out = scrubSecretShapedContent(text);
    expect(out).toBe(`wrote key:\n${CREDENTIAL_REDACTION}\n`);
    expect(out).not.toContain("MIIEpAIBAAKCAQEA7");
  });

  test("is idempotent for redacted query parameters", () => {
    const text =
      "GET https://provider.invalid/v1?api_key=sk-live-secret-value-here&model=test";
    const once = scrubSecretShapedContent(text);

    expect(scrubSecretShapedContent(once)).toBe(once);
    expect(once).toBe(
      `GET https://provider.invalid/v1?api_key=${CREDENTIAL_REDACTION}&model=test`,
    );
  });

  test("passes benign documentation mentioning API keys", () => {
    const text =
      "See docs/authentication.md for how API keys are issued and rotated. No secrets in this paragraph.";
    expect(scrubSecretShapedContent(text)).toBe(text);
  });

  test("redacts bare-KEY env assignments (CL-10756)", () => {
    for (const key of ["OPENAI_KEY", "STRIPE_KEY", "GITHUB_KEY"]) {
      const text = `./app/.env:7:${key}=proj-live-value-9z`;
      const out = scrubSecretShapedContent(text);
      expect(out).toContain(`${key}=${CREDENTIAL_REDACTION}`);
      expect(out).not.toContain("proj-live-value-9z");
    }
  });

  test("redacts credential-bearing DATABASE_URL connection strings (CL-10756)", () => {
    const text =
      "./app/.env:2:DATABASE_URL=postgres://admin:s3cret-pw@db.internal:5432/appdb";
    const out = scrubSecretShapedContent(text);
    expect(out).toContain(`DATABASE_URL=${CREDENTIAL_REDACTION}`);
    expect(out).not.toContain("s3cret-pw");
  });

  test("leaves non-secret KEY words and credential-less URLs alone (CL-10756)", () => {
    expect(scrubSecretShapedContent("MONKEY=banana")).toBe("MONKEY=banana");
    expect(scrubSecretShapedContent("DATABASE_URL=sqlite:///local.db")).toBe(
      "DATABASE_URL=sqlite:///local.db",
    );
  });

  test("leaves scoped npm URLs and email-query URLs readable", () => {
    const registry = "REGISTRY_URL=https://registry.npmjs.org/@scope/pkg";
    const docs = "DOCS_URL=https://medium.com/@octocat/hello";
    const support =
      "SUPPORT_URL=https://example.com/help?email=dev@example.com";
    expect(scrubSecretShapedContent(registry)).toBe(registry);
    expect(scrubSecretShapedContent(docs)).toBe(docs);
    expect(scrubSecretShapedContent(support)).toBe(support);
  });

  test("redacts user:pass@host connection URLs", () => {
    const text = "DATABASE_URL=postgres://admin:foo@db.internal:5432/appdb";
    const out = scrubSecretShapedContent(text);
    expect(out).toBe(`DATABASE_URL=${CREDENTIAL_REDACTION}`);
    expect(out).not.toContain("admin:foo");
  });

  test("redacts the whole env value when it contains its own key", () => {
    const text = "OPENAI_KEY=proj-OPENAI_KEY-live-value-9z";
    const out = scrubSecretShapedContent(text);
    expect(out).toBe(`OPENAI_KEY=${CREDENTIAL_REDACTION}`);
    expect(out).not.toContain("proj-");
    expect(out).not.toContain("live-value-9z");
  });

  test("redacts Password= DSNs that lack a scheme", () => {
    const text =
      "DATABASE_URL=Server=db.internal;Database=appdb;User Id=admin;Password=s3cret-pw;";
    const out = scrubSecretShapedContent(text);
    expect(out).toBe(`DATABASE_URL=${CREDENTIAL_REDACTION}`);
    expect(out).not.toContain("s3cret-pw");
  });
});

describe("scrubSecretShapedValue", () => {
  test("keeps object structure while scrubbing string leaves", () => {
    const input = {
      stdout: "token sk-abcdefghijklmnopqrstuvwxyz012345",
      code: 1,
      nested: { api_key: "sk-abcdefghijklmnopqrstuvwxyz012345" },
    };
    const out = scrubSecretShapedValue(input);
    expect(out).toEqual({
      stdout: `token ${CREDENTIAL_REDACTION}`,
      code: 1,
      nested: { api_key: CREDENTIAL_REDACTION },
    });
    expect(typeof out).toBe("object");
    expect(input.nested.api_key).toBe("sk-abcdefghijklmnopqrstuvwxyz012345");
  });
});

describe("scrubSecretShapedValue normalization", () => {
  test("redacts short values selected by credential-named keys", () => {
    const out = scrubSecretShapedValue({
      apiKey: "a",
      nested: {
        api_key: "b",
        accessToken: "c",
        token: "d",
        password: "e",
        secret: "f",
        credential: "g",
        authorization: "h",
        auth: "i",
      },
    });

    expect(out).toEqual({
      apiKey: CREDENTIAL_REDACTION,
      nested: {
        api_key: CREDENTIAL_REDACTION,
        accessToken: CREDENTIAL_REDACTION,
        token: CREDENTIAL_REDACTION,
        password: CREDENTIAL_REDACTION,
        secret: CREDENTIAL_REDACTION,
        credential: CREDENTIAL_REDACTION,
        authorization: CREDENTIAL_REDACTION,
        auth: CREDENTIAL_REDACTION,
      },
    });
  });

  test("preserves special own keys without changing object prototypes", () => {
    const input = JSON.parse(
      '{"__proto__":"top","constructor":"ctor","nested":{"__proto__":"nested"}}',
    ) as Record<string, unknown>;

    const out = scrubSecretShapedValue(input) as Record<string, unknown>;
    const nested = out.nested as Record<string, unknown>;

    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(Object.getPrototypeOf(nested)).toBeNull();
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(Object.hasOwn(out, "constructor")).toBe(true);
    expect(Object.hasOwn(nested, "__proto__")).toBe(true);
    expect(JSON.stringify(out)).toBe(JSON.stringify(input));
    expect(({} as Record<string, unknown>).top).toBeUndefined();
    expect(({} as Record<string, unknown>).nested).toBeUndefined();
  });

  test("rejects accessors without invoking them", () => {
    let reads = 0;
    const input = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => {
        reads++;
        return "short-secret";
      },
    });

    expect(() => scrubSecretShapedValue(input)).toThrow();
    expect(reads).toBe(0);
  });

  test("rejects custom serialization without invoking it", () => {
    let calls = 0;
    const input = {
      safe: "value",
      toJSON: () => {
        calls++;
        return { leaked: "short-secret" };
      },
    };

    expect(() => scrubSecretShapedValue(input)).toThrow();
    expect(calls).toBe(0);
  });

  test.each([
    ["function", () => undefined],
    ["symbol", Symbol("unsupported")],
    ["bigint", 1n],
    ["undefined", undefined],
  ])("rejects %s values", (_name, value) => {
    expect(() => scrubSecretShapedValue({ value })).toThrow();
  });

  test("rejects cycles and custom object behavior", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => scrubSecretShapedValue(cyclic)).toThrow();
    expect(() => scrubSecretShapedValue({ value: new Date(0) })).toThrow();
  });
});
describe("scrubSecretShapedValue key handling", () => {
  test("scrubs credential-shaped keys recursively", () => {
    const topLevelKey = ["sk-", "live-", "a".repeat(24)].join("");
    const nestedKey = `prefix-${["sk-", "live-", "b".repeat(24)].join("")}`;

    const out = scrubSecretShapedValue({
      [topLevelKey]: "top-level",
      nested: { [nestedKey]: "nested" },
    });
    const serialized = JSON.stringify(out);

    expect(out).toEqual({
      [CREDENTIAL_REDACTION]: "top-level",
      nested: { [`prefix-${CREDENTIAL_REDACTION}`]: "nested" },
    });
    expect(serialized).not.toContain(topLevelKey);
    expect(serialized).not.toContain(nestedKey);
  });

  test("resolves scrubbed key collisions deterministically without raw keys", () => {
    const firstKey = ["sk-", "live-", "a".repeat(24)].join("");
    const secondKey = ["sk-", "live-", "b".repeat(24)].join("");

    const out = scrubSecretShapedValue({
      [firstKey]: "first",
      [secondKey]: "second",
      [CREDENTIAL_REDACTION]: "already-redacted",
    }) as Record<string, unknown>;
    const serialized = JSON.stringify(out);

    const keys = Object.keys(out);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
    expect(keys.every((k) => k.startsWith(CREDENTIAL_REDACTION))).toBe(true);
    expect(Object.values(out)).toEqual(["first", "second", "already-redacted"]);
    expect(serialized).not.toContain(firstKey);
    expect(serialized).not.toContain(secondKey);
  });
});

describe("bare-KEY names in JSON paths", () => {
  test("redacts bare-KEY names in JSON objects", () => {
    const out = scrubSecretShapedValue({
      OPENAI_KEY: "sk-live-abc123",
      nested: { MY_API_KEY: "stripe-live-xyz" },
    });
    expect(out).toEqual({
      OPENAI_KEY: CREDENTIAL_REDACTION,
      nested: { MY_API_KEY: CREDENTIAL_REDACTION },
    });
  });

  test("redacts bare-KEY names in JSON text", () => {
    const pretty = scrubSecretShapedContent('{"OPENAI_KEY": "sk-live-abc123"}');
    expect(pretty).toBe(`{"OPENAI_KEY": "${CREDENTIAL_REDACTION}"}`);
    const compact = scrubSecretShapedContent('{"OPENAI_KEY":"sk-live-abc123"}');
    expect(compact).toBe(`{"OPENAI_KEY":"${CREDENTIAL_REDACTION}"}`);
    expect(compact).not.toContain("sk-live-abc123");
  });

  test("leaves MONKEY-style words and ordinary key fields alone", () => {
    const value = scrubSecretShapedValue({
      MONKEY: "banana",
      monkey: "banana",
      key: "ctrl+s",
      hotkey: "ctrl+s",
    });
    expect(value).toEqual({
      MONKEY: "banana",
      monkey: "banana",
      key: "ctrl+s",
      hotkey: "ctrl+s",
    });
    const text = '{"MONKEY": "banana", "key": "ctrl+s"}';
    expect(scrubSecretShapedContent(text)).toBe(text);
  });
});

describe("query secrets keep characters after quotes", () => {
  test("does not leave a tail after a quote in password, api_key, or token", () => {
    for (const name of ["password", "api_key", "token"] as const) {
      for (const quote of ["'", '"'] as const) {
        const text = `GET https://provider.invalid/v1?${name}=p${quote}LEAKTAIL&format=json`;
        const out = scrubSecretShapedContent(text);
        expect(out).toBe(
          `GET https://provider.invalid/v1?${name}=${CREDENTIAL_REDACTION}&format=json`,
        );
        expect(out).not.toContain("LEAKTAIL");
      }
    }
  });
});

describe("storage key names stay readable", () => {
  test("keeps partition, sort, primary, cache, and prompt_cache keys", () => {
    const value = {
      partition_key: "tenant",
      sort_key: 2,
      primary_key: ["id"],
      cache_key: [1, 2],
      prompt_cache_key: 9,
      OPENAI_KEY: "sk-live-abc123",
      api_key: ["still-secret"],
    };
    expect(scrubSecretShapedValue(value)).toEqual({
      partition_key: "tenant",
      sort_key: 2,
      primary_key: ["id"],
      cache_key: [1, 2],
      prompt_cache_key: 9,
      OPENAI_KEY: CREDENTIAL_REDACTION,
      api_key: CREDENTIAL_REDACTION,
    });

    const text =
      '{"partition_key":"tenant","sort_key":2,"primary_key":["id"],"cache_key":[1],"prompt_cache_key":"sess","OPENAI_KEY":"sk-live-abc123","api_key":"still-secret"}';
    const scrubbed = scrubSecretShapedContent(text);
    expect(scrubbed).toContain('"partition_key":"tenant"');
    expect(scrubbed).toContain('"sort_key":2');
    expect(scrubbed).toContain('"primary_key":["id"]');
    expect(scrubbed).toContain('"cache_key":[1]');
    expect(scrubbed).toContain('"prompt_cache_key":"sess"');
    expect(scrubbed).not.toContain("sk-live-abc123");
    expect(scrubbed).not.toContain("still-secret");

    const query =
      "GET https://provider.invalid/v1?sort_key=created_at&partition_key=tenant&format=json";
    expect(scrubSecretShapedContent(query)).toBe(query);
  });
});

describe("bare-KEY names in query parameters", () => {
  test("redacts ?OPENAI_KEY= among benign params, adjacent params survive", () => {
    const text =
      "GET https://provider.invalid/v1?model=test&OPENAI_KEY=live-value&format=json";
    const out = scrubSecretShapedContent(text);
    expect(out).toBe(
      `GET https://provider.invalid/v1?model=test&OPENAI_KEY=${CREDENTIAL_REDACTION}&format=json`,
    );
    expect(out).not.toContain("live-value");
  });

  test("redacts bare-KEY query params case-insensitively with quote bounds", () => {
    const out = scrubSecretShapedContent(
      '{"url": "https://provider.invalid/v1?openai_key=live-value&model=test"}',
    );
    expect(out).toBe(
      `{"url": "https://provider.invalid/v1?openai_key=${CREDENTIAL_REDACTION}&model=test"}`,
    );
    expect(out).not.toContain("live-value");
  });

  test("leaves MONKEY-style and ordinary query params alone", () => {
    const text =
      "GET https://provider.invalid/v1?MONKEY=banana&model=test&format=json";
    expect(scrubSecretShapedContent(text)).toBe(text);
  });
});

describe("toolResultSecretScrubPlugin", () => {
  const next =
    (content: ToolResult["content"], isError = false) =>
    async (call: ToolCall): Promise<ToolResult> => ({
      callId: call.id,
      content,
      ...(isError ? { isError: true } : {}),
    });

  test("scrubs grep tool results", async () => {
    const plugin = toolResultSecretScrubPlugin();
    if (plugin.middleware === undefined)
      throw new Error("expected middleware plugin");
    const handler = plugin.middleware(
      next("secrets/.env:1:TOKEN=supersecretvalue"),
    );
    const result = await handler(
      { id: "c1", name: "grep", arguments: { pattern: "TOKEN" } },
      new AbortController().signal,
    );
    expect(result.content).toContain(CREDENTIAL_REDACTION);
    expect(result.content).not.toContain("supersecretvalue");
  });
  test("scrubs bare-KEY and DATABASE_URL through the shared middleware path (CL-10756)", async () => {
    const plugin = toolResultSecretScrubPlugin();
    if (plugin.middleware === undefined)
      throw new Error("expected middleware plugin");
    const handler = plugin.middleware(
      next(
        "secrets/.env:7:OPENAI_KEY=proj-live-value-9z\nsecrets/.env:2:DATABASE_URL=postgres://admin:s3cret-pw@db.internal:5432/appdb",
      ),
    );
    const result = await handler(
      { id: "c2", name: "read_file", arguments: { path: "secrets/.env" } },
      new AbortController().signal,
    );
    expect(result.content).toContain(`OPENAI_KEY=${CREDENTIAL_REDACTION}`);
    expect(result.content).toContain(`DATABASE_URL=${CREDENTIAL_REDACTION}`);
    expect(result.content).not.toContain("proj-live-value-9z");
    expect(result.content).not.toContain("s3cret-pw");
  });
  test("scrubs error results without stringifying object content", async () => {
    const plugin = toolResultSecretScrubPlugin();
    if (plugin.middleware === undefined)
      throw new Error("expected middleware plugin");
    const handler = plugin.middleware(
      next(
        {
          message: "failed with sk-abcdefghijklmnopqrstuvwxyz012345",
          code: 7,
        },
        true,
      ),
    );
    const result = await handler(
      { id: "c-err", name: "run_shell", arguments: { command: "exit 7" } },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(typeof result.content).toBe("object");
    expect(result.content).toEqual({
      message: `failed with ${CREDENTIAL_REDACTION}`,
      code: 7,
    });
  });

  test("preserves query redaction through the long-result middleware chain", async () => {
    const content =
      "GET https://provider.invalid/v1?api_key=sk-live-secret-value-here&model=test\n" +
      "x".repeat(11_000);
    const scrub = toolResultSecretScrubPlugin();
    const truncate = resultTruncationPlugin();
    if (scrub.middleware === undefined || truncate.middleware === undefined) {
      throw new Error("expected middleware plugins");
    }
    const handler = truncate.middleware(scrub.middleware(next(content)));

    const result = await handler(
      { id: "c-long", name: "grep", arguments: { pattern: "api_key" } },
      new AbortController().signal,
    );

    if (typeof result.content !== "string")
      throw new Error("expected text tool result");
    expect(result.content).toContain(
      `api_key=${CREDENTIAL_REDACTION}&model=test`,
    );
    expect(result.content.split(CREDENTIAL_REDACTION).length - 1).toBe(1);
  });
});
