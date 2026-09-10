/**
 * Renderable tree and paint pipeline for the provider setup screen. Built
 * once per mount; every paint reads the shared setup state, so the flows in
 * oauth/discovery/setup only mutate state and call `paint`/`paintStatus`.
 */

import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  TextRenderable,
  type KeyEvent,
} from "@opentui/core";

import { PRODUCT_NAME } from "../../branding.js";
import { ollamaDiscoveryFailureLine } from "../../provider/ollama.js";
import { TELEMETRY_NOTICE } from "../../telemetry/index.js";
import { wrapLines } from "../view/height.js";
import { rampFor, rampLine } from "../ramp.js";
import { destroySubtree } from "../teardown.js";
import { UI } from "../theme.js";
import {
  failureGuidance,
  PROVIDER_FIELD_HINTS,
  stepHeadline,
  summaryColor,
  summaryLine,
  summaryRows,
} from "./form.js";
import {
  LOGIN_CANCELLED_MESSAGE,
  loginCancelGuidance,
  loginGuidance,
  LOGIN_WAITING_LABEL,
} from "./oauth.js";
import { accountNamePrompt, CUSTOM_STEPS, STEP_PROMPTS } from "./steps.js";
import { PROVIDER_LIST_ROWS_MAX } from "./choices.js";
import type {
  DiscoveryFlows,
  LoginFlow,
  SetupSelectors,
  SetupState,
  SubmitPhase,
  Surface,
} from "./types.js";

const SUMMARY_SLOTS = CUSTOM_STEPS.length;
/** Wrapped rows reserved for the authorize URL and its instruction. */
const LOGIN_ROWS = 4;
const TELEMETRY_ROWS = 3;
/**
 * Input capacity. The renderable defaults to 1000 characters and truncates a
 * longer paste silently, which a first run would read as "paste is broken";
 * long-lived service-account keys and JWT-shaped tokens clear that default.
 */
const FIELD_MAX_LENGTH = 16_384;
/** Ramp animation tick. Fast enough to read as motion at 30fps paint. */
export const RAMP_TICK_MS = 120;

// "testing" covers the connection-check call against the entered credentials;
// "saving" covers the settings write that follows once the test succeeds.
const SUBMIT_PHASE_LABEL: Record<SubmitPhase, string> = {
  testing: "testing connection",
  saving: "writing settings",
};

/** Stop the shared ramp animation timer, if one is running. */
export function stopRamp(state: SetupState): void {
  if (state.rampTimer === null) return;
  clearInterval(state.rampTimer);
  state.rampTimer = null;
}

/**
 * Unmount the surface: stop every in-flight flow, detach the input handlers,
 * and destroy the renderable tree. The renderer itself is destroyed only when
 * this mount created it — a caller-supplied renderer is owned by that caller.
 */
export function teardownSurface(
  state: SetupState,
  surface: Surface,
  login: LoginFlow,
  discovery: DiscoveryFlows,
  onKey: (key: KeyEvent) => void,
  onEnter: () => void,
  onInput: (next: string) => void,
): void {
  stopRamp(state);
  login.abandonLogin();
  discovery.abandonOllamaDiscovery();
  discovery.abandonGoPrefetch();
  state.renderer.keyInput.off("keypress", onKey);
  surface.input.off(InputRenderableEvents.ENTER, onEnter);
  surface.input.off(InputRenderableEvents.INPUT, onInput);
  try {
    state.renderer.root.remove(surface.root);
    destroySubtree(surface.root);
  } catch {
    // already unmounted
  }
  if (!state.externalRenderer) {
    try {
      state.renderer.destroy();
    } catch {
      // already destroyed
    }
  }
}

