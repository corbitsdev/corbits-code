import { afterEach, describe, expect, test } from "bun:test";

import { createHarness as createRawHarness, type Harness } from "./harness.js";
import {
  addProviderSelectorChoices,
  connectedAccountCount,
  CUSTOM_CHOICE_ID,
  failureGuidance,
  instanceSlugsForKind,
  LOGIN_CANCELLED_MESSAGE,
  LOGIN_TIMEOUT_MESSAGE,
  maskEcho,
  maskSecret,
  modelChoiceRows,
  modelFromRowId,
  providerChoiceById,
  providerChoiceRows,
  providerChoices,
  resolveApiKeyInstanceName,
  runProviderSetup,
  secretFromMaskedEdit,
  stepHeadline,
  stepReady,
  stepsFor,
  suggestOAuthProfileSlug,
  summaryRows,
  TYPE_MODEL_ID,
  validateOAuthProfileSlug,
  type OAuthLoginStart,
  type OAuthLoginStarter,
  type OAuthProfileLister,
  type ProviderFormValues,
  type ProviderSetupSubmit,
  type SubmitOpts,
} from "./provider-setup.js";

const EMPTY: ProviderFormValues = {
  name: "",
  baseURL: "",
  apiKey: "",
  model: "",
  oauthProfile: "",
};

type LoginCompletion = Awaited<OAuthLoginStart["completed"]>;

function stagedLogin(profile: string): LoginCompletion {
  return {
    profile: {
      name: profile,
      tokens: { access: "test-access", refresh: "test-refresh", expiresAt: 10_000 },
      createdAt: 1,
    },
    commit: async () => {},
  };
}

// This file mounts a fresh renderer per test; track every one so a single
// afterEach can free them regardless of which assertion in a test fails.
const activeHarnesses: Harness[] = [];

async function createHarness(opts: { width: number; height: number }): Promise<Harness> {
  const harness = await createRawHarness(opts);
  activeHarnesses.push(harness);
  return harness;
}

afterEach(() => {
  while (activeHarnesses.length > 0) activeHarnesses.pop()!.destroy();
});

