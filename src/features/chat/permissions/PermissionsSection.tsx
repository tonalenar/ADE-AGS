import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { NotificationsSetting } from "@/features/settings/NotificationsSetting";
import { ChatSegmented, SettingsGroup, SettingsSection } from "@/features/settings/SettingsSection";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID } from "@/features/tabs/types";
import { PopupSelect } from "@/shared/ui/PopupSelect";

import { INBOX_SHORTCUT } from "./PermissionCard";
import type { AskKind } from "./permissionModel";
import { addRule, loadRules, removeRule, updateRule, usePermissions } from "./permissionsStore";

const KINDS: AskKind[] = ["command", "edit", "network"];
const ANY = "*";

/**
 * A seção "Permissões" das Configurações: as regras "Sempre permitir <padrão>" (criadas no cartão do
 * fio ou aqui), por tipo, padrão e agente. Risco alto nunca é permitido sozinho, mesmo casando. O
 * aviso do sistema é o mesmo das missões (`notifications.enabled`).
 */
export function PermissionsSection() {
  const { t } = useTranslation();
  const rules = usePermissions((s) => s.rules);
  const loaded = usePermissions((s) => s.rulesLoaded);
  const agents = useTabsStore((s) => s.detectedAgents).filter((a) => a.id !== SHELL_AGENT_ID);
  const labelOf = (id: string | null) => (id ? agents.find((a) => a.id === id)?.label ?? id : t("chat.rules.anyAgent"));
  const [kind, setKind] = useState<AskKind>("command");
  const [pattern, setPattern] = useState("");
  const [agent, setAgent] = useState<string>(ANY);
  useEffect(() => { if (!loaded) void loadRules(); }, [loaded]);

  const add = () => {
    if (!pattern.trim()) return;
    addRule({ kind, pattern: pattern.trim(), agentId: agent === ANY ? null : agent });
    setPattern("");
  };
  const kindOptions = KINDS.map((k) => ({ value: k, label: t(`chat.rules.kind.${k}`) }));

  return (
    <>
      <SettingsSection title={t("chat.rules.title")} description={t("chat.rules.desc")}>
        <SettingsGroup>
          {rules.length === 0 && <p className="m-0 px-4 py-3.5 text-[13px] text-gray-500 dark:text-white/50">{t("chat.rules.empty")}</p>}
          {rules.map((rule) => (
            <div key={rule.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="w-[86px] shrink-0 text-[13px] text-gray-500 dark:text-white/50">{t(`chat.rules.kind.${rule.kind}`)}</span>
              <code className="flex-1 min-w-[140px] truncate font-mono text-[13px] text-gray-900 dark:text-white" title={rule.pattern}>{rule.pattern}</code>
              <PopupSelect value={rule.agentId ?? ANY} title={t("chat.rules.agent")}
                onChange={(e) => updateRule(rule.id, { agentId: e.target.value === ANY ? null : e.target.value })}
                className="h-7 min-w-[150px] text-[12.5px]">
                <option value={ANY}>{t("chat.rules.anyAgent")}</option>
                {rule.agentId && !agents.some((a) => a.id === rule.agentId) && <option value={rule.agentId}>{labelOf(rule.agentId)}</option>}
                {agents.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </PopupSelect>
              <button type="button" onClick={() => removeRule(rule.id)}
                className="h-7 px-2.5 rounded-md border border-gray-200 dark:border-white/10 text-[12.5px] text-red-700 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
                {t("chat.rules.remove")}
              </button>
            </div>
          ))}
          <form className="flex flex-wrap items-center gap-3 px-4 py-3" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <ChatSegmented label={t("chat.rules.kindLabel")} options={kindOptions} value={kind} onChange={setKind} />
            <label className="flex-1 min-w-[160px]">
              <span className="sr-only">{t("chat.rules.pattern")}</span>
              <input value={pattern} onChange={(e) => setPattern(e.target.value)}
                placeholder={t(`chat.rules.placeholder.${kind}`)}
                className="w-full h-8 px-2.5 rounded-md border border-gray-200 dark:border-white/10 bg-transparent font-mono text-[13px] outline-none focus:ring-1 focus:ring-accent-500/70" />
            </label>
            <PopupSelect value={agent} title={t("chat.rules.agent")} onChange={(e) => setAgent(e.target.value)} className="h-8 min-w-[150px] text-[12.5px]">
              <option value={ANY}>{t("chat.rules.anyAgent")}</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </PopupSelect>
            <button type="submit" disabled={!pattern.trim()}
              className="h-8 px-3.5 rounded-md bg-accent-600 text-white text-[13px] font-medium hover:bg-accent-700 disabled:opacity-50">
              {t("chat.rules.add")}
            </button>
          </form>
        </SettingsGroup>
        <p className="m-0 mx-1 text-[12.5px] text-gray-500 dark:text-white/45">{t("chat.rules.highNever")}</p>
      </SettingsSection>
      <SettingsSection title={t("chat.rules.inbox")} description={t("chat.rules.inboxDesc", { shortcut: INBOX_SHORTCUT })}>
        <SettingsGroup><NotificationsSetting /></SettingsGroup>
      </SettingsSection>
    </>
  );
}
