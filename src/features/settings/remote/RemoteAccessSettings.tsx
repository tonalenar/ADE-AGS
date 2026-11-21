import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { Button, Input } from "neogestify-ui-components";

import { AlertaToast } from "@/shared/ui/alerts";
import { PopupSelect } from "@/shared/ui/PopupSelect";
import { useTabsStore } from "@/features/tabs/store";
import { SettingsGroup, SettingsRow, SettingsSection, SettingsToggleRow } from "../SettingsSection";
import {
  remoteClientPair,
  remoteClientRevoke,
  remoteClientsList,
  remoteSetEnabled,
  remoteStatus,
  type RemoteClient,
  type RemotePreset,
  type RemoteServerStatus,
} from "./ipc";
import { buildClientSnippets, remoteServerHost } from "./snippets";

const DEFAULT_PORT = 47820;

const PRESET_OPTIONS: readonly { value: RemotePreset; labelKey: string }[] = [
  { value: "read", labelKey: "settings.remote.preset.read" },
  { value: "browser", labelKey: "settings.remote.preset.browser" },
  { value: "agents", labelKey: "settings.remote.preset.agents" },
  { value: "all", labelKey: "settings.remote.preset.all" },
];

const TTL_OPTIONS: readonly { value: string; labelKey: string }[] = [
  { value: "7", labelKey: "settings.remote.ttl.7d" },
  { value: "30", labelKey: "settings.remote.ttl.30d" },
  { value: "90", labelKey: "settings.remote.ttl.90d" },
  { value: "0", labelKey: "settings.remote.ttl.never" },
];

function formatTimestamp(ts: number | null, neverText: string): string {
  if (!ts) return neverText;
  try {
    return new Date(ts * 1000).toLocaleString();
  } catch {
    return String(ts);
  }
}