describe("provider setup pure helpers", () => {
  test("only the API key may be left blank", () => {
    expect(stepReady("name", "")).toBe(false);
    expect(stepReady("name", "  ")).toBe(false);
    expect(stepReady("name", "openai")).toBe(true);
    expect(stepReady("apiKey", "")).toBe(true);
  });

  test("secrets render as capped bullets", () => {
    expect(maskSecret("sk-abc")).toBe("●●●●●●");
    expect(maskSecret("x".repeat(50))).toHaveLength(16);
  });

  test("keys of any length round-trip through the input echo", () => {
    // Mirrors onInput: each keystroke folds the echo back into the secret,
    // then the input is re-mirrored as bullets.
    const typeKey = (key: string): string => {
      let secret = "";
      let display = "";
      for (const ch of key) {
        display = display + ch;
        secret = secretFromMaskedEdit(secret, display);
        display = maskEcho(secret);
      }
      return secret;
    };
    expect(typeKey("sk-abc")).toBe("sk-abc");
    const long = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
    expect(typeKey(long)).toBe(long);
  });

  test("masked edits fold back into the real secret", () => {
    let secret = "";
    secret = secretFromMaskedEdit(secret, "s");
    secret = secretFromMaskedEdit(secret, "●k");
    expect(secret).toBe("sk");
    expect(secretFromMaskedEdit(secret, "●")).toBe("s");
    expect(secretFromMaskedEdit(secret, "")).toBe("");
  });

  test("a picked API-key provider names an instance before the key; custom and oauth keep their shapes", () => {
    const openai = providerChoiceById("openai");
    expect(openai?.baseURL).toBe("https://api.openai.com/v1");
    // Multi-instance API-key path: pick, name, key, model.
    expect(stepsFor(openai ?? null)).toEqual(["provider", "name", "apiKey", "model"]);
    // A subscription provider swaps the paste for a name-then-sign-in pair.
    expect(stepsFor(providerChoiceById("codex") ?? null)).toEqual([
      "provider",
      "name",
      "login",
      "model",
    ]);
    expect(stepsFor(providerChoiceById(CUSTOM_CHOICE_ID) ?? null)).toEqual([
      "provider",
      "name",
      "baseURL",
      "apiKey",
      "model",
    ]);
  });

  test("an OAuth account slug is lowercased and constrained to a settings-key-safe charset", () => {
    expect(validateOAuthProfileSlug("Personal")).toEqual({ ok: true, slug: "personal" });
    expect(validateOAuthProfileSlug("  work  ")).toEqual({ ok: true, slug: "work" });
    expect(validateOAuthProfileSlug("")).toEqual({ ok: false, error: "name cannot be empty" });
    expect(validateOAuthProfileSlug("   ")).toEqual({ ok: false, error: "name cannot be empty" });
    expect(validateOAuthProfileSlug("codex/personal").ok).toBe(false);
    expect(validateOAuthProfileSlug("my account").ok).toBe(false);
    expect(validateOAuthProfileSlug("-personal").ok).toBe(false);
    expect(validateOAuthProfileSlug("personal-").ok).toBe(false);
    expect(validateOAuthProfileSlug("a".repeat(64)).ok).toBe(true);
    expect(validateOAuthProfileSlug("a".repeat(65)).ok).toBe(false);
  });

  test("a suggested OAuth slug auto-suffixes on collision", () => {
    expect(suggestOAuthProfileSlug([])).toBe("default");
    expect(suggestOAuthProfileSlug(["personal"])).toBe("default");
    expect(suggestOAuthProfileSlug(["default"])).toBe("default-2");
    expect(suggestOAuthProfileSlug(["default", "default-2"])).toBe("default-3");
  });

  test("the pick-list carries known providers and ends with custom", () => {
    const choices = providerChoices();
    const ids = choices.map((c) => c.id);
    expect(ids).toContain("openai");
    expect(ids).toContain("opencode-go");
    expect(ids).toContain("anthropic");
    expect(ids.at(-1)).toBe(CUSTOM_CHOICE_ID);
    // Subscription providers are pickable on a first run: their step is a
    // browser sign-in rather than a paste, not an exclusion.
    expect(ids).toContain("codex");
    expect(ids).toContain("xai");
    for (const choice of choices) {
      if (choice.custom) continue;
      expect(choice.baseURL.length).toBeGreaterThan(0);
      expect(choice.defaultModel.length).toBeGreaterThan(0);
    }
    expect(providerChoiceRows(choices)[0]?.label).toContain("OpenAI");
  });

  test("Alt+A selector rows include Custom and never filter by account count", () => {
    // Regression for CL-5899: a prior filter dropped Custom from Alt+A even
    // though onboarding still offered the full manual form. Connected kinds
    // also stay listed so a second account remains reachable.
    const choices = providerChoices();
    const rows = addProviderSelectorChoices(choices, [
      { name: "openai" },
      { name: "codex/default" },
    ]);
    expect(rows.map((r) => r.id)).toContain(CUSTOM_CHOICE_ID);
    expect(rows.map((r) => r.id)).toEqual(choices.map((c) => c.id));
    const openai = rows.find((r) => r.id === "openai");
    const codex = rows.find((r) => r.id === "codex");
    const custom = rows.find((r) => r.id === CUSTOM_CHOICE_ID);
    expect(openai?.accountCount).toBe(1);
    expect(codex?.accountCount).toBe(1);
    expect(custom?.accountCount).toBe(0);
  });

  test("a connected Codex account counts under its profile-qualified name (CL-5606)", () => {
    // The ChatGPT-via-browser choice is keyed "codex", but a signed-in
    // account lands in the catalog as "codex/<profile>" — one row per
    // account. Exact-id matching alone would only ever find zero or one.
    const codexChoice = providerChoiceById("codex");
    if (codexChoice === undefined) throw new Error("expected a codex choice");
    expect(connectedAccountCount(codexChoice, [{ name: "codex/default" }])).toBe(1);
    expect(
      connectedAccountCount(codexChoice, [{ name: "codex/default" }, { name: "codex/work" }]),
    ).toBe(2);
    expect(connectedAccountCount(codexChoice, [])).toBe(0);
  });

  test("connected API-key instances count under kind and kind/slug", () => {
    // CL-5898: first-class API-key kinds are multi-instance. A bare "openai"
    // key is the legacy single-instance row; "openai/work" is a sibling.
    // Unrelated names like "openai-eu" must not count.
    const openaiChoice = providerChoiceById("openai");
    if (openaiChoice === undefined) throw new Error("expected an openai choice");
    expect(connectedAccountCount(openaiChoice, [{ name: "openai-eu" }])).toBe(0);
    expect(connectedAccountCount(openaiChoice, [{ name: "openai" }])).toBe(1);
    expect(
      connectedAccountCount(openaiChoice, [
        { name: "openai" },
        { name: "openai/work" },
        { name: "openai-eu" },
      ]),
    ).toBe(2);
  });

  test("instance slug helpers map legacy bare keys and compound names", () => {
    expect(instanceSlugsForKind("openai", [])).toEqual([]);
    expect(instanceSlugsForKind("openai", ["openai"])).toEqual(["default"]);
    expect(instanceSlugsForKind("openai", ["openai", "openai/work", "anthropic"])).toEqual([
      "default",
      "work",
    ]);
    expect(resolveApiKeyInstanceName("openai", "work", [])).toBe("openai/work");
    expect(resolveApiKeyInstanceName("openai", "default", ["openai"])).toBe("openai");
    expect(resolveApiKeyInstanceName("openai", "default", ["openai/default"])).toBe(
      "openai/default",
    );
    expect(resolveApiKeyInstanceName("openai", "default", [])).toBe("openai/default");
  });

  test("model rows come from the provider catalog plus a free-text escape", () => {
    const openai = providerChoiceById("openai");
    expect(openai).toBeDefined();
    if (openai === undefined) return;
    const rows = modelChoiceRows(openai);
    expect(rows.map((r) => r.id)).toContain(`openai:${openai.defaultModel}`);
    expect(rows.at(-1)?.id).toBe(TYPE_MODEL_ID);
    expect(modelFromRowId("openai", "openai:gpt-5.4")).toBe("gpt-5.4");
  });

  test("step headline names the step and how many remain", () => {
    expect(stepHeadline(["provider", "apiKey", "model"], 0)).toBe("step 1 of 3 · provider");
    expect(stepHeadline(["provider", "apiKey", "model"], 2)).toBe("step 3 of 3 · model");
  });

  test("the OAuth name step is headlined and summarized as an account name", () => {
    const codex = providerChoiceById("codex") ?? null;
    const steps = stepsFor(codex);
    expect(stepHeadline(steps, 1, codex)).toBe("step 2 of 4 · account name");
    const rows = summaryRows(steps, 2, { ...EMPTY, oauthProfile: "work" }, codex);
    expect(rows[1]).toMatchObject({ label: "account name", value: "work" });
  });

  test("the API-key name step is headlined and summarized as an account name", () => {
    const openai = providerChoiceById("openai") ?? null;
    const steps = stepsFor(openai);
    expect(stepHeadline(steps, 1, openai)).toBe("step 2 of 4 · account name");
    const rows = summaryRows(steps, 2, { ...EMPTY, oauthProfile: "work" }, openai);
    expect(rows[1]).toMatchObject({ label: "account name", value: "work" });
  });

  test("summary rows mark done, current, and pending steps", () => {
    const values: ProviderFormValues = { ...EMPTY, name: "openai" };
    const choice = providerChoiceById("openai") ?? null;
    const rows = summaryRows(["provider", "apiKey", "model"], 1, values, choice);
    expect(rows[0]).toMatchObject({ state: "done", value: "OpenAI API — API key" });
    expect(rows[1]?.state).toBe("current");
    expect(rows[2]).toMatchObject({ state: "pending", value: "—" });
  });

  test("the API key never appears in a summary row", () => {
    const values: ProviderFormValues = { ...EMPTY, apiKey: "sk-secret" };
    const rows = summaryRows(["provider", "apiKey", "model"], 2, values, null);
    const line = rows[1]?.value ?? "";
    expect(line).not.toContain("sk-secret");
    expect(line).toContain("●");
  });

  test("a blank key is summarized as keyless", () => {
    const rows = summaryRows(["provider", "apiKey", "model"], 2, EMPTY, null);
    expect(rows[1]?.value).toBe("keyless");
  });

  test("failures say what to fix", () => {
    expect(failureGuidance("testing", null)).toContain("base url");
    expect(failureGuidance("saving", null)).toContain("settings could not be written");
  });
});

