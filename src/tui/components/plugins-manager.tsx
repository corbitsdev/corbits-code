import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { ReactNode } from "react";
import { color } from "../theme.js";
import type { PluginConfig } from "../../config/settings.js";
import type { PluginCredentialField, PluginKind } from "../../plugins/manifest.js";

export type PluginDescriptor = {
  id: string;
  name: string;
  kind?: PluginKind;
  description?: string;
  credentials: PluginCredentialField[];
};

export type VerifyResult = { ok: boolean; message: string };
export type AddPathResult = { ok: boolean; message: string; id?: string };

export type PluginsAdmin = {
  list: () => PluginDescriptor[];
  getConfig: () => Record<string, PluginConfig>;
  getWebOverride: () => string | undefined;
  saveConfig: (id: string, cfg: PluginConfig) => Promise<void> | void;
  setWebOverride: (id: string | undefined) => Promise<void> | void;
  verify: (id: string, credentials: Record<string, string>) => Promise<VerifyResult>;
  // Register a plugin from an arbitrary file/dir path, persisting it so it loads
  // on future startups. Returns the new plugin id on success.
  addPath: (path: string) => Promise<AddPathResult>;
};

export type PluginsManagerProps = {
  admin: PluginsAdmin;
  onClose: () => void;
};

type Status = { busy?: boolean; ok?: boolean; message?: string };

function maskSecret(value: string): string {
  if (value.length === 0) return "";
  if (value.length <= 4) return "••••";
  return `••••${value.slice(-4)}`;
}

