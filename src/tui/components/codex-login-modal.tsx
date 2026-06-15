import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { useState } from "react";
import { color } from "../theme.js";
import { osc8, writeClipboard } from "../util/clipboard.js";

// A handle for an in-progress Codex login: the URL to authorize at and a
// promise that settles when the browser round-trip + token exchange completes.
export type CodexLoginStart = {
  authorizeUrl: string;
  completed: Promise<{ profile: string }>;
  cancel: () => void;
};

export type CodexLoginModalProps = {
  // Codex profiles already authorized, by name.
  profiles: string[];
  // The currently active provider, so the active Codex profile is marked.
  activeProfile: string | undefined;
  // Begin a login for `name`; resolves once the callback server is listening.
  onStartLogin: (name: string) => Promise<CodexLoginStart>;
  // Switch the active provider to an existing Codex profile.
  onSwitchProfile: (name: string) => void;
  // Remove a profile from the auth store.
  onRemoveProfile: (name: string) => void;
  onClose: () => void;
};

type Step = "list" | "name" | "pending" | "done" | "error" | "remove";

function validateProfileName(raw: string, existing: string[]): string | null {
  const name = raw.trim();
  if (name.length === 0) return "Profile name is required";
  if (!/^[\w-]+$/.test(name)) return "Use letters, numbers, hyphens, or underscores only";
  if (existing.includes(name)) return `Profile "${name}" already exists`;
  return null;
}