async function mountSetup(
  onSubmit: ProviderSetupSubmit = async () => {},
  showTelemetryNotice = false,
  existingProviderNames: readonly string[] = [],
): Promise<{ done: Promise<boolean>; harness: Harness }> {
  const harness = await createHarness({ width: 80, height: 30 });
  const done = runProviderSetup({
    onSubmit,
    showTelemetryNotice,
    existingProviderNames,
    createRenderer: async () => harness.renderer,
  });
  await harness.renderOnce();
  return { done, harness };
}

function type(harness: Harness, text: string): void {
  for (const ch of text) harness.pressKey(ch);
}

/** ESC needs a disambiguation delay on the mock stdin path. */
async function pressEscape(harness: Harness): Promise<void> {
  harness.pressKey("Escape");
  await new Promise((r) => setTimeout(r, 60));
  await harness.renderOnce();
}

/** Move the pick-list to `id`, then accept it. */
async function pickRow(harness: Harness, ids: readonly string[], id: string): Promise<void> {
  const target = ids.indexOf(id);
  for (let i = 0; i < target; i++) harness.pressKey("ARROW_DOWN");
  harness.pressKey("Enter");
  await harness.renderOnce();
}

const PROVIDER_IDS = providerChoiceRows().map((r) => r.id);

/** Pick OpenAI, accept the suggested instance name, type a key, accept model. */
async function connectOpenAI(harness: Harness, key = "sk-key"): Promise<void> {
  await pickRow(harness, PROVIDER_IDS, "openai");
  await flush(harness);
  // Suggested slug is "default" when no instances exist yet.
  harness.pressKey("Enter");
  await harness.renderOnce();
  type(harness, key);
  harness.pressKey("Enter");
  await harness.renderOnce();
  harness.pressKey("Enter");
  await harness.renderOnce();
}

/** Walk the custom path end to end. */
async function connectCustom(harness: Harness): Promise<void> {
  await pickRow(harness, PROVIDER_IDS, CUSTOM_CHOICE_ID);
  type(harness, "firepass");
  harness.pressKey("Enter");
  type(harness, "https://api.example.com");
  harness.pressKey("Enter");
  type(harness, "sk-key");
  harness.pressKey("Enter");
  type(harness, "fp-small");
  harness.pressKey("Enter");
  await harness.renderOnce();
}

const AUTHORIZE_URL = "https://auth.example.com/authorize?code_challenge=abc";

/** Let queued promise callbacks land, then repaint. */
async function flush(harness: Harness): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await harness.renderOnce();
}

/**
 * Mount with an injected login driver. No test may open a browser or bind a
 * port, so the real PKCE/loopback path is never reached from here. Also
 * injects a profile lister so no test touches the real auth-store files;
 * it defaults to reporting no existing profiles.
 */
async function mountLogin(opts: {
  start: OAuthLoginStarter;
  onSubmit?: ProviderSetupSubmit;
  loginTimeoutMs?: number;
  listOAuthProfiles?: OAuthProfileLister;
}): Promise<{ done: Promise<boolean>; harness: Harness }> {
  const harness = await createHarness({ width: 80, height: 30 });
  const done = runProviderSetup({
    onSubmit: opts.onSubmit ?? (async () => {}),
    showTelemetryNotice: false,
    createRenderer: async () => harness.renderer,
    startLogin: opts.start,
    listOAuthProfiles: opts.listOAuthProfiles ?? (async () => []),
    ...(opts.loginTimeoutMs !== undefined ? { loginTimeoutMs: opts.loginTimeoutMs } : {}),
  });
  await harness.renderOnce();
  return { done, harness };
}

/**
 * Wait for a prefetched suggestion to land in the OAuth name field, then
 * clear it. The input has no select-all-on-focus behavior, so typing over a
 * prefilled suggestion would append rather than replace it; 80 backspaces is
 * comfortably more than the field's 64-character cap, and backspacing an
 * already-empty field is a no-op.
 */
async function clearOAuthNameField(harness: Harness): Promise<void> {
  await flush(harness);
  for (let i = 0; i < 80; i++) harness.pressKey("Backspace");
}

/**
 * Accept the OAuth name step: type `name` when given (after clearing
 * whatever suggestion was prefilled), otherwise accept the suggestion as is.
 * The flush after Enter lets the submit-time collision re-check resolve
 * before the caller inspects the result.
 */
