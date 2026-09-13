import { describe, expect, test } from "bun:test";
import type { CodexProfile } from "../auth/codex/store.js";
import { CODEX_BASE_URL } from "../auth/codex/constants.js";
import type { XaiProfile } from "../auth/xai/store.js";
import { XAI_BASE_URL } from "../auth/xai/constants.js";
import { mergeOAuthCatalog } from "./index.js";
import type {
  ProviderSettings,
  ResolvedProvider,
  Settings,
} from "./settings.js";

// Regression tests for CL-5606: after a successful ChatGPT browser login the
// merged catalog must not list a separately-added legacy bare `codex` row
// alongside the credential-backed `codex/<profile>` entry.
//
// CL-7929: the drop only applies when the bare row points at the OAuth
// endpoint. A bare row pointed at a proxy/mirror is a distinct provider and
// stays alongside the credential-backed entries.

const resolved: ResolvedProvider = {
  providerName: "openai",
  baseURL: "https://api.openai.com/v1",
  apiKey: "sk-test",
  model: "gpt-5",
};

function settingsWith(providers: Record<string, ProviderSettings>): Settings {
  return { providers } as Settings;
}

const codexEntry = (): ProviderSettings => ({
  baseURL: CODEX_BASE_URL,
  models: ["gpt-5.1-codex-max"],
});

const xaiEntry = (): ProviderSettings => ({
  baseURL: XAI_BASE_URL,
  models: ["grok-4-1"],
});

const codexDefault: CodexProfile = {
  name: "default",
  tokens: { access: "codex-access", refresh: "r", expiresAt: 1 },
  createdAt: 0,
};
const xaiWork: XaiProfile = {
  name: "work",
  tokens: { access: "xai-access", refresh: "r", expiresAt: 1 },
  createdAt: 0,
};

describe("mergeOAuthCatalog legacy bare-row dedupe (CL-5606)", () => {
  test("a legacy bare codex row is dropped once codex/default is connected", () => {
    const merged = mergeOAuthCatalog(
      settingsWith({ codex: codexEntry(), "codex/default": codexEntry() }),
      resolved,
      [codexDefault],
      [],
    );
    expect(merged.map((p) => p.name)).toEqual(["codex/default"]);
  });

  test("a legacy bare xai row is dropped once xai/work is connected", () => {
    const merged = mergeOAuthCatalog(
      settingsWith({ xai: xaiEntry() }),
      resolved,
      [],
      [xaiWork],
    );
    expect(merged.map((p) => p.name)).toEqual(["xai/work"]);
  });

  test("a bare codex row survives when nothing credential-backed exists", () => {
    // Not connected: no auth-store profile and no qualified entry. The legacy
    // single-instance row is the only ChatGPT access — keep it.
    const merged = mergeOAuthCatalog(
      settingsWith({ codex: codexEntry() }),
      resolved,
      [],
      [],
    );
    expect(merged.map((p) => p.name)).toEqual(["codex"]);
  });

  test("unrelated and API-key rows are untouched by the dedupe", () => {
    const merged = mergeOAuthCatalog(
      settingsWith({
        openai: {
          baseURL: "https://api.openai.com/v1",
          apiKey: "sk-test",
          models: ["gpt-5"],
        },
        codex: codexEntry(),
      }),
      resolved,
      [codexDefault],
      [],
    );
    expect(merged.map((p) => p.name)).toEqual(["openai", "codex/default"]);
  });

  test("a bare codex row pointed at a proxy survives alongside codex/default (CL-7929)", () => {
    const merged = mergeOAuthCatalog(
      settingsWith({
        codex: {
          baseURL: "https://proxy.example.com/v1",
          apiKey: "sk-proxy",
          models: ["gpt-5.1-codex-max"],
        },
      }),
      resolved,
      [codexDefault],
      [],
    );
    expect(merged.map((p) => p.name)).toEqual(["codex", "codex/default"]);
  });

  test("a bare xai row pointed at a mirror survives alongside xai/work (CL-7929)", () => {
    const merged = mergeOAuthCatalog(
      settingsWith({
        xai: {
          baseURL: "https://mirror.example.com/v1",
          apiKey: "sk-mirror",
          models: ["grok-4-1"],
        },
      }),
      resolved,
      [],
      [xaiWork],
    );
    expect(merged.map((p) => p.name)).toEqual(["xai", "xai/work"]);
  });
});
