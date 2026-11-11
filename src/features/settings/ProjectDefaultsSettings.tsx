import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAvailableAgents } from "@/features/agents/useAvailableAgents";
import { ACCESS_MODES, type ChatAccess } from "@/features/chat/chatModel";
import {
  inheritChatProjectField,
  loadChatProjectSettings,
  saveChatProjectField,
  saveChatProjectFields,
} from "@/features/chat/chatProjectPrefs";
import type { ModelChoiceDto } from "@/features/chat/projectChatDefaults";
import {
  commitProjectDefaults,
  notifyProjectDefaults,
  useProjectDefaults,
  useProjectDefaultsVersion,
  withDefaults,
} from "@/features/chat/projectDefaultsStore";
import { isLocalAcpAgent } from "@/features/chat/structured/model";
import { SHELL_AGENT_ID } from "@/features/tabs/types";
import { appConfirm } from "@/shared/ui/appConfirm";
import { PopupSelect } from "@/shared/ui/PopupSelect";
import { ChatSegmented, SettingsGroup, SettingsRow, SettingsSection } from "@/features/settings/SettingsSection";
import { workspaceChoiceOf, type WorkspaceChoice } from "@/features/settings/projectDefaultsModel";

/**
 * Configurações → Projetos → "Aplicando configurações para …": o que as conversas NOVAS deste projeto usam: o agente
 * e o modelo, o modelo reserva (entra no lugar do principal quando ele está sem limite de uso), o workspace e a
 * permissão. Cada campo pode herdar do aparelho. O composer lê a mesma fonte, então o que se muda aqui vale na
 * próxima conversa; as conversas que já existem não mudam.
 *
 * O agente, o modelo, o workspace e a permissão vão para o aparelho e para o banco pelo mesmo caminho do atalho
 * "Padrões por projeto" do composer (`chatProjectPrefs`); o modelo reserva só existe no banco.
 */
export function ProjectDefaultsSetting({ cwd }: { cwd: string }) {
  const { t } = useTranslation();
  const version = useProjectDefaultsVersion(cwd);
  const stored = useProjectDefaults(cwd);
  const [error, setError] = useState<string | null>(null);
  // O que o aparelho tem fixado (a fonte do composer). Relê quando o projeto muda por fora.
  const settings = useMemo(() => loadChatProjectSettings(cwd), [cwd, version, stored]);
  const fixed = settings.defaults ?? {};
  const fail = (key: string) => setError(t(key));
  const saved = () => {
    setError(null);
    notifyProjectDefaults(cwd);
  };

  const savePrimary = (choice: ModelChoiceDto | null) => {
    const ok = choice
      ? saveChatProjectFields(cwd, { agentId: choice.agentId, model: choice.model })
      : inheritChatProjectField(cwd, "agentId") && inheritChatProjectField(cwd, "model");
    if (!ok) return fail("settings.projects.defaults.saveError");
    saved();
  };

  const saveFallback = async (choice: ModelChoiceDto | null) => {
    try {
      await commitProjectDefaults(withDefaults(cwd, { fallback: choice }), { notify: true });
      setError(null);
    } catch (cause) {
      setError(String(cause));
    }
  };

  const saveWorkspace = (choice: WorkspaceChoice) => {
    const ok = choice === "inherit" ? inheritChatProjectField(cwd, "worktree") : saveChatProjectField(cwd, "worktree", choice === "worktree");
    if (!ok) return fail("settings.projects.defaults.saveError");
    saved();
  };

  const saveAccess = async (choice: ChatAccess | "inherit") => {
    if (choice === "full") {
      // Acesso total vira o ponto de partida de TODA conversa nova deste projeto: pede confirmação.
      const confirmed = await appConfirm({
        title: t("settings.projects.defaults.fullAccess.title"),
        lead: t("settings.projects.defaults.fullAccess.lead"),
        note: t("settings.projects.defaults.fullAccess.note"),
        confirmLabel: t("settings.projects.defaults.fullAccess.confirm"),
        cancelLabel: t("btn.cancel"),
        tone: "danger",
      });
      if (!confirmed) return;
    }
    const ok = choice === "inherit" ? inheritChatProjectField(cwd, "access") : saveChatProjectField(cwd, "access", choice);
    if (!ok) return fail("settings.projects.defaults.saveError");
    saved();
  };

  const primary: ModelChoiceDto | null = fixed.agentId ? { agentId: fixed.agentId, model: fixed.model ?? null } : null;
  const accessChoice: ChatAccess | "inherit" = fixed.access ?? "inherit";
  const workspaceChoice = workspaceChoiceOf(fixed.worktree);

  return (
    <SettingsSection title={t("settings.projects.defaults.title")} description={t("settings.projects.defaults.desc")}>
      <SettingsGroup>
        <SettingsRow label={t("settings.projects.defaults.primary")} hint={t("settings.projects.defaults.primary.hint")}>
          <ModelChoiceEditor
            label={t("settings.projects.defaults.primary")}
            choice={primary}
            emptyLabel={t("settings.projects.defaults.inherit")}
            onChange={savePrimary}
          />
        </SettingsRow>
        <SettingsRow label={t("settings.projects.defaults.fallback")} hint={t("settings.projects.defaults.fallback.hint")}>
          <ModelChoiceEditor
            label={t("settings.projects.defaults.fallback")}
            choice={stored?.fallback ?? null}
            emptyLabel={t("settings.projects.defaults.fallback.none")}
            onChange={(choice) => void saveFallback(choice)}
          />
        </SettingsRow>
        <SettingsRow label={t("settings.projects.defaults.workspace")} hint={t("settings.projects.defaults.workspace.hint")}>
          <ChatSegmented<WorkspaceChoice>
            label={t("settings.projects.defaults.workspace")}
            value={workspaceChoice}
            onChange={saveWorkspace}
            options={[
              { value: "inherit", label: t("settings.projects.defaults.inherit") },
              { value: "local", label: t("chat.new.currentCheckout") },
              { value: "worktree", label: t("chat.workspace.newWorktree") },
            ]}
          />
        </SettingsRow>
        <SettingsRow label={t("settings.projects.defaults.access")} hint={t("settings.projects.defaults.access.hint")}>
          <PopupSelect aria-label={t("settings.projects.defaults.access")} value={accessChoice}
            onChange={(e) => void saveAccess(e.target.value as ChatAccess | "inherit")}>
            <option value="inherit">{t("settings.projects.defaults.inherit")}</option>
            {ACCESS_MODES.map((mode) => <option key={mode} value={mode}>{t(`chat.access.${mode}`)}</option>)}
          </PopupSelect>
        </SettingsRow>
        {error && <p role="alert" className="m-0 px-4 py-2 text-[12.5px] text-red-600 dark:text-red-400">{error}</p>}
        {settings.storageError && <p role="alert" className="m-0 px-4 py-2 text-[12.5px] text-red-600 dark:text-red-400">{t("chat.projectDefaults.storageUnreadable")}</p>}
      </SettingsGroup>
    </SettingsSection>
  );
}