async function nameOAuthAccount(harness: Harness, name?: string): Promise<void> {
  if (name === undefined) {
    await flush(harness);
  } else {
    await clearOAuthNameField(harness);
    type(harness, name);
  }
  harness.pressKey("Enter");
  await flush(harness);
}

describe("runProviderSetup renderer ownership", () => {
  test("does not destroy a caller-supplied renderer on cancel", async () => {
    const { done, harness } = await mountSetup();
    harness.pressKey("Ctrl+C");
    expect(await done).toBe(false);

    // A caller-owned renderer must still be usable for whatever mounted it
    // in the first place (a live session resuming its own UI after a
    // mid-session reconnect), not torn down out from under it.
    expect(harness.renderer.isDestroyed).toBe(false);
  });
});

describe("runProviderSetup sign-in", () => {
  test("a subscription provider signs in in place and persists the selection", async () => {
    const seen: ProviderFormValues[] = [];
    const opts: SubmitOpts[] = [];
    let complete: (result: LoginCompletion) => void = () => {};
    const { done, harness } = await mountLogin({
      start: async ({ kind, profile }) => {
        expect(kind).toBe("codex");
        expect(profile).toBe("default");
        return {
          authorizeUrl: AUTHORIZE_URL,
          completed: new Promise<LoginCompletion>((resolve) => {
            complete = resolve;
          }),
          cancel: () => {},
        };
      },
      onSubmit: async (values, _setPhase, o) => {
        seen.push({ ...values });
        opts.push(o);
      },
    });
    await pickRow(harness, PROVIDER_IDS, "codex");
    expect(harness.captureCharFrame()).toContain("step 2 of 4");
    await nameOAuthAccount(harness);
    const waiting = harness.captureCharFrame();
    expect(waiting).toContain("step 3 of 4");
    expect(waiting).toContain("sign in");
    expect(waiting).toContain("auth.example.com/authorize");
    expect(waiting).toContain("waiting for browser sign-in");

    complete(stagedLogin("default"));
    await flush(harness);
    expect(harness.captureCharFrame()).toContain("step 4 of 4");

    harness.pressKey("Enter");
    await harness.renderOnce();
    expect(await done).toBe(true);
    expect(seen[0]?.name).toBe("codex/default");
    // A signed-in provider never carries a key through the form.
    expect(seen[0]?.apiKey).toBe("");
    expect(opts[0]?.oauth).toMatchObject({
      kind: "codex",
      profile: "default",
      providerName: "codex/default",
      tokens: { access: "test-access", refresh: "test-refresh", expiresAt: 10_000 },
    });
    expect(opts[0]?.oauth?.commit).toBeFunction();
  });

  test("the entered account name reaches startLogin as the profile slug", async () => {
    const seenProfiles: string[] = [];
    const { done, harness } = await mountLogin({
      start: async ({ profile }) => {
        seenProfiles.push(profile);
        return {
          authorizeUrl: AUTHORIZE_URL,
          completed: new Promise<LoginCompletion>(() => {}),
          cancel: () => {},
        };
      },
    });
    await pickRow(harness, PROVIDER_IDS, "codex");
    await nameOAuthAccount(harness, "personal-account");
    expect(seenProfiles).toEqual(["personal-account"]);
    harness.pressKey("Ctrl+C");
    expect(await done).toBe(false);
  });

  test("a suggested name auto-suffixes on collision with existing profiles", async () => {
    const seenProfiles: string[] = [];
    const { done, harness } = await mountLogin({
      listOAuthProfiles: async () => ["default"],
      start: async ({ profile }) => {
        seenProfiles.push(profile);
        return {
          authorizeUrl: AUTHORIZE_URL,
          completed: new Promise<LoginCompletion>(() => {}),
          cancel: () => {},
        };
      },
    });
    await pickRow(harness, PROVIDER_IDS, "codex");
    await flush(harness);
    // The suggestion is visible before it is accepted, not just inferred
    // from what startLogin later receives.
    expect(harness.captureCharFrame()).toContain("default-2");
    harness.pressKey("Enter");
    await flush(harness);
    expect(seenProfiles).toEqual(["default-2"]);
    harness.pressKey("Ctrl+C");
    expect(await done).toBe(false);
  });

  test("reusing a connected account's name asks to confirm before re-authorizing it", async () => {
    const seenProfiles: string[] = [];
    const { done, harness } = await mountLogin({
      listOAuthProfiles: async () => ["personal"],
      start: async ({ profile }) => {
        seenProfiles.push(profile);
        return {
          authorizeUrl: AUTHORIZE_URL,
          completed: new Promise<LoginCompletion>(() => {}),
          cancel: () => {},
        };
      },
    });
    await pickRow(harness, PROVIDER_IDS, "codex");
    await clearOAuthNameField(harness);
    type(harness, "personal");
    harness.pressKey("Enter");
    await flush(harness);
    // Still on the name step: the collision must be acknowledged, not just
    // captioned, before the browser opens.
    const confirming = harness.captureCharFrame();
    expect(confirming).toContain("step 2 of 4");
    expect(confirming).toContain("already connected");
    expect(confirming).toContain("re-authorize");
    expect(seenProfiles).toEqual([]);

    harness.pressKey("Enter");
    await flush(harness);
    expect(seenProfiles).toEqual(["personal"]);
    expect(harness.captureCharFrame()).toContain("step 3 of 4");
    harness.pressKey("Ctrl+C");
    expect(await done).toBe(false);
  });

  test("editing the name after a collision confirm re-derives the check instead of reusing it", async () => {
    let starts = 0;
    const { done, harness } = await mountLogin({
      listOAuthProfiles: async () => ["personal"],
      start: async () => {
        starts += 1;
        return {
          authorizeUrl: AUTHORIZE_URL,
          completed: new Promise<LoginCompletion>(() => {}),
          cancel: () => {},
        };
      },
    });
    await pickRow(harness, PROVIDER_IDS, "codex");
    await clearOAuthNameField(harness);
    type(harness, "personal");
    harness.pressKey("Enter");
    await flush(harness);
    expect(harness.captureCharFrame()).toContain("already connected");

    // Editing the name invalidates the pending confirm — the next Enter must
    // recheck rather than silently proceeding as if "personal2" were the
    // account already confirmed.
    type(harness, "2");
    harness.pressKey("Enter");
    await flush(harness);
    expect(starts).toBe(1);
    expect(harness.captureCharFrame()).toContain("step 3 of 4");
    harness.pressKey("Ctrl+C");
    expect(await done).toBe(false);
  });

  test("an invalid account name is rejected with a visible error and does not sign in", async () => {
    let starts = 0;
    const { done, harness } = await mountLogin({
      start: async () => {
        starts += 1;
        return {
          authorizeUrl: AUTHORIZE_URL,
          completed: new Promise<LoginCompletion>(() => {}),
          cancel: () => {},
        };
      },
    });
    await pickRow(harness, PROVIDER_IDS, "codex");
    type(harness, "My Account!");
    harness.pressKey("Enter");
    await flush(harness);
    const frame = harness.captureCharFrame();
    expect(frame).toContain("step 2 of 4");
    expect(frame).toContain("lowercase letters, numbers");
    expect(starts).toBe(0);
    harness.pressKey("Ctrl+C");
    expect(await done).toBe(false);
  });

  test("a denied sign-in says so and Enter retries it", async () => {
    let starts = 0;
    const { done, harness } = await mountLogin({
      start: async () => {
        starts += 1;
        return {
          authorizeUrl: AUTHORIZE_URL,
          completed:
            starts === 1
              ? Promise.reject(new Error("access denied by the user"))
              : new Promise<LoginCompletion>(() => {}),
          cancel: () => {},
        };
      },
    });
    await pickRow(harness, PROVIDER_IDS, "codex");
    await nameOAuthAccount(harness);
    const failed = harness.captureCharFrame();
    expect(failed).toContain("access denied by the user");
    expect(failed).toContain("enter to try signing in again");

    harness.pressKey("Enter");
    await flush(harness);
    expect(starts).toBe(2);
    expect(harness.captureCharFrame()).toContain("waiting for browser sign-in");
    harness.pressKey("Ctrl+C");
    expect(await done).toBe(false);
  });

  test("a sign-in that never returns times out rather than hanging", async () => {
    let cancelled = 0;
    const { done, harness } = await mountLogin({
      loginTimeoutMs: 5,
      start: async () => ({
        authorizeUrl: AUTHORIZE_URL,
        completed: new Promise<LoginCompletion>(() => {}),
        cancel: () => {
          cancelled += 1;
        },
      }),
    });
    await pickRow(harness, PROVIDER_IDS, "codex");
    await nameOAuthAccount(harness);
    await new Promise((r) => setTimeout(r, 30));
    await harness.renderOnce();
    const frame = harness.captureCharFrame();
    expect(frame).toContain(LOGIN_TIMEOUT_MESSAGE);
    expect(frame).toContain("enter to try signing in again");
    expect(cancelled).toBeGreaterThan(0);
    harness.pressKey("Ctrl+C");
    expect(await done).toBe(false);
  });

  test("Escape abandons a sign-in and returns to the name step for editing", async () => {
    let cancelled = 0;
    let aborted = false;
    const { done, harness } = await mountLogin({
      start: async ({ signal }) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return {
          authorizeUrl: AUTHORIZE_URL,
          completed: new Promise<LoginCompletion>(() => {}),
          cancel: () => {
            cancelled += 1;
          },
        };
      },
    });
    await pickRow(harness, PROVIDER_IDS, "codex");
    await nameOAuthAccount(harness);
    await pressEscape(harness);
    const frame = harness.captureCharFrame();
    expect(frame).toContain("step 2 of 4");
    expect(frame).toContain(LOGIN_CANCELLED_MESSAGE);
    expect(frame).toContain("pick a provider to start over");
    expect(cancelled).toBeGreaterThan(0);
    expect(aborted).toBe(true);
    harness.pressKey("Ctrl+C");
    expect(await done).toBe(false);
  });

  test("a failed sign-in can be retried under a different name after going back", async () => {
    const seenProfiles: string[] = [];
    const { done, harness } = await mountLogin({
      start: async ({ profile }) => {
        seenProfiles.push(profile);
        return {
          authorizeUrl: AUTHORIZE_URL,
          completed:
            seenProfiles.length === 1
              ? Promise.reject(new Error("access denied by the user"))
              : new Promise<LoginCompletion>(() => {}),
          cancel: () => {},
        };
      },
    });
    await pickRow(harness, PROVIDER_IDS, "codex");
    await nameOAuthAccount(harness, "first-try");
    expect(harness.captureCharFrame()).toContain("access denied by the user");

    await pressEscape(harness);
    const backAtName = harness.captureCharFrame();
    expect(backAtName).toContain("step 2 of 4");
    expect(backAtName).toContain("first-try");

    await nameOAuthAccount(harness, "second-try");
    expect(harness.captureCharFrame()).toContain("waiting for browser sign-in");
    expect(seenProfiles).toEqual(["first-try", "second-try"]);
    harness.pressKey("Ctrl+C");
    expect(await done).toBe(false);
  });

  test("a late resolution from an abandoned attempt cannot move the screen", async () => {
    let complete: (result: LoginCompletion) => void = () => {};
    const { done, harness } = await mountLogin({
      start: async () => ({
        authorizeUrl: AUTHORIZE_URL,
        completed: new Promise<LoginCompletion>((resolve) => {
          complete = resolve;
        }),
        cancel: () => {},
      }),
    });
    await pickRow(harness, PROVIDER_IDS, "codex");
    await nameOAuthAccount(harness);
    await pressEscape(harness);
    complete(stagedLogin("default"));
    await flush(harness);
    expect(harness.captureCharFrame()).toContain("step 2 of 4");
    harness.pressKey("Ctrl+C");
    expect(await done).toBe(false);
  });
});

