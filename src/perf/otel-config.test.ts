import { describe, test, expect } from "bun:test";

import type { Settings } from "../config/settings.js";
import {
  DEFAULT_OTEL_SERVICE_NAME,
  OTEL_CONFIG_INVALID,
  OTEL_ENV,
  OtelConfigError,
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
    const result = parseOtelKeyValueList(
      "Authorization=Bearer%20tok,x-api-key=abc",
      "headers",
    );
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
  test("disabled without an endpoint, even when a service name is set", () => {
    expect(resolveOtelExportConfig(baseSettings(), {})).toEqual({
      ok: true,
      config: { enabled: false },
    });
    expect(
      resolveOtelExportConfig(baseSettings({ serviceName: "demo" }), {}),
    ).toEqual({ ok: true, config: { enabled: false } });
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
      expect(result.config.resourceAttributes["service.name"]).toBe(
        DEFAULT_OTEL_SERVICE_NAME,
      );
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
      {
        [OTEL_ENV.endpoint]: "https://env.example/otlp",
      },
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
      expect(result.config.headers).toEqual({
        Authorization: "Bearer env-secret",
      });
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

  test("service name precedence: env > settings > attrs, synced to attrs", () => {
    const cases: {
      otel: Settings["otel"];
      env: Record<string, string>;
      serviceName: string;
      extraAttrs?: Record<string, string>;
    }[] = [
      {
        otel: { endpoint: "https://c.example", serviceName: "from-settings" },
        env: {},
        serviceName: "from-settings",
      },
      {
        otel: { endpoint: "https://c.example", serviceName: "from-settings" },
        env: { [OTEL_ENV.serviceName]: "from-env" },
        serviceName: "from-env",
      },
      {
        otel: {
          endpoint: "https://c.example",
          resourceAttributes: { "service.name": "from-attrs" },
        },
        env: {},
        serviceName: "from-attrs",
      },
      {
        otel: {
          endpoint: "https://c.example",
          serviceName: "from-settings",
          resourceAttributes: { "service.name": "from-attrs" },
        },
        env: { [OTEL_ENV.serviceName]: "from-env" },
        serviceName: "from-env",
      },
      {
        otel: {
          endpoint: "https://c.example",
          serviceName: "from-settings",
          resourceAttributes: { "service.name": "from-attrs" },
        },
        env: {},
        serviceName: "from-settings",
      },
      {
        otel: { endpoint: "https://c.example" },
        env: {
          [OTEL_ENV.resourceAttributes]:
            "service.name=from-env-attrs,team=corbits",
        },
        serviceName: "from-env-attrs",
        extraAttrs: { team: "corbits" },
      },
    ];
    for (const { otel, env, serviceName, extraAttrs } of cases) {
      const result = resolveOtelExportConfig(baseSettings(otel), env);
      expect(result.ok).toBe(true);
      if (result.ok && result.config.enabled) {
        expect(result.config.serviceName).toBe(serviceName);
        expect(result.config.resourceAttributes["service.name"]).toBe(
          serviceName,
        );
        for (const [key, value] of Object.entries(extraAttrs ?? {})) {
          expect(result.config.resourceAttributes[key]).toBe(value);
        }
      }
    }
  });

  test("resource attributes merge with env winning on conflict", () => {
    const result = resolveOtelExportConfig(
      baseSettings({
        endpoint: "https://c.example",
        resourceAttributes: {
          "deployment.environment": "settings",
          team: "corbits",
        },
      }),
      { [OTEL_ENV.resourceAttributes]: "deployment.environment=prod" },
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.config.enabled) {
      expect(result.config.resourceAttributes["deployment.environment"]).toBe(
        "prod",
      );
      expect(result.config.resourceAttributes.team).toBe("corbits");
      expect(result.config.resourceAttributes["service.name"]).toBe(
        DEFAULT_OTEL_SERVICE_NAME,
      );
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

  test("fail closed on invalid config", () => {
    const cases: {
      otel: Settings["otel"];
      env?: Record<string, string>;
      message?: string;
    }[] = [
      { otel: { endpoint: "not a url" }, message: "not a valid URL" },
      {
        otel: { endpoint: "ftp://collector.example" },
        message: "http or https",
      },
      {
        otel: { endpoint: "https://user:pass@collector.example" },
        message: "must not embed credentials",
      },
      {
        otel: { headers: { Authorization: "Bearer x" } },
        message: "no endpoint",
      },
      { otel: { enabled: true }, message: "enabled but no endpoint" },
      {
        otel: { endpoint: "https://c.example" },
        env: { [OTEL_ENV.headers]: "bad" },
        message: OTEL_ENV.headers,
      },
      {
        otel: { endpoint: "https://c.example" },
        env: { [OTEL_ENV.resourceAttributes]: "=novalue" },
      },
    ];
    for (const { otel, env, message } of cases) {
      const result = resolveOtelExportConfig(baseSettings(otel), env ?? {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(OTEL_CONFIG_INVALID);
        if (message !== undefined) {
          expect(result.message).toContain(message);
        }
      }
    }
  });
});

describe("requireOtelExportConfig", () => {
  test("throws OtelConfigError with stable code on invalid config", () => {
    expect(() =>
      requireOtelExportConfig(baseSettings({ endpoint: "://" }), {}),
    ).toThrow(OtelConfigError);
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
    expect(requireOtelExportConfig(baseSettings(), {})).toEqual({
      enabled: false,
    });
  });
});

describe("otelConfigForDump", () => {
  test("never includes header values", () => {
    const resolved = resolveOtelExportConfig(
      baseSettings({
        endpoint: "https://collector.example",
        headers: {
          Authorization: "Bearer super-secret",
          "x-api-key": "also-secret",
        },
        serviceName: "dump-test",
      }),
      {},
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok || !resolved.config.enabled)
      throw new Error("expected enabled config");

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
      // headers field absent
      expect("headers" in dump).toBe(false);
    }
  });

  test("disabled dump view is empty of secrets", () => {
    expect(otelConfigForDump({ enabled: false })).toEqual({ enabled: false });
  });

  test("redacts high-risk resource attribute values in dump view", () => {
    const resolved = resolveOtelExportConfig(
      baseSettings({
        endpoint: "https://collector.example",
        resourceAttributes: {
          "deployment.environment": "prod",
          api_key: "should-not-leak",
          "auth.token": "tok-secret",
          "db.password": "p@ss",
          team: "corbits",
        },
      }),
      {},
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok || !resolved.config.enabled)
      throw new Error("expected enabled config");

    // Live export config keeps raw values for the exporter.
    expect(resolved.config.resourceAttributes.api_key).toBe("should-not-leak");

    const dump = otelConfigForDump(resolved.config);
    expect(dump.enabled).toBe(true);
    if (!dump.enabled) throw new Error("expected enabled dump");
    expect(dump.resourceAttributes["deployment.environment"]).toBe("prod");
    expect(dump.resourceAttributes.team).toBe("corbits");
    expect(dump.resourceAttributes.api_key).toBe("[redacted]");
    expect(dump.resourceAttributes["auth.token"]).toBe("[redacted]");
    expect(dump.resourceAttributes["db.password"]).toBe("[redacted]");
    const serialized = JSON.stringify(dump);
    expect(serialized).not.toContain("should-not-leak");
    expect(serialized).not.toContain("tok-secret");
    expect(serialized).not.toContain("p@ss");
  });
});