/** Um agente e, se ele aceita, o modelo. Sem agente é "herdar" (ou "nenhum", no reserva). */
function ModelChoiceEditor({ label, choice, emptyLabel, onChange }: {
  label: string;
  choice: ModelChoiceDto | null;
  emptyLabel: string;
  onChange: (choice: ModelChoiceDto | null) => void;
}) {
  const { t } = useTranslation();
  const available = useAvailableAgents({ includeLocalAcp: true });
  const agents = useMemo(() => available.filter((a) => a.id !== SHELL_AGENT_ID), [available]);
  const [draft, setDraft] = useState(choice?.model ?? "");
  useEffect(() => setDraft(choice?.model ?? ""), [choice?.model, choice?.agentId]);
  // Um agente ACP local não aceita modelo da ADE.
  const acceptsModel = !!choice && !isLocalAcpAgent(choice.agentId);
  const commitModel = () => {
    if (!choice) return;
    const model = draft.trim() || null;
    if (model !== choice.model) onChange({ agentId: choice.agentId, model });
  };
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <PopupSelect aria-label={label} value={choice?.agentId ?? ""}
        onChange={(e) => onChange(e.target.value ? { agentId: e.target.value, model: null } : null)}>
        <option value="">{emptyLabel}</option>
        {choice && !agents.some((a) => a.id === choice.agentId) && <option value={choice.agentId}>{choice.agentId}</option>}
        {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
      </PopupSelect>
      {choice && (
        <input value={draft} disabled={!acceptsModel} maxLength={200} aria-label={t("settings.projects.defaults.model", { label })}
          placeholder={t("settings.projects.defaults.model.placeholder")}
          onChange={(e) => setDraft(e.target.value)} onBlur={commitModel} onKeyDown={(e) => { if (e.key === "Enter") commitModel(); }}
          className="h-8 w-44 rounded-lg border border-gray-200 bg-white px-2.5 text-[13px] text-gray-900 focus:outline-none
            focus-visible:ring-2 focus-visible:ring-accent-500/40 disabled:opacity-50 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-white" />
      )}
    </div>
  );
}