describe("runProviderSetup", () => {
  test("opens on the provider pick-list", async () => {
    const { done, harness } = await mountSetup();
    await harness.renderOnce();
    const frame = harness.captureCharFrame();
    expect(frame).toContain("setup");
    expect(frame).toContain("step 1 of 4");
    expect(frame).toContain("OpenAI");
    expect(frame).toContain("Custom");
    harness.pressKey("Ctrl+C");
    expect(await done).toBe(false);
  });

  test("picking a known provider names an instance then takes a key", async () => {
    const seen: ProviderFormValues[] = [];
    const opts: SubmitOpts[] = [];
    const { done, harness } = await mountSetup(async (values, _phase, o) => {
      seen.push({ ...values });
      opts.push(o);
    });
    await pickRow(harness, PROVIDER_IDS, "openai");
    await flush(harness);
    expect(harness.captureCharFrame()).toContain("step 2 of 4");
    // Accept suggested "default" instance name.
    harness.pressKey("Enter");
    await harness.renderOnce();
    expect(harness.captureCharFrame()).toContain("step 3 of 4");
    type(harness, "sk-key");
    harness.pressKey("Enter");
    await harness.renderOnce();
    expect(harness.captureCharFrame()).toContain("step 4 of 4");
    harness.pressKey("Enter");
    await harness.renderOnce();

    expect(await done).toBe(true);
    const openai = providerChoiceById("openai");
    expect(seen[0]).toEqual({
      name: "openai/default",
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-key",
      model: openai?.defaultModel ?? "",
      oauthProfile: "default",
    });
    expect(opts[0]?.preset?.id).toBe("openai");
    expect(opts[0]?.preset?.models.length).toBeGreaterThan(1);
  });

  test("the custom path keeps the full manual form", async () => {
    const seen: ProviderFormValues[] = [];
    const opts: SubmitOpts[] = [];
    const { done, harness } = await mountSetup(async (values, _phase, o) => {
      seen.push({ ...values });
      opts.push(o);
    });
    await pickRow(harness, PROVIDER_IDS, CUSTOM_CHOICE_ID);
    expect(harness.captureCharFrame()).toContain("step 2 of 5");
    type(harness, "firepass");
    harness.pressKey("Enter");
    type(harness, "https://api.example.com");
    harness.pressKey("Enter");
    type(harness, "sk-key");
    harness.pressKey("Enter");
    type(harness, "fp-small");
    harness.pressKey("Enter");
    await harness.renderOnce();

    expect(await done).toBe(true);
    expect(seen[0]).toEqual({
      name: "firepass",
      baseURL: "https://api.example.com",
      apiKey: "sk-key",
      model: "fp-small",
      oauthProfile: "",
    });
    expect(opts[0]?.preset).toBeUndefined();
  });

  test("the model pick-list can escape to a typed model id", async () => {
    const seen: ProviderFormValues[] = [];
    const { done, harness } = await mountSetup(async (values) => {
      seen.push({ ...values });
    });
    await pickRow(harness, PROVIDER_IDS, "openai");
    await flush(harness);
    harness.pressKey("Enter");
    await harness.renderOnce();
    type(harness, "sk-key");
    harness.pressKey("Enter");
    await harness.renderOnce();
    const openai = providerChoiceById("openai");
    expect(openai).toBeDefined();
    if (openai === undefined) return;
    const modelIds = modelChoiceRows(openai).map((r) => r.id);
    await pickRow(harness, modelIds, TYPE_MODEL_ID);
    type(harness, "gpt-4o");
    harness.pressKey("Enter");
    await harness.renderOnce();
    expect(await done).toBe(true);
    expect(seen[0]?.model).toBe("gpt-4o");
    expect(seen[0]?.name).toBe("openai/default");
  });

  test("shows the telemetry notice only when asked to", async () => {
    const shown = await mountSetup(async () => {}, true);
    await shown.harness.renderOnce();
    expect(shown.harness.captureCharFrame()).toContain("telemetry");
    shown.harness.pressKey("Ctrl+C");
    await shown.done;

    const hidden = await mountSetup();
    await hidden.harness.renderOnce();
    expect(hidden.harness.captureCharFrame()).not.toContain("telemetry");
    hidden.harness.pressKey("Ctrl+C");
    await hidden.done;
  });

  test("Enter on an empty required field does not advance", async () => {
    const { done, harness } = await mountSetup();
    await pickRow(harness, PROVIDER_IDS, CUSTOM_CHOICE_ID);
    harness.pressKey("Enter");
    await harness.renderOnce();
    expect(harness.captureCharFrame()).toContain("step 2 of 5");
    harness.pressKey("Ctrl+C");
    await done;
  });

  test("Escape goes back a step", async () => {
    const { done, harness } = await mountSetup();
    await pickRow(harness, PROVIDER_IDS, "openai");
    expect(harness.captureCharFrame()).toContain("step 2 of 4");
    await pressEscape(harness);
    expect(harness.captureCharFrame()).toContain("step 1 of 4");
    harness.pressKey("Ctrl+C");
    await done;
  });

  test("Escape on the first step stays put", async () => {
    const { done, harness } = await mountSetup();
    await pressEscape(harness);
    expect(harness.captureCharFrame()).toContain("step 1 of 4");
    harness.pressKey("Ctrl+C");
    await done;
  });

  test("a full-length API key reaches onSubmit intact", async () => {
    const key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
    const seen: ProviderFormValues[] = [];
    const { done, harness } = await mountSetup(async (values) => {
      seen.push({ ...values });
    });
    await connectOpenAI(harness, key);
    expect(await done).toBe(true);
    expect(seen[0]?.apiKey).toBe(key);
  });

  test("the typed API key is never painted in the clear", async () => {
    const { done, harness } = await mountSetup();
    await pickRow(harness, PROVIDER_IDS, "openai");
    await flush(harness);
    harness.pressKey("Enter");
    await harness.renderOnce();
    type(harness, "sk-secret");
    await harness.renderOnce();
    const frame = harness.captureCharFrame();
    expect(frame).not.toContain("sk-secret");
    expect(frame).toContain("●");
    harness.pressKey("Ctrl+C");
    await done;
  });

  test("reports the submit phase while onSubmit runs", async () => {
    let advance: (phase: "testing" | "saving") => void = () => {};
    let finish: () => void = () => {};
    const { done, harness } = await mountSetup((_values, setPhase) => {
      advance = setPhase;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await connectOpenAI(harness);
    expect(harness.captureCharFrame()).toContain("testing connection");

    advance("saving");
    await harness.renderOnce();
    expect(harness.captureCharFrame()).toContain("writing settings");

    finish();
    expect(await done).toBe(true);
  });

  test("a failed connection test shows the error, guidance, and save-anyway", async () => {
    const attempts: boolean[] = [];
    const { done, harness } = await mountSetup(async (_values, _setPhase, opts) => {
      attempts.push(opts.skipValidation);
      if (!opts.skipValidation) throw new Error("connection refused");
    });
    await connectOpenAI(harness);
    await harness.renderOnce();
    const frame = harness.captureCharFrame();
    expect(frame).toContain("connection refused");
    expect(frame).toContain("save anyway");

    harness.pressKey("s", { ctrl: true });
    expect(await done).toBe(true);
    expect(attempts).toEqual([false, true]);
  });

  test("a failure while saving does not offer save-anyway", async () => {
    const { done, harness } = await mountSetup(async (_values, setPhase) => {
      setPhase("saving");
      throw new Error("disk full");
    });
    await connectCustom(harness);
    await harness.renderOnce();
    const frame = harness.captureCharFrame();
    expect(frame).toContain("disk full");
    expect(frame).not.toContain("save anyway");
    harness.pressKey("Ctrl+C");
    expect(await done).toBe(false);
  });

  test("Ctrl+C during a sign-in resolves false and closes the flow", async () => {
    let cancelled = 0;
    const { done, harness } = await mountLogin({
      start: async () => ({
        authorizeUrl: AUTHORIZE_URL,
        completed: new Promise<LoginCompletion>(() => {}),
        cancel: () => {
          cancelled += 1;
        },
      }),
    });
    await pickRow(harness, PROVIDER_IDS, "codex");
    await nameOAuthAccount(harness);
    harness.pressKey("Ctrl+C");
    expect(await done).toBe(false);
    expect(cancelled).toBeGreaterThan(0);
  });

  test("Ctrl+C before submit resolves false", async () => {
    let submits = 0;
    const { done, harness } = await mountSetup(async () => {
      submits += 1;
    });
    await pickRow(harness, PROVIDER_IDS, "openai");
    await flush(harness);
    type(harness, "sk-key");
    harness.pressKey("Ctrl+C");
    expect(await done).toBe(false);
    expect(submits).toBe(0);
  });

  test("a second API-key instance gets a compound name without overwriting the first", async () => {
    const seen: ProviderFormValues[] = [];
    const { done, harness } = await mountSetup(
      async (values) => {
        seen.push({ ...values });
      },
      false,
      ["openai/default"],
    );
    await pickRow(harness, PROVIDER_IDS, "openai");
    await flush(harness);
    // Existing "default" forces suggested "default-2".
    expect(harness.captureCharFrame()).toContain("default-2");
    harness.pressKey("Enter");
    await harness.renderOnce();
    type(harness, "sk-work");
    harness.pressKey("Enter");
    await harness.renderOnce();
    harness.pressKey("Enter");
    await harness.renderOnce();
    expect(await done).toBe(true);
    expect(seen[0]?.name).toBe("openai/default-2");
    expect(seen[0]?.oauthProfile).toBe("default-2");
    expect(seen[0]?.apiKey).toBe("sk-work");
  });

  test("reusing an existing API-key instance name requires confirm before replace", async () => {
    const seen: ProviderFormValues[] = [];
    const { done, harness } = await mountSetup(
      async (values) => {
        seen.push({ ...values });
      },
      false,
      ["openai"],
    );
    await pickRow(harness, PROVIDER_IDS, "openai");
    await flush(harness);
    // Clear suggested "default-2" and type the legacy bare-key slug "default".
    for (let i = 0; i < 80; i++) harness.pressKey("Backspace");
    type(harness, "default");
    harness.pressKey("Enter");
    await flush(harness);
    expect(harness.captureCharFrame()).toContain("already connected");
    // Confirm replace.
    harness.pressKey("Enter");
    await harness.renderOnce();
    type(harness, "sk-replaced");
    harness.pressKey("Enter");
    await harness.renderOnce();
    harness.pressKey("Enter");
    await harness.renderOnce();
    expect(await done).toBe(true);
    // Legacy bare key is updated in place rather than rewritten as openai/default.
    expect(seen[0]?.name).toBe("openai");
    expect(seen[0]?.oauthProfile).toBe("default");
    expect(seen[0]?.apiKey).toBe("sk-replaced");
  });
});

/**
 * Onboarding tells the user to paste, so paste is driven here as real
 * bracketed-paste bytes (ESC[200~ … ESC[201~) through mock stdin. Asserting a
 * handler is registered would pass while paste was broken.
 */
describe("runProviderSetup paste", () => {
  /** Pick OpenAI, accept the instance name, paste `key`, accept default model. */
  async function pasteKey(
    key: string,
  ): Promise<{ values: ProviderFormValues | null; frame: string }> {
    let seen: ProviderFormValues | null = null;
    const { done, harness } = await mountSetup(async (values) => {
      seen = values;
    });
    await pickRow(harness, PROVIDER_IDS, "openai");
    await flush(harness);
    harness.pressKey("Enter");
    await harness.renderOnce();
    await harness.mockInput.pasteBracketedText(key);
    await harness.renderOnce();
    const frame = harness.captureCharFrame();
    harness.pressKey("Enter");
    await harness.renderOnce();
    harness.pressKey("Enter");
    await harness.renderOnce();
    await done;
    return { values: seen, frame };
  }

  test("a pasted key lands in the field, never echoed in the clear", async () => {
    const key = "sk-proj-pasted-key-0123456789";
    const { values, frame } = await pasteKey(key);
    expect(values?.apiKey).toBe(key);
    expect(frame).not.toContain(key);
  });

  test("a key pasted with its trailing newline is not submitted early", async () => {
    const { values } = await pasteKey("sk-trailing\n");
    expect(values?.apiKey).toBe("sk-trailing");
    expect(values?.model.length).toBeGreaterThan(0);
  });

  test("a key longer than the input default is not silently truncated", async () => {
    const key = `sk-${"x".repeat(4000)}`;
    const { values } = await pasteKey(key);
    expect(values?.apiKey).toBe(key);
  });
});

describe("runProviderSetup pick-list height cap", () => {
  // Every terminal size gets a bounded frame — no chrome row overlaps
  // another (the header/intro/step/instruction rows used to compress into
  // each other when the flex column ran out of room), and the picker never
  // paints past the terminal's own row count.
  for (const height of [24, 16, 12, 8, 6]) {
    test(`stays within a ${height}-row terminal with no overlapping chrome`, async () => {
      const harness = await createHarness({ width: 80, height });
      runProviderSetup({
        onSubmit: async () => {},
        showTelemetryNotice: false,
        createRenderer: async () => harness.renderer,
      });
      await harness.renderOnce();
      await harness.renderOnce();
      const lines = harness.captureCharFrame().split("\n");
      expect(lines.length).toBeLessThanOrEqual(height + 1);
      // The garbled-overlap bug glued the step line and the intro line
      // together on one row; each survives as its own line, or is clipped
      // entirely, but never merges into the other.
      const stepLine = lines.find((l) => l.includes("step 1 of 4"));
      if (stepLine !== undefined) {
        expect(stepLine).not.toContain("connect an inference provider");
      }
    });
  }

  test("keyboard navigation scrolls a long provider list and keeps the active row visible", async () => {
    const harness = await createHarness({ width: 80, height: 16 });
    runProviderSetup({
      onSubmit: async () => {},
      showTelemetryNotice: false,
      createRenderer: async () => harness.renderer,
    });
    await harness.renderOnce();
    await harness.renderOnce();
    const ids = providerChoiceRows(providerChoices()).map((r) => r.id);
    for (let i = 0; i < ids.length - 1; i++) harness.pressKey("ARROW_DOWN");
    await harness.renderOnce();
    const frame = harness.captureCharFrame();
    const last = providerChoiceRows(providerChoices()).at(-1);
    expect(last).toBeDefined();
    expect(frame).toContain(last!.label.slice(0, 20));
  });

  // statusLine and guidance are both blank on the first screen these tests
  // exercised — the garbling only showed up once a failed connection test
  // populates both of them at once, so walk the flow there instead of
  // stopping at the provider pick-list.
  test("a failed connection test at a short terminal shows status and guidance on their own lines", async () => {
    const harness = await createHarness({ width: 80, height: 16 });
    runProviderSetup({
      onSubmit: async (_values, _setPhase, opts) => {
        if (!opts.skipValidation) throw new Error("connection refused");
      },
      showTelemetryNotice: false,
      createRenderer: async () => harness.renderer,
    });
    await harness.renderOnce();
    await harness.renderOnce();
    await pickRow(harness, PROVIDER_IDS, "openai");
    await flush(harness);
    harness.pressKey("Enter");
    await harness.renderOnce();
    type(harness, "sk-key");
    harness.pressKey("Enter");
    await harness.renderOnce();
    harness.pressKey("Enter");
    await harness.renderOnce();
    await new Promise((r) => setTimeout(r, 0));
    await harness.renderOnce();

    const lines = harness.captureCharFrame().split("\n");
    expect(lines.length).toBeLessThanOrEqual(17);
    const statusRow = lines.find((l) => l.includes("connection refused"));
    const guidanceRow = lines.find((l) => l.includes("esc to re-enter"));
    expect(statusRow).toBeDefined();
    expect(guidanceRow).toBeDefined();
    // The garbling bug glued these two rows together; each must survive as
    // its own line, never merged into the other.
    expect(statusRow).not.toBe(guidanceRow);
    expect(statusRow).not.toContain("esc to re-enter");
    expect(guidanceRow).not.toContain("connection refused");
  });
});