export function PluginsManager({ admin, onClose }: PluginsManagerProps): ReactNode {
  // Bumped after an add so admin.list() (a live mutable array) is re-read.
  const [, setVersion] = useState(0);
  const plugins = admin.list();
  const [config, setConfig] = useState<Record<string, PluginConfig>>(() => admin.getConfig());
  const [webOverride, setWebOverride] = useState<string | undefined>(() => admin.getWebOverride());
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [buffer, setBuffer] = useState("");
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  // Add-by-path mode: when non-null, the field captures a filesystem path.
  const [addingPath, setAddingPath] = useState<string | null>(null);
  const [addStatus, setAddStatus] = useState<Status | null>(null);
  // Consent mode: when set to a plugin id, a tool plugin is awaiting y/n consent.
  const [consenting, setConsenting] = useState<string | null>(null);

  const active = plugins.length > 0 ? Math.min(selected, plugins.length - 1) : 0;
  const current = plugins[active];

  const credValue = (id: string, key: string): string => config[id]?.credentials?.[key] ?? "";
  const isEnabled = (id: string): boolean => config[id]?.enabled === true;
  const isConsented = (id: string): boolean => config[id]?.consented === true;

  const persist = (id: string, cfg: PluginConfig): void => {
    setConfig((prev) => ({ ...prev, [id]: cfg }));
    void admin.saveConfig(id, cfg);
  };

  const commitEdit = (): void => {
    if (current === undefined || editing === null) return;
    const existing = config[current.id] ?? {};
    persist(current.id, {
      ...existing,
      credentials: { ...(existing.credentials ?? {}), [editing]: buffer },
    });
    setEditing(null);
    setBuffer("");
  };

  const runVerify = (): void => {
    if (current === undefined) return;
    const id = current.id;
    setStatuses((s) => ({ ...s, [id]: { busy: true } }));
    void Promise.resolve(admin.verify(id, config[id]?.credentials ?? {})).then(
      (result) => setStatuses((s) => ({ ...s, [id]: { ok: result.ok, message: result.message } })),
      (err: unknown) => setStatuses((s) => ({ ...s, [id]: { ok: false, message: err instanceof Error ? err.message : String(err) } })),
    );
  };

  const commitAddPath = (): void => {
    const path = addingPath ?? "";
    setAddStatus({ busy: true });
    void Promise.resolve(admin.addPath(path)).then(
      (result) => {
        setAddStatus({ ok: result.ok, message: result.message });
        if (result.ok) { setAddingPath(null); setVersion((v) => v + 1); }
      },
      (err: unknown) => setAddStatus({ ok: false, message: err instanceof Error ? err.message : String(err) }),
    );
  };

  useInput((input, key) => {
    if (consenting !== null) {
      if (input === "y" || input === "Y") {
        const existing = config[consenting] ?? {};
        persist(consenting, { ...existing, enabled: true, consented: true });
      }
      setConsenting(null);
      return;
    }

    if (addingPath !== null) {
      if (key.escape) { setAddingPath(null); setAddStatus(null); return; }
      if (key.return) { commitAddPath(); return; }
      if (key.backspace || key.delete) { setAddingPath((p) => (p ?? "").slice(0, -1)); return; }
      if (input.length > 0 && !key.ctrl && !key.meta) setAddingPath((p) => (p ?? "") + input);
      return;
    }

    if (editing !== null) {
      if (key.escape) { setEditing(null); setBuffer(""); return; }
      if (key.return) { commitEdit(); return; }
      if (key.backspace || key.delete) { setBuffer((b) => b.slice(0, -1)); return; }
      if (input.length > 0 && !key.ctrl && !key.meta) setBuffer((b) => b + input);
      return;
    }

    if (key.escape) { onClose(); return; }
    if (input === "a") { setAddingPath(""); setAddStatus(null); return; }
    if (plugins.length === 0) return;
    if (key.upArrow) { setSelected((s) => (s > 0 ? s - 1 : plugins.length - 1)); return; }
    if (key.downArrow) { setSelected((s) => (s < plugins.length - 1 ? s + 1 : 0)); return; }
    if (current === undefined) return;

    if (input === "e") {
      const enabling = !isEnabled(current.id);
      // Enabling a tool plugin needs explicit consent the first time — its tools
      // run in-process. Consent is a persistent grant: disabling keeps it, so
      // re-enabling a previously-consented plugin does not re-prompt. "Active"
      // (isToolPluginActive) still requires enabled AND consented.
      if (enabling && current.kind === "tool" && !isConsented(current.id)) {
        setConsenting(current.id);
        return;
      }
      persist(current.id, { ...(config[current.id] ?? {}), enabled: enabling });
      return;
    }
    if (input === "w" && current.kind === "web") {
      const next = webOverride === current.id ? undefined : current.id;
      setWebOverride(next);
      void admin.setWebOverride(next);
      return;
    }
    if (input === "v" && (current.kind === "web" || current.kind === "tool")) { runVerify(); return; }
    if (/^[1-9]$/.test(input)) {
      const field = current.credentials[Number(input) - 1];
      if (field !== undefined) {
        setEditing(field.key);
        setBuffer(credValue(current.id, field.key));
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color("accent")} paddingX={2} paddingY={1} marginX={1} marginY={1}>
      <Text bold color={color("accent")}>Plugins</Text>
      {plugins.length === 0 ? (
        <Box marginTop={1}>
          <Text color={color("muted")}>No plugins discovered. Drop one in .intercode/plugins/ or ~/.intercode/plugins/.</Text>
        </Box>
      ) : (
        plugins.map((p, i) => {
          const isActive = i === active;
          const enabled = isEnabled(p.id);
          const webActive = webOverride === p.id;
          const status = statuses[p.id];
          return (
            <Box key={p.id} flexDirection="column" marginTop={1}>
              <Box gap={1}>
                <Text color={isActive ? color("brand") : color("muted")} bold={isActive}>{isActive ? "›" : " "}</Text>
                <Text bold={isActive}>{p.name}</Text>
                {p.kind !== undefined && <Text color={color("dim")} dimColor>{`[${p.kind}]`}</Text>}
                <Text color={enabled ? color("success") : color("dim")}>{enabled ? "● enabled" : "○ disabled"}</Text>
                {webActive && <Text color={color("accent")}>web override</Text>}
                {p.kind === "tool" && isConsented(p.id) && <Text color={color("dim")} dimColor>consented</Text>}
              </Box>
              {isActive && p.description !== undefined && (
                <Box marginLeft={2}><Text color={color("muted")}>{p.description}</Text></Box>
              )}
              {isActive && p.credentials.map((field, ci) => {
                const raw = credValue(p.id, field.key);
                const display = editing === field.key
                  ? `${buffer}▏`
                  : raw.length === 0
                    ? "(not set)"
                    : field.secret ? maskSecret(raw) : raw;
                const valueColor = editing === field.key ? color("brand") : raw.length === 0 ? color("dim") : undefined;
                return (
                  <Box key={field.key} marginLeft={2} gap={1}>
                    <Text color={color("dim")} dimColor>{`${ci + 1}.`}</Text>
                    <Text color={color("muted")}>{field.label}:</Text>
                    <Text {...(valueColor !== undefined ? { color: valueColor } : {})}>{display}</Text>
                  </Box>
                );
              })}
              {isActive && status !== undefined && (
                <Box marginLeft={2}>
                  <Text color={status.busy ? color("muted") : status.ok ? color("success") : color("danger")}>
                    {status.busy ? "verifying…" : `${status.ok ? "✓" : "✗"} ${status.message ?? ""}`}
                  </Text>
                </Box>
              )}
            </Box>
          );
        })
      )}
      {addingPath !== null && (
        <Box flexDirection="column" marginTop={1}>
          <Box gap={1}>
            <Text color={color("accent")}>Add plugin path:</Text>
            <Text color={color("brand")}>{`${addingPath}▏`}</Text>
          </Box>
          {addStatus !== null && (
            <Text color={addStatus.busy ? color("muted") : addStatus.ok ? color("success") : color("danger")}>
              {addStatus.busy ? "loading…" : `${addStatus.ok ? "✓" : "✗"} ${addStatus.message ?? ""}`}
            </Text>
          )}
        </Box>
      )}
      {addingPath === null && addStatus !== null && (
        <Box marginTop={1}>
          <Text color={addStatus.ok ? color("success") : color("danger")}>{`${addStatus.ok ? "✓" : "✗"} ${addStatus.message ?? ""}`}</Text>
        </Box>
      )}
      {consenting !== null && (
        <Box marginTop={1}>
          <Text color={color("warning")}>
            This tool plugin adds tools that run in-process with full agent access. Enable and trust it? (y/n) — takes effect next launch.
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={color("muted")}>
          {consenting !== null
            ? "y to consent and enable · any other key to cancel"
            : addingPath !== null
              ? "type a file or directory path · Enter add · Esc cancel"
              : editing !== null
                ? "type value · Enter save · Esc cancel"
                : "↑↓ select · 1-9 edit credential · e enable · w web override · v verify · a add by path · Esc close"}
        </Text>
      </Box>
    </Box>
  );
}
