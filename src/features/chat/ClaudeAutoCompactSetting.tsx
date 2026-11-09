import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";

import { useAccountsStore } from "@/features/accounts/store";
import type { AgentAccount } from "@/features/accounts/types";
import { SettingsRow, SettingsSection, SettingsGroup } from "@/features/settings/SettingsSection";
import { PopupSelect } from "@/shared/ui/PopupSelect";
import { getSetting, setSetting } from "@/shared/ipc/settings";
import { CLAUDE_AUTO_COMPACT_WINDOWS_SETTING, CLAUDE_MAIN_ACCOUNT_ID, claudeAutoCompactWindows } from "./claudeAutoCompact";

const SETTING_KEY = CLAUDE_AUTO_COMPACT_WINDOWS_SETTING;
const IDLE_SETTING_KEY = "chat.claude_idle_compaction_modes";
const MAIN_ACCOUNT = CLAUDE_MAIN_ACCOUNT_ID;
type IdleMode = "off" | "onReturn";

function parseIdleModes(raw: string | null): Record<string, IdleMode> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([id, value]) =>
      value === "onReturn" ? [[id, value]] : []));
  } catch {
    return {};
  }
}

function accountLabel(account: AgentAccount, t: (key: string) => string): string {
  return account.id.startsWith("system:") ? t("chat.settings.claudeCompact.mainAccount") : account.label ?? account.name;
}

export function ClaudeAutoCompactSetting() {
  const { t } = useTranslation();
  const accounts = useAccountsStore((s) => s.accounts);
  const systemAccounts = useAccountsStore((s) => s.systemAccounts);
  const accountsLoaded = useAccountsStore((s) => s.loaded);
  const loadAccounts = useAccountsStore((s) => s.load);
  const [selectedAccount, setSelectedAccount] = useState(MAIN_ACCOUNT);
  const [windows, setWindows] = useState<Record<string, number> | null>(null);
  const [idleModes, setIdleModes] = useState<Record<string, IdleMode> | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState(false);
  const availableAccounts = useMemo(() => {
    const list = [...systemAccounts, ...accounts].filter((account) => account.agentId === "claude-code");
    if (!list.some((account) => account.id === MAIN_ACCOUNT)) {
      list.unshift({
        id: MAIN_ACCOUNT,
        agentId: "claude-code",
        name: t("chat.settings.claudeCompact.mainAccount"),
        dir: "",
        envVar: "CLAUDE_CONFIG_DIR",
        loginCommand: "claude",
        loggedIn: false,
        label: null,
        createdAt: 0,
        kind: "login",
        baseUrl: null,
        keyHint: null,
      });
    }
    return [...new Map(list.map((account) => [account.id, account])).values()];
  }, [accounts, systemAccounts, t]);

  useEffect(() => {
    if (!accountsLoaded) void loadAccounts().catch(() => undefined);
  }, [accountsLoaded, loadAccounts]);
  useEffect(() => {
    let alive = true;
    Promise.all([getSetting(SETTING_KEY), getSetting(IDLE_SETTING_KEY)]).then(([windowRaw, idleRaw]) => {
      if (alive) {
        setWindows(claudeAutoCompactWindows(windowRaw));
        setIdleModes(parseIdleModes(idleRaw));
      }
    }).catch(() => {
      if (alive) {
        setWindows({});
        setIdleModes({});
      }
    });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (windows !== null) setDraft(windows[selectedAccount] === undefined ? "" : String(windows[selectedAccount]));
  }, [selectedAccount, windows]);

  const commit = async (next: Record<string, number>) => {
    try {
      await setSetting(SETTING_KEY, JSON.stringify(next));
      setWindows(next);
      setError(false);
    } catch {
      setError(true);
    }
  };
  const save = () => {
    const value = Number(draft);
    if (!Number.isInteger(value) || value < 100_000 || value > 1_000_000 || windows === null) return;
    void commit({ ...windows, [selectedAccount]: value });
  };
  const useProviderDefault = () => {
    if (windows === null || windows[selectedAccount] === undefined) return;
    const next = { ...windows };
    delete next[selectedAccount];
    void commit(next);
  };
  const changeIdleMode = (mode: IdleMode) => {
    if (idleModes === null) return;
    const next = { ...idleModes };
    if (mode === "off") delete next[selectedAccount];
    else next[selectedAccount] = mode;
    void setSetting(IDLE_SETTING_KEY, JSON.stringify(next)).then(() => {
      setIdleModes(next);
      setError(false);
    }).catch(() => setError(true));
  };
  const account = availableAccounts.find((item) => item.id === selectedAccount) ?? availableAccounts[0];
  const value = Number(draft);
  const valid = Number.isInteger(value) && value >= 100_000 && value <= 1_000_000;

  return (
    <SettingsSection title={t("chat.settings.claudeCompact.title")} description={t("chat.settings.claudeCompact.description")}>
      <SettingsGroup>
        <SettingsRow label={t("chat.settings.claudeCompact.account")}>
          <PopupSelect value={selectedAccount} aria-label={t("chat.settings.claudeCompact.account")}
            onChange={(event) => setSelectedAccount(event.target.value)} className="max-w-56">
            {availableAccounts.map((item) => (
              <option key={item.id} value={item.id}>{accountLabel(item, t)}</option>
            ))}
          </PopupSelect>
        </SettingsRow>
        <SettingsRow label={t("chat.settings.claudeCompact.threshold")} hint={t("chat.settings.claudeCompact.thresholdHint")}>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <input type="number" min={100_000} max={1_000_000} step={10_000} value={draft}
              disabled={windows === null} onChange={(event) => setDraft(event.target.value)}
              aria-label={t("chat.settings.claudeCompact.threshold")}
              className="h-8 w-32 rounded-md border border-gray-300 bg-white px-2 text-[13px] text-gray-900 outline-none focus:ring-2 focus:ring-accent-500/40 disabled:opacity-50 dark:border-white/15 dark:bg-white/[0.06] dark:text-white" />
            <Button variant="outline" size="sm" onClick={save} disabled={windows === null || !valid}>
              {t("chat.settings.claudeCompact.save")}
            </Button>
            <Button variant="outline" size="sm" onClick={useProviderDefault}
              disabled={windows === null || windows[selectedAccount] === undefined}>
              {t("chat.settings.claudeCompact.inherit")}
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow label={t("chat.settings.claudeCompact.idleMode")} hint={t("chat.settings.claudeCompact.idleHint")}>
          <PopupSelect value={idleModes?.[selectedAccount] ?? "off"} aria-label={t("chat.settings.claudeCompact.idleMode")}
            disabled={idleModes === null} onChange={(event) => changeIdleMode(event.target.value as IdleMode)} className="max-w-56">
            <option value="off">{t("chat.settings.claudeCompact.idleOff")}</option>
            <option value="onReturn">{t("chat.settings.claudeCompact.idleOnReturn")}</option>
          </PopupSelect>
        </SettingsRow>
        <p className="m-0 px-4 pb-3 text-[12px] leading-4 text-gray-500 dark:text-white/45">
          {t("chat.settings.claudeCompact.sessionHint", { account: account ? accountLabel(account, t) : "Claude Code" })}
        </p>
      </SettingsGroup>
      {error && <p role="alert" className="m-0 text-[12px] text-red-600 dark:text-red-400">{t("chat.settings.claudeCompact.saveFailed")}</p>}
    </SettingsSection>
  );
}
