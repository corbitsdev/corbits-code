import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { runWebFetch, MAX_FETCH_BYTES } from "./web-fetch.js";

let server: Server;
let baseUrl: string;
let handler: (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
) => void = (_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html><body><h1>Hello</h1><p>World</p></body></html>");
};

beforeEach(async () => {
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("failed to bind fixture server");
  baseUrl = `http://127.0.0.1:${address.port}`;
  process.env.EVAL_HTTP_URL = `${baseUrl}/`;
});

afterEach(async () => {
  delete process.env.EVAL_HTTP_URL;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("runWebFetch", () => {
  test("converts HTML to markdown by default", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><h1>Hello</h1><p>World</p></body></html>");
    };
    const outcome = await runWebFetch(`${baseUrl}/`, "markdown", 30);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.content).toContain("# Hello");
      expect(outcome.content).toContain("World");
    }
  });

  test("format=text strips tags without markdown syntax", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><h1>Hello</h1></body></html>");
    };
    const outcome = await runWebFetch(`${baseUrl}/`, "text", 30);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.content).not.toContain("#");
  });

  test("format=html returns raw body", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><h1>Raw</h1></body></html>");
    };
    const outcome = await runWebFetch(`${baseUrl}/`, "html", 30);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.content).toContain("<h1>Raw</h1>");
  });

  test("truncates responses over the 5MB cap", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("a".repeat(MAX_FETCH_BYTES + 1024));
    };
    const outcome = await runWebFetch(`${baseUrl}/`, "text", 30);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.truncated).toBe(true);
      expect(outcome.content.length).toBeLessThanOrEqual(MAX_FETCH_BYTES);
    }
  });

  test("times out on a slow response", async () => {
    handler = (_req, res) => {
      // Never respond; rely on the tool's own timeout to abort.
      void res;
    };
    const outcome = await runWebFetch(`${baseUrl}/`, "text", 1);
    expect(outcome.ok).toBe(false);
  });

  test("re-checks SSRF on redirect: refuses a redirect to a private target", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: "http://10.0.0.5/internal" });
      res.end();
    };
    const outcome = await runWebFetch(`${baseUrl}/`, "text", 30);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/private|loopback|link-local/i);
  });

  test("follows a redirect back to the allowed fixture URL", async () => {
    let hit = 0;
    handler = (req, res) => {
      hit += 1;
      if (req.url === "/start") {
        res.writeHead(302, { location: `${baseUrl}/` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("landed");
    };
    const outcome = await runWebFetch(`${baseUrl}/start`, "text", 30);
    // The redirect target (baseUrl/) matches EVAL_HTTP_URL exactly, so it passes
    // the SSRF re-check; the intermediate /start hop is covered separately above.
    expect(outcome.ok).toBe(true);
    expect(hit).toBe(2);
  });

  test("rejects a non-http(s) SSRF target before ever fetching", async () => {
    const outcome = await runWebFetch("ftp://example.com/", "text", 30);
    expect(outcome.ok).toBe(false);
  });
});