export function CodexLoginModal({
  profiles,
  activeProfile,
  onStartLogin,
  onSwitchProfile,
  onRemoveProfile,
  onClose,
}: CodexLoginModalProps): ReactNode {
  const [step, setStep] = useState<Step>(profiles.length > 0 ? "list" : "name");
  const [cursor, setCursor] = useState(0);
  const [nameValue, setNameValue] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState<string>("");
  const [resultMessage, setResultMessage] = useState<string>("");
  const [handle, setHandle] = useState<CodexLoginStart | null>(null);

  const beginLogin = (name: string): void => {
    setPendingName(name);
    setStep("pending");
    setAuthorizeUrl(null);
    void onStartLogin(name).then(
      (started) => {
        setHandle(started);
        setAuthorizeUrl(started.authorizeUrl);
        started.completed.then(
          (res) => {
            setResultMessage(`Authorized Codex profile "${res.profile}".`);
            setStep("done");
            onSwitchProfile(res.profile);
          },
          (err: unknown) => {
            setResultMessage(err instanceof Error ? err.message : String(err));
            setStep("error");
          },
        );
      },
      (err: unknown) => {
        setResultMessage(err instanceof Error ? err.message : String(err));
        setStep("error");
      },
    );
  };

  useInput((input, key) => {
    if (step === "list") {
      if (key.upArrow) {
        setCursor((i) => (i > 0 ? i - 1 : profiles.length - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((i) => (i < profiles.length - 1 ? i + 1 : 0));
        return;
      }
      if (key.return) {
        const name = profiles[cursor];
        if (name !== undefined) {
          onSwitchProfile(name);
          onClose();
        }
        return;
      }
      if (input === "a") {
        setNameValue("");
        setNameError(null);
        setStep("name");
        return;
      }
      if (input === "x") {
        if (profiles.length > 0) setStep("remove");
        return;
      }
      if (key.escape) onClose();
      return;
    }

    if (step === "name") {
      if (key.return) {
        const err = validateProfileName(nameValue, profiles);
        if (err !== null) {
          setNameError(err);
          return;
        }
        beginLogin(nameValue.trim());
        return;
      }
      if (key.escape) {
        if (profiles.length > 0) setStep("list");
        else onClose();
        return;
      }
      if (key.backspace || key.delete) {
        setNameValue((v) => v.slice(0, -1));
        setNameError(null);
        return;
      }
      if (!key.ctrl && !key.meta && input.length > 0) {
        setNameValue((v) => v + input);
        setNameError(null);
      }
      return;
    }

    if (step === "pending") {
      // Ctrl+Y copies the authorize URL for pasting into a browser manually.
      if (key.ctrl && input === "y" && authorizeUrl !== null) {
        writeClipboard(authorizeUrl);
        return;
      }
      if (key.escape) {
        handle?.cancel();
        setStep(profiles.length > 0 ? "list" : "name");
        return;
      }
      return;
    }

    if (step === "remove") {
      if (input === "y") {
        const name = profiles[cursor];
        if (name !== undefined) onRemoveProfile(name);
        setCursor(0);
        // After removal the list may be empty; the parent re-renders with the
        // updated profiles, so fall back to the add step when nothing remains.
        setStep(profiles.length > 1 ? "list" : "name");
        return;
      }
      if (input === "n" || key.escape) {
        setStep("list");
      }
      return;
    }

    // done / error
    if (key.return || key.escape) onClose();
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color("accent")}
      paddingX={2}
      paddingY={1}
      marginX={1}
      marginY={1}
    >
      <Text bold color={color("accent")}>
        Codex Login
      </Text>
      <Box marginTop={1}>
        <Text color={color("muted")}>Sign in with a ChatGPT Plus/Pro subscription</Text>
      </Box>

      {step === "list" && (
        <Box marginTop={1} flexDirection="column">
          {profiles.map((name, i) => {
            const isCursor = i === cursor;
            const isActive = `codex/${name}` === activeProfile;
            return (
              <Box key={name} flexDirection="row" gap={1}>
                <Text color={isCursor ? color("accent") : color("muted")} bold={isCursor}>
                  {isCursor ? ">" : " "}
                </Text>
                <Text color={isCursor ? color("accent") : color("text")}>
                  {isActive ? "* " : "  "}
                  {name}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {step === "name" && (
        <Box marginTop={1} flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text color={color("muted")}>Profile name</Text>
            <Text color={nameValue.length > 0 ? color("text") : color("muted")}>
              {nameValue.length > 0 ? nameValue : "personal, work, ..."}
            </Text>
            <Text color={color("accent")}>|</Text>
          </Box>
          {nameError !== null && (
            <Box marginTop={1}>
              <Text color={color("danger")}>{nameError}</Text>
            </Box>
          )}
        </Box>
      )}

      {step === "pending" && (
        <Box marginTop={1} flexDirection="column">
          {authorizeUrl === null ? (
            <Text color={color("muted")}>Starting authorization for "{pendingName}"…</Text>
          ) : (
            <>
              <Text color={color("text")}>
                Authorizing "{pendingName}". Your browser should open; if not, open this link:
              </Text>
              <Box marginTop={1}>
                <Text color={color("accent")}>{osc8(authorizeUrl, "Open Codex authorization")}</Text>
              </Box>
              <Text color={color("muted")}>{authorizeUrl}</Text>
              <Box marginTop={1}>
                <Text color={color("muted")}>Waiting for you to complete sign-in…</Text>
              </Box>
            </>
          )}
        </Box>
      )}

      {step === "done" && (
        <Box marginTop={1}>
          <Text color={color("success")}>{resultMessage}</Text>
        </Box>
      )}

      {step === "error" && (
        <Box marginTop={1}>
          <Text color={color("danger")}>{resultMessage}</Text>
        </Box>
      )}

      {step === "remove" && (
        <Box marginTop={1} flexDirection="column">
          <Text color={color("danger")}>Remove Codex profile {profiles[cursor]}?</Text>
          <Text color={color("muted")}>y remove · n cancel · Esc cancel</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {step === "list" && "Up/Down navigate · Enter use · a add · x remove · Esc close"}
          {step === "name" && "Type a profile name · Enter sign in · Esc back"}
          {step === "pending" && "Ctrl+Y copy link · Esc cancel"}
          {step === "done" && "Enter close"}
          {step === "error" && "Enter close"}
          {step === "remove" && "y remove · n cancel · Esc back"}
        </Text>
      </Box>
    </Box>
  );
}
