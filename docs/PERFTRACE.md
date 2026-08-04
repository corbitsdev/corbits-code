# Performance tracing (PerfTrace) and OTEL export

Corbits Code measures session performance with an always-on local tracer
(`src/perf/`). Optional OpenTelemetry export sends the same span tree to **your**
collector. This is separate from product analytics — see `docs/TELEMETRY.md` for
PostHog usage events.

## Local sink (always on)

- In-process ring buffer of phase spans (turn, inference, tools, …)
- Privacy-strict tags: enums, ids, and numbers only — no prompts, paths, tool
  args, free-text errors, or credentials
- Offline dumps: `dumpSpans` + `rollupByPhase` / `rollupByTurn` / `sessionTotals`
  (`src/perf/dump.ts`, `src/perf/rollup.ts`) — same tag allowlist; never include
  OTEL auth headers

Local measurement does not require any settings or env vars.

## OTEL export (opt-in)

Export is **off** until an OTLP endpoint is configured. When enabled, traces go
to the operator-owned backend you point at — not Corbits product analytics.

The settings/env surface is implemented now (`src/perf/otel-config.ts`). The
actual OTLP transport lands in a follow-up (CL-5173). Invalid config fails
closed with a stable error code `OTEL_CONFIG_INVALID` and does not half-enable
export.

### Configuration

**Env vars (preferred for secrets; match OTEL conventions):**

| Variable | Meaning |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP base URL (`http` or `https` only) |
| `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated `key=value` headers (values may be percent-encoded) |
| `OTEL_SERVICE_NAME` | Resource `service.name` (default: `corbits-code`) |
| `OTEL_RESOURCE_ATTRIBUTES` | Comma-separated `key=value` resource attributes |

**Global settings** (`~/.corbits/settings.json`), optional `otel` block:

```json
{
  "otel": {
    "enabled": true,
    "endpoint": "https://collector.example/v1",
    "headers": { "Authorization": "Bearer …" },
    "serviceName": "corbits-code",
    "resourceAttributes": {
      "deployment.environment": "dev"
    }
  }
}
```

Precedence:

- **endpoint:** env overrides settings
- **headers:** when `OTEL_EXPORTER_OTLP_HEADERS` is set, it fully replaces
  settings headers (prefer env so secrets stay out of the settings file)
- **serviceName:** env `OTEL_SERVICE_NAME` > settings `serviceName` >
  `resourceAttributes["service.name"]` > `corbits-code`. After merge,
  `resourceAttributes["service.name"]` is always set to the resolved name so
  the two never diverge.
- **resourceAttributes:** settings merged with env; env wins on key conflict
- **`otel.enabled: false`:** disables export when only settings provide an
  endpoint; an explicit env endpoint still enables export

Do not put credentials in the endpoint URL (`https://user:pass@…` is rejected).
Use headers instead.

### Fail closed

Any of the following yields `OTEL_CONFIG_INVALID` and must not start export:

- Endpoint that is not a valid `http`/`https` URL
- Credentials embedded in the endpoint URL
- Headers (settings or env) without an endpoint
- `otel.enabled: true` without an endpoint
- Malformed `key=value` lists for headers or resource attributes

No endpoint and no half-config → export stays disabled (not an error).

### Secrets and dumps

- Header **values** are secrets. Prefer env for them.
- `otelConfigForDump()` exposes only: enabled flag, endpoint, service name,
  resource attributes, and header **names** — never values.
- Resource attribute values whose keys match `/secret|token|key|password|auth/i`
  are replaced with `[redacted]` in the dump view (live export config is
  unchanged). Prefer non-secret labels in `resourceAttributes`; put auth in
  headers/env.
- Local privacy-strict dump writers must call `otelConfigForDump` (or omit OTEL
  config entirely). Never serialize `OtelExportConfig.headers` into session
  artifacts, logs, or crash dumps.

### Targeting common collectors

Examples assume the OTLP HTTP base URL your collector documents. Paths such as
`/v1/traces` are appended by the exporter (CL-5173), not by this settings layer.

#### Arize Phoenix

Local Phoenix typically listens for OTLP HTTP on port 6006:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:6006"
export OTEL_SERVICE_NAME="corbits-code"
```

Cloud / authenticated Phoenix: set the project endpoint and pass the API key as
a header (exact header name follows Phoenix’s current docs):

```bash
# Base URL only — the exporter appends /v1/traces (do not include the path here).
export OTEL_EXPORTER_OTLP_ENDPOINT="https://app.phoenix.arize.com"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20<phoenix-api-key>"
export OTEL_SERVICE_NAME="corbits-code"
```

#### PostHog OTEL

PostHog can ingest OTLP independently of Corbits product telemetry. Use your
project’s OTEL endpoint and project API key as documented by PostHog:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://us.i.posthog.com/i/v0/otlp"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20<phc_…>"
export OTEL_SERVICE_NAME="corbits-code"
```

This does **not** expand the three PostHog product events in `docs/TELEMETRY.md`.
Product analytics opt-out (`CORBITS_TELEMETRY`, `DO_NOT_TRACK`, settings) does
not control OTEL export, and vice versa.

#### Generic OTLP collector (Jaeger, Grafana Alloy, otel-collector, …)

Point at any OTLP-compatible base URL:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
export OTEL_SERVICE_NAME="corbits-code"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=local,service.namespace=dev"
```

Or in settings without secrets:

```json
{
  "otel": {
    "endpoint": "http://localhost:4318",
    "serviceName": "corbits-code",
    "resourceAttributes": {
      "deployment.environment": "local"
    }
  }
}
```

Then supply auth only via env when needed.

## Relationship to product telemetry

| Pipe | Purpose | Default | Content |
|---|---|---|---|
| PostHog (`docs/TELEMETRY.md`) | Aggregate product usage | Opt-out | Three allowlisted events |
| Local PerfTrace | Operator/dev attribution | Always on | Privacy-strict phase spans |
| OTEL export | Your APM / Phoenix / collector | Opt-in | Full span tree when enabled |

Do not enlarge the PostHog event schema for performance diagnostics.
