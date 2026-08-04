import { describe, test, expect } from "bun:test";

import type { Settings } from "../config/settings.js";
import {
  DEFAULT_OTEL_SERVICE_NAME,
  OTEL_CONFIG_INVALID,
  OTEL_ENV,
  OtelConfigError,
  isOtelConfigInvalid,
  otelConfigForDump,
  parseOtelKeyValueList,
  requireOtelExportConfig,
  resolveOtelExportConfig,
} from "./otel-config.js";

const baseSettings = (otel?: Settings["otel"]): Settings => ({
  providers: {},
  ...(otel !== undefined ? { otel } : {}),
});

describe("parseOtelKeyValueList", () => {
  test("parses key=value pairs", () => {
    const result = parseOtelKeyValueList("Authorization=Bearer%20tok,x-api-key=abc", "headers");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        Authorization: "Bearer tok",
        "x-api-key": "abc",
      });
    }
  });

  test("rejects malformed entries", () => {
    const result = parseOtelKeyValueList("noequals", "headers");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("expected key=value");
    }
  });

  test("empty string yields empty map", () => {
    const result = parseOtelKeyValueList("", "headers");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({});
  });
});

describe("resolveOtelExportConfig", () => {
  test("disabled when nothing is configured", () => {
    const result = resolveOtelExportConfig(baseSettings(), {});
    expect(result).toEqual({ ok: true, config: { enabled: false } });
  });

  test("disabled when only service name is set", () => {
    const result = resolveOtelExportConfig(baseSettings({ serviceName: "demo" }), {});
    expect(result).toEqual({ ok: true, config: { enabled: false } });
  });

  test("settings endpoint enables export with defaults", () => {
    const result = resolveOtelExportConfig(
      baseSettings({ endpoint: "https://collector.example/v1" }),
      {},
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.config.enabled) {
      expect(result.config.endpoint).toBe("https://collector.example/v1");
      expect(result.config.serviceName).toBe(DEFAULT_OTEL_SERVICE_NAME);
      expect(result.config.headers).toEqual({});
      expect(result.config.resourceAttributes["service.name"]).toBe(DEFAULT_OTEL_SERVICE_NAME);
    }
  });

  test("strips trailing slash from endpoint", () => {
    const result = resolveOtelExportConfig(
      baseSettings({ endpoint: "https://collector.example/v1/" }),
      {},
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.config.enabled) {
      expect(result.config.endpoint).toBe("https://collector.example/v1");
    }
  });

  test("env endpoint overrides settings", () => {
    const result = resolveOtelExportConfig(
      baseSettings({ endpoint: "https://settings.example" }),
      { [OTEL_ENV.endpoint]: "https://env.example/otlp" },
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.config.enabled) {
      expect(result.config.endpoint).toBe("https://env.example/otlp");
    }
  });

  test("env headers replace settings headers", () => {
    const result = resolveOtelExportConfig(
      baseSettings({
        endpoint: "https://collector.example",
        headers: { "x-settings": "secret-settings" },
      }),
      { [OTEL_ENV.headers]: "Authorization=Bearer%20env-secret" },
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.config.enabled) {
      expect(result.config.headers).toEqual({ Authorization: "Bearer env-secret" });
      expect(result.config.headers["x-settings"]).toBeUndefined();
    }
  });

  test("settings headers used when env headers unset", () => {
    const result = resolveOtelExportConfig(
      baseSettings({
        endpoint: "https://collector.example",
        headers: { "x-api-key": "from-settings" },
      }),
      {},
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.config.enabled) {
      expect(result.config.headers).toEqual({ "x-api-key": "from-settings" });
    }
  });

  test("service name: env > settings > default", () => {
    const fromSettings = resolveOtelExportConfig(
      baseSettings({ endpoint: "https://c.example", serviceName: "from-settings" }),
      {},
    );
    expect(fromSettings.ok && fromSettings.config.enabled && fromSettings.config.serviceName).toBe(
      "from-settings",
    );

    const fromEnv = resolveOtelExportConfig(
      baseSettings({ endpoint: "https://c.example", serviceName: "from-settings" }),
      { [OTEL_ENV.serviceName]: "from-env" },
    );
    expect(fromEnv.ok && fromEnv.config.enabled && fromEnv.config.serviceName).toBe("from-env");
  });

  test("resource attributes merge with env winning on conflict", () => {
    const result = resolveOtelExportConfig(
      baseSettings({
        endpoint: "https://c.example",
        resourceAttributes: { "deployment.environment": "settings", team: "corbits" },
      }),
      { [OTEL_ENV.resourceAttributes]: "deployment.environment=prod" },
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.config.enabled) {
      expect(result.config.resourceAttributes["deployment.environment"]).toBe("prod");
      expect(result.config.resourceAttributes.team).toBe("corbits");
      expect(result.config.resourceAttributes["service.name"]).toBe(DEFAULT_OTEL_SERVICE_NAME);
    }
  });

  test("settings enabled false disables when only settings endpoint exists", () => {
    const result = resolveOtelExportConfig(
      baseSettings({ enabled: false, endpoint: "https://c.example" }),
      {},
    );
    expect(result).toEqual({ ok: true, config: { enabled: false } });
  });

  test("env endpoint still enables when settings enabled is false", () => {
    const result = resolveOtelExportConfig(
      baseSettings({ enabled: false, endpoint: "https://settings.example" }),
      { [OTEL_ENV.endpoint]: "https://env.example" },
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.config.enabled) {
      expect(result.config.endpoint).toBe("https://env.example");
    }
  });

  test("fail closed: invalid endpoint URL", () => {
    const result = resolveOtelExportConfig(baseSettings({ endpoint: "not a url" }), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(OTEL_CONFIG_INVALID);
      expect(result.message).toContain("not a valid URL");
    }
  });

  test("fail closed: non-http protocol", () => {
    const result = resolveOtelExportConfig(baseSettings({ endpoint: "ftp://collector.example" }), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("http or https");
    }
  });

  test("fail closed: credentials embedded in endpoint", () => {
    const result = resolveOtelExportConfig(
      baseSettings({ endpoint: "https://user:pass@collector.example" }),
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("must not embed credentials");
    }
  });

  test("fail closed: headers without endpoint", () => {
    const result = resolveOtelExportConfig(
      baseSettings({ headers: { Authorization: "Bearer x" } }),
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(OTEL_CONFIG_INVALID);
      expect(result.message).toContain("no endpoint");
    }
  });

  test("fail closed: enabled true without endpoint", () => {
    const result = resolveOtelExportConfig(baseSettings({ enabled: true }), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("enabled but no endpoint");
    }
  });

  test("fail closed: malformed env headers", () => {
    const result = resolveOtelExportConfig(baseSettings({ endpoint: "https://c.example" }), {
      [OTEL_ENV.headers]: "bad",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain(OTEL_ENV.headers);
    }
  });

  test("fail closed: malformed env resource attributes", () => {
    const result = resolveOtelExportConfig(baseSettings({ endpoint: "https://c.example" }), {
      [OTEL_ENV.resourceAttributes]: "=novalue",
    });
    expect(isOtelConfigInvalid(result)).toBe(true);
  });
});

describe("requireOtelExportConfig", () => {
  test("throws OtelConfigError with stable code on invalid config", () => {
    expect(() => requireOtelExportConfig(baseSettings({ endpoint: "://" }), {})).toThrow(
      OtelConfigError,
    );
    try {
      requireOtelExportConfig(baseSettings({ endpoint: "://" }), {});
    } catch (err) {
      expect(err).toBeInstanceOf(OtelConfigError);
      if (err instanceof OtelConfigError) {
        expect(err.code).toBe(OTEL_CONFIG_INVALID);
        expect(err.message.length).toBeGreaterThan(0);
      }
    }
  });

  test("returns disabled config when unset", () => {
    expect(requireOtelExportConfig(baseSettings(), {})).toEqual({ enabled: false });
  });
});

describe("otelConfigForDump", () => {
  test("never includes header values", () => {
    const resolved = resolveOtelExportConfig(
      baseSettings({
        endpoint: "https://collector.example",
        headers: { Authorization: "Bearer super-secret", "x-api-key": "also-secret" },
        serviceName: "dump-test",
      }),
      {},
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok || !resolved.config.enabled) throw new Error("expected enabled config");

    const dump = otelConfigForDump(resolved.config);
    const serialized = JSON.stringify(dump);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("also-secret");
    expect(serialized).not.toContain("Bearer");
    expect(dump.enabled).toBe(true);
    if (dump.enabled) {
      expect(dump.headerNames).toEqual(["Authorization", "x-api-key"]);
      expect(dump.endpoint).toBe("https://collector.example");
      expect(dump.serviceName).toBe("dump-test");
      // No headers field with values
      expect("headers" in dump).toBe(false);
    }
  });

  test("disabled dump view is empty of secrets", () => {
    expect(otelConfigForDump({ enabled: false })).toEqual({ enabled: false });
  });
});