export function createSurface(
  state: SetupState,
  selectors: SetupSelectors,
): Surface {
  const { renderer, margin, config } = state;

  const root = new BoxRenderable(renderer, {
    id: "provider-setup",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: UI.ground,
    paddingTop: 1,
    paddingLeft: margin,
    paddingRight: margin,
  });

  // Every direct child of `root` needs flexShrink: 0, full stop — a plain
  // TextRenderable defaults to shrinkable, and a short terminal makes the
  // flex algorithm compress unprotected single-line rows into each other
  // (garbled overlapping text) instead of clipping the column from the
  // bottom. header/intro/step/instruction here, and statusLine/guidance/
  // footer further down, all needed this; it is not specific to one step.
  const header = new TextRenderable(renderer, {
    id: "provider-setup-header",
    content: `${PRODUCT_NAME.toLowerCase()} · setup`,
    fg: UI.inFlightBright,
    flexShrink: 0,
  });
  const intro = new TextRenderable(renderer, {
    id: "provider-setup-welcome",
    content: "connect an inference provider — switch later with /model",
    fg: UI.textDim,
    flexShrink: 0,
  });
  const step = new TextRenderable(renderer, {
    id: "provider-setup-step",
    content: "",
    fg: UI.action,
    flexShrink: 0,
  });
  const instruction = new TextRenderable(renderer, {
    id: "provider-setup-instruction",
    content: "",
    fg: UI.text,
    flexShrink: 0,
  });

  const summary = new BoxRenderable(renderer, {
    id: "provider-setup-summary",
    width: "100%",
    flexDirection: "column",
    flexShrink: 0,
    paddingTop: 1,
    backgroundColor: UI.ground,
  });
  const summarySlots = Array.from(
    { length: SUMMARY_SLOTS },
    (_, i) =>
      new TextRenderable(renderer, {
        id: `provider-setup-summary-${String(i)}`,
        content: "",
        fg: UI.textDim,
      }),
  );
  for (const row of summarySlots) summary.add(row);

  const listBox = new BoxRenderable(renderer, {
    id: "provider-setup-list",
    width: "100%",
    flexDirection: "column",
    flexShrink: 0,
    paddingTop: 1,
    backgroundColor: UI.ground,
  });
  const listSlots = Array.from(
    { length: PROVIDER_LIST_ROWS_MAX },
    (_, i) =>
      new TextRenderable(renderer, {
        id: `provider-setup-list-${String(i)}`,
        content: "",
        fg: UI.textDim,
      }),
  );
  for (const row of listSlots) listBox.add(row);

  const inputFrame = new BoxRenderable(renderer, {
    id: "provider-setup-input-frame",
    width: "100%",
    height: 3,
    flexShrink: 0,
    border: true,
    borderColor: UI.textFaint,
    focusedBorderColor: UI.inFlight,
    backgroundColor: UI.ground,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const input = new InputRenderable(renderer, {
    id: "provider-setup-input",
    width: "100%",
    maxLength: FIELD_MAX_LENGTH,
    placeholder: PROVIDER_FIELD_HINTS.apiKey,
    backgroundColor: UI.ground,
    focusedBackgroundColor: UI.ground,
    textColor: UI.text,
    cursorColor: UI.text,
    placeholderColor: UI.textFaint,
  });
  inputFrame.add(input);

  const loginBox = new BoxRenderable(renderer, {
    id: "provider-setup-login",
    width: "100%",
    flexDirection: "column",
    flexShrink: 0,
    paddingTop: 1,
    backgroundColor: UI.ground,
    visible: false,
  });
  const loginSlots = Array.from(
    { length: LOGIN_ROWS },
    (_, i) =>
      new TextRenderable(renderer, {
        id: `provider-setup-login-${String(i)}`,
        content: "",
        fg: UI.textDim,
      }),
  );
  for (const row of loginSlots) loginBox.add(row);

  const statusLine = new TextRenderable(renderer, {
    id: "provider-setup-status",
    content: "",
    fg: UI.textDim,
    flexShrink: 0,
  });
  const guidance = new TextRenderable(renderer, {
    id: "provider-setup-guidance",
    content: "",
    fg: UI.textDim,
    flexShrink: 0,
  });
  const telemetry = new BoxRenderable(renderer, {
    id: "provider-setup-telemetry",
    width: "100%",
    flexDirection: "column",
    flexShrink: 0,
    paddingTop: 1,
    backgroundColor: UI.ground,
    visible: config.showTelemetryNotice,
  });
  const telemetrySlots = Array.from(
    { length: TELEMETRY_ROWS },
    (_, i) =>
      new TextRenderable(renderer, {
        id: `provider-setup-telemetry-${String(i)}`,
        content: "",
        // A disclosure, not fine print: body emphasis, above the footer.
        fg: UI.text,
      }),
  );
  for (const row of telemetrySlots) telemetry.add(row);
  if (config.showTelemetryNotice) {
    const width = Math.max(20, (renderer.width || 80) - margin * 2);
    const lines = wrapLines(TELEMETRY_NOTICE, width).slice(0, TELEMETRY_ROWS);
    lines.forEach((line, i) => {
      const slot = telemetrySlots[i];
      if (slot !== undefined) slot.content = line;
    });
  }

  const footer = new TextRenderable(renderer, {
    id: "provider-setup-footer",
    content: "",
    fg: UI.textFaint,
    flexShrink: 0,
  });

  root.add(header);
  root.add(intro);
  root.add(step);
  root.add(instruction);
  root.add(summary);
  root.add(listBox);
  root.add(loginBox);
  root.add(inputFrame);
  root.add(statusLine);
  root.add(guidance);
  root.add(telemetry);
  root.add(footer);
  renderer.root.add(root);

  const paintSummary = (): void => {
    const rows = summaryRows(
      selectors.steps(),
      state.stepIndex,
      state.values,
      state.choice,
    );
    summarySlots.forEach((slot, i) => {
      const row = rows[i];
      if (row === undefined) {
        slot.content = "";
        slot.visible = false;
        return;
      }
      slot.visible = true;
      slot.content = summaryLine(row);
      slot.fg = summaryColor(row);
    });
  };

  const paintList = (): void => {
    const showList = selectors.isListStep() && !state.submitting;
    listBox.visible = showList;
    if (!showList) {
      for (const slot of listSlots) {
        slot.content = "";
        slot.visible = false;
      }
      return;
    }
    const slice = state.list.visibleRange();
    listSlots.forEach((slot, i) => {
      const index = slice.start + i;
      const row = index < slice.end ? state.listRows[index] : undefined;
      if (row === undefined) {
        slot.content = "";
        slot.visible = false;
        return;
      }
      const active = index === state.list.activeIndex;
      slot.visible = true;
      slot.content = ` ${active ? ">" : " "} ${row.label}`;
      slot.fg = active ? UI.text : UI.textDim;
    });
  };

  const isLoginStep = (): boolean => selectors.currentStep() === "login";

  const paintLogin = (): void => {
    const show = isLoginStep() && !state.submitting;
    loginBox.visible = show;
    const width = Math.max(20, (renderer.width || 80) - margin * 2);
    const lines: string[] =
      !show || state.loginURL === null
        ? []
        : ["open this url to authorize:", ...wrapLines(state.loginURL, width)];
    loginSlots.forEach((slot, i) => {
      const line = lines[i];
      if (line === undefined) {
        slot.content = "";
        slot.visible = false;
        return;
      }
      slot.visible = true;
      slot.content = line;
      // The url is the one thing to act on here, so it reads above chrome.
      slot.fg = i === 0 ? UI.textDim : UI.inFlightBright;
    });
  };

  const paintStatus = (): void => {
    if (
      !state.submitting &&
      selectors.isOllamaModelStep() &&
      state.ollamaDiscovery !== "idle"
    ) {
      if (state.ollamaDiscovery === "loading") {
        const ramp = rampFor({ phase: "working", nowMs: Date.now() });
        statusLine.content = rampLine(ramp, "checking installed Ollama models");
        statusLine.fg = ramp.fg;
        guidance.content = "esc to edit the Ollama URL";
        return;
      }
      if (state.ollamaDiscovery.status !== "models") {
        const empty = state.ollamaDiscovery.status === "empty";
        const malformed = state.ollamaDiscovery.status === "malformed";
        const ramp = rampFor({ phase: "blocked", nowMs: 0 });
        statusLine.content = rampLine(
          ramp,
          ollamaDiscoveryFailureLine(state.ollamaDiscovery),
        );
        statusLine.fg = ramp.fg;
        guidance.content = empty
          ? "pull a model, then press enter to retry · esc to edit url"
          : malformed
            ? "check the Ollama URL, then press enter to retry · esc to edit url"
            : "press enter to retry · esc to edit url";
        return;
      }
    }
    if (!state.submitting && selectors.isAccountNameStep()) {
      if (state.oauthProfileError !== null) {
        const ramp = rampFor({ phase: "blocked", nowMs: 0 });
        statusLine.content = rampLine(ramp, state.oauthProfileError);
        statusLine.fg = ramp.fg;
        guidance.content = "fix the name and press enter";
        guidance.fg = UI.textDim;
        return;
      }
      if (state.oauthProfileConfirmPending) {
        const ramp = rampFor({ phase: "blocked", nowMs: 0 });
        statusLine.content = rampLine(
          ramp,
          `"${state.confirmedSlug ?? state.values.oauthProfile}" is already connected`,
        );
        statusLine.fg = ramp.fg;
        guidance.content =
          state.choice?.oauth != null
            ? "enter again to re-authorize this account · esc to cancel"
            : "enter again to replace this instance's key · esc to cancel";
        guidance.fg = UI.textDim;
        return;
      }
    }
    if (!state.submitting && isLoginStep()) {
      if (state.loginStatus === "failed") {
        const ramp = rampFor({ phase: "blocked", nowMs: 0 });
        statusLine.content = rampLine(
          ramp,
          (state.loginError ?? "").toLowerCase(),
        );
        statusLine.fg = ramp.fg;
        guidance.content = loginGuidance();
        guidance.fg = UI.textDim;
        return;
      }
      if (state.loginStatus === "done") {
        const ramp = rampFor({ phase: "done", nowMs: 0 });
        statusLine.content = rampLine(
          ramp,
          `signed in as ${state.loginResult?.providerName ?? "the account"}`,
        );
        statusLine.fg = ramp.fg;
        guidance.content = "enter to pick a model";
        guidance.fg = UI.textDim;
        return;
      }
      const ramp = rampFor({ phase: "working", nowMs: Date.now() });
      statusLine.content = rampLine(ramp, LOGIN_WAITING_LABEL);
      statusLine.fg = ramp.fg;
      guidance.content =
        "the browser should have opened — paste the url if not";
      guidance.fg = UI.textDim;
      return;
    }
    if (!state.submitting && state.loginCancelled) {
      const ramp = rampFor({ phase: "blocked", nowMs: 0 });
      statusLine.content = rampLine(ramp, LOGIN_CANCELLED_MESSAGE);
      statusLine.fg = ramp.fg;
      guidance.content = loginCancelGuidance();
      guidance.fg = UI.textDim;
      return;
    }
    if (state.submitting) {
      const ramp = rampFor({ phase: "working", nowMs: Date.now() });
      statusLine.content = rampLine(
        ramp,
        SUBMIT_PHASE_LABEL[state.submitPhase],
      );
      statusLine.fg = ramp.fg;
      guidance.content = "";
      return;
    }
    if (state.submitError !== null) {
      const ramp = rampFor({ phase: "blocked", nowMs: 0 });
      statusLine.content = rampLine(ramp, state.submitError.toLowerCase());
      statusLine.fg = ramp.fg;
      guidance.content = failureGuidance(
        state.submitPhase,
        state.choice,
        state.saveAnywayOffered,
      );
      guidance.fg = UI.textDim;
      return;
    }
    statusLine.content = "";
    guidance.content = "";
  };

  const paintFooter = (): void => {
    if (state.submitting) {
      footer.content = "ctrl+c cancel";
      return;
    }
    if (selectors.isOllamaModelStep() && !selectors.isListStep()) {
      footer.content = "enter retry · esc edit url · ctrl+c cancel";
      return;
    }
    if (isLoginStep()) {
      footer.content =
        state.loginStatus === "failed"
          ? "enter retry · esc back · ctrl+c cancel"
          : state.loginStatus === "done"
            ? "enter continue · esc back · ctrl+c cancel"
            : "esc cancel sign-in · ctrl+c quit";
      return;
    }
    footer.content = selectors.isListStep()
      ? "↑↓ move · enter choose · ctrl+c cancel"
      : state.stepIndex === 0
        ? "enter confirm · ctrl+c cancel"
        : "enter confirm · esc back · ctrl+c cancel";
  };

  const paint = (): void => {
    const active = selectors.currentStep();
    step.content = stepHeadline(
      selectors.steps(),
      state.stepIndex,
      state.choice,
    );
    instruction.content =
      selectors.isAccountNameStep() && state.choice !== null
        ? accountNamePrompt(state.choice)
        : STEP_PROMPTS[active];
    paintSummary();
    paintList();
    paintLogin();
    const showInput =
      !selectors.isListStep() &&
      !isLoginStep() &&
      !selectors.isOllamaModelStep() &&
      !state.submitting;
    inputFrame.visible = showInput;
    input.visible = showInput;
    paintStatus();
    paintFooter();
  };

  return { root, input, paint, paintStatus };
}