export function RemoteAccessSettings() {
  const { t } = useTranslation();
  const activeCwd = useTabsStore(
    (s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.cwd ?? s.tabs[0]?.cwd ?? "",
  );

  const [status, setStatus] = useState<RemoteServerStatus | null>(null);
  const [clients, setClients] = useState<RemoteClient[]>([]);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [preset, setPreset] = useState<RemotePreset>("browser");
  const [defaultFolder, setDefaultFolder] = useState(activeCwd);
  const [extraFolders, setExtraFolders] = useState("");
  const [ttlDays, setTtlDays] = useState("30");
  const [pairing, setPairing] = useState(false);

  // Token exibido uma única vez logo após o pareamento; limpo ao dispensar.
  const [pairedOnce, setPairedOnce] = useState<{ client: RemoteClient; token: string } | null>(null);
  const tRef = useRef(t);
  tRef.current = t;

  const loadAll = useCallback(async () => {
    try {
      const [st, list] = await Promise.all([remoteStatus(), remoteClientsList()]);
      setStatus(st);
      setClients(list);
    } catch (error) {
      AlertaToast(tRef.current("settings.remote"), String(error), "error", 6000);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!defaultFolder && activeCwd) setDefaultFolder(activeCwd);
  }, [activeCwd, defaultFolder]);

  const handleToggle = async (nextEnabled: boolean) => {
    setBusy(true);
    try {
      const next = await remoteSetEnabled(nextEnabled, status?.port ?? DEFAULT_PORT);
      setStatus(next);
    } catch (error) {
      AlertaToast(t("settings.remote"), String(error), "error", 6000);
    } finally {
      setBusy(false);
    }
  };

  const handlePickFolder = async () => {
    try {
      const picked = await open({ directory: true, multiple: false, title: t("settings.remote.pair.defaultFolder") });
      if (typeof picked === "string" && picked) setDefaultFolder(picked);
    } catch {
      /* cancelado pelo usuário */
    }
  };

  const handlePair = async () => {
    const cleanName = name.trim();
    const cleanDefault = defaultFolder.trim();
    if (!cleanName || !cleanDefault) {
      AlertaToast(t("settings.remote.pair.title"), t("settings.remote.pair.required"), "error", 5000);
      return;
    }
    const extras = extraFolders
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const folders = [cleanDefault, ...extras];
    const parsedTtl = Number.parseInt(ttlDays, 10);
    setPairing(true);
    try {
      const result = await remoteClientPair({
        name: cleanName,
        preset,
        folders,
        defaultFolder: cleanDefault,
        ttlDays: Number.isFinite(parsedTtl) && parsedTtl > 0 ? parsedTtl : null,
      });
      setPairedOnce(result);
      setClients((prev) => [...prev, result.client]);
      setName("");
      setExtraFolders("");
    } catch (error) {
      AlertaToast(t("settings.remote.pair.title"), String(error), "error", 6000);
    } finally {
      setPairing(false);
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      await remoteClientRevoke(id);
      setClients((prev) => prev.filter((c) => c.id !== id));
      setPairedOnce((curr) => (curr?.client.id === id ? null : curr));
    } catch (error) {
      AlertaToast(t("settings.remote.clients.title"), String(error), "error", 6000);
    }
  };

  const copyText = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      AlertaToast(t("settings.remote"), t("settings.remote.copied"), "info", 2500);
    } catch {
      AlertaToast(t("settings.remote"), t("settings.remote.copyError"), "error", 4000);
    }
  };

  const host = remoteServerHost(status?.tailscaleIp);
  const port = status?.port ?? DEFAULT_PORT;
  const snippets = useMemo(
    () => (pairedOnce ? buildClientSnippets(host, port, pairedOnce.token) : null),
    [pairedOnce, host, port],
  );

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection
        title={t("settings.remote.server.title")}
        description={t("settings.remote.server.desc")}
      >
        <SettingsGroup>
          <SettingsToggleRow
            label={t("settings.remote.server.enable")}
            description={t("settings.remote.server.enableHint", { port })}
            checked={status?.enabled ?? false}
            disabled={busy}
            onChange={(checked) => { void handleToggle(checked); }}
          />
          <SettingsRow
            label={t("settings.remote.tailscale.label")}
            hint={t("settings.remote.tailscale.hint")}
          >
            <span
              data-testid="remote-tailscale-status"
              className="font-mono text-[12px] text-gray-700 dark:text-white/80"
            >
              {status?.tailscaleIp ?? t("settings.remote.tailscale.notInstalled")}
            </span>
          </SettingsRow>
          <SettingsRow label={t("settings.remote.server.listen")}>
            <span className="font-mono text-[12px] text-gray-600 dark:text-white/65">
              {(status?.bindAddrs ?? [`127.0.0.1:${port}`]).join(" · ")}
            </span>
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title={t("settings.remote.pair.title")}
        description={t("settings.remote.pair.desc")}
      >
        <SettingsGroup>
          <SettingsRow label={t("settings.remote.pair.name")}>
            <Input
              data-testid="remote-pair-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("settings.remote.pair.namePlaceholder")}
              className="w-60"
            />
          </SettingsRow>
          <SettingsRow label={t("settings.remote.pair.preset")}>
            <PopupSelect
              value={preset}
              onChange={(e) => setPreset(e.target.value as RemotePreset)}
            >
              {PRESET_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {t(opt.labelKey)}
                </option>
              ))}
            </PopupSelect>
          </SettingsRow>
          <SettingsRow
            label={t("settings.remote.pair.defaultFolder")}
            hint={t("settings.remote.pair.defaultFolderHint")}
          >
            <div className="flex items-center gap-2">
              <Input
                data-testid="remote-pair-folder"
                value={defaultFolder}
                onChange={(e) => setDefaultFolder(e.target.value)}
                placeholder={t("settings.remote.pair.folderPlaceholder")}
                className="w-60 font-mono text-[12px]"
              />
              <Button variant="outline" size="sm" onClick={() => { void handlePickFolder(); }}>
                {t("settings.remote.pair.browse")}
              </Button>
            </div>
          </SettingsRow>
          <SettingsRow
            label={t("settings.remote.pair.extraFolders")}
            hint={t("settings.remote.pair.extraFoldersHint")}
          >
            <textarea
              value={extraFolders}
              onChange={(e) => setExtraFolders(e.target.value)}
              rows={2}
              placeholder={t("settings.remote.pair.extraFoldersPlaceholder")}
              className="w-64 rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-surface px-2.5 py-1.5 font-mono text-[11.5px] text-gray-800 dark:text-white/85"
            />
          </SettingsRow>
          <SettingsRow label={t("settings.remote.pair.ttl")}>
            <PopupSelect value={ttlDays} onChange={(e) => setTtlDays(e.target.value)}>
              {TTL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {t(opt.labelKey)}
                </option>
              ))}
            </PopupSelect>
          </SettingsRow>
          <div className="flex justify-end px-4 py-3">
            <Button
              data-testid="remote-pair-submit"
              size="sm"
              disabled={pairing}
              onClick={() => { void handlePair(); }}
            >
              {t("settings.remote.pair.action")}
            </Button>
          </div>
        </SettingsGroup>
      </SettingsSection>

      {pairedOnce && snippets && (
        <SettingsSection
          title={t("settings.remote.token.title", { name: pairedOnce.client.name })}
          description={t("settings.remote.token.onceWarning")}
          action={
            <Button
              data-testid="remote-token-dismiss"
              variant="outline"
              size="sm"
              onClick={() => setPairedOnce(null)}
            >
              {t("settings.remote.token.dismiss")}
            </Button>
          }
        >
          <SettingsGroup>
            <div className="flex flex-col gap-3 px-4 py-3.5">
              <div className="flex items-center justify-between gap-2">
                <code
                  data-testid="remote-token-value"
                  className="flex-1 truncate rounded bg-gray-100 dark:bg-white/[0.06] px-2.5 py-1.5 font-mono text-[12px] text-gray-900 dark:text-white"
                >
                  {pairedOnce.token}
                </code>
                <Button variant="outline" size="sm" onClick={() => { void copyText(pairedOnce.token); }}>
                  {t("settings.remote.copy")}
                </Button>
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-medium text-gray-700 dark:text-white/80">
                    {t("settings.remote.snippet.claudeCode")}
                  </span>
                  <Button variant="outline" size="sm" onClick={() => { void copyText(snippets.claudeCode); }}>
                    {t("settings.remote.copy")}
                  </Button>
                </div>
                <pre className="m-0 overflow-x-auto rounded bg-gray-100 dark:bg-white/[0.05] p-2.5 font-mono text-[11.5px] text-gray-800 dark:text-white/85">
                  {snippets.claudeCode}
                </pre>
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-medium text-gray-700 dark:text-white/80">
                    {t("settings.remote.snippet.codex")}
                  </span>
                  <Button variant="outline" size="sm" onClick={() => { void copyText(snippets.codex); }}>
                    {t("settings.remote.copy")}
                  </Button>
                </div>
                <pre className="m-0 overflow-x-auto rounded bg-gray-100 dark:bg-white/[0.05] p-2.5 font-mono text-[11.5px] text-gray-800 dark:text-white/85">
                  {snippets.codex}
                </pre>
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-medium text-gray-700 dark:text-white/80">
                    {t("settings.remote.snippet.t3Code")}
                  </span>
                  <Button variant="outline" size="sm" onClick={() => { void copyText(snippets.t3Code.text); }}>
                    {t("settings.remote.copy")}
                  </Button>
                </div>
                <pre className="m-0 overflow-x-auto rounded bg-gray-100 dark:bg-white/[0.05] p-2.5 font-mono text-[11.5px] text-gray-800 dark:text-white/85">
                  {snippets.t3Code.text}
                </pre>
              </div>
            </div>
          </SettingsGroup>
        </SettingsSection>
      )}

      <SettingsSection
        title={t("settings.remote.clients.title")}
        description={t("settings.remote.clients.desc")}
      >
        <SettingsGroup>
          {clients.length === 0 ? (
            <p className="m-0 px-4 py-3.5 text-[13px] text-gray-500 dark:text-white/50">
              {t("settings.remote.clients.empty")}
            </p>
          ) : (
            clients.map((client) => (
              <SettingsRow
                key={client.id}
                label={client.name}
                hint={t("settings.remote.clients.meta", {
                  preset: t(`settings.remote.preset.${client.preset}`),
                  folder: client.default_folder,
                  lastSeen: formatTimestamp(client.last_seen_at, t("settings.remote.clients.neverSeen")),
                })}
              >
                <Button
                  data-testid={`remote-revoke-${client.id}`}
                  variant="outline"
                  size="sm"
                  onClick={() => { void handleRevoke(client.id); }}
                >
                  {t("settings.remote.clients.revoke")}
                </Button>
              </SettingsRow>
            ))
          )}
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
