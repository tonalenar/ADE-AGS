import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAvailableAgents } from "@/features/agents/useAvailableAgents";
import { SHELL_AGENT_ID } from "@/features/tabs/types";
import { useConversations } from "@/features/chat/unified/useConversations";
import { normalizeProjectPath } from "@/features/chat/chatProjectPrefs";
import {
  forgetChatProjectIdentity,
  setChatProjectIdentity,
  useChatProjectIdentityList,
  type ChatProjectIdentity,
} from "@/features/chat/chatProjectIdentity";
import {
  clearProjectChatAgentPolicy,
  getProjectChatAgentPolicy,
  saveProjectChatAgentPolicy,
} from "@/features/chat/projectChatPolicy";
import { moveInOrder, orderProjects, PROJECT_ORDER_MODES, type ProjectOrderMode } from "@/features/chat/sidebar/projectOrder";
import {
  forgetProjectOrder,
  saveManualProjectOrder,
  saveProjectOrderMode,
  useProjectOrderPrefs,
} from "@/features/chat/sidebar/projectOrderPrefs";
import { appConfirm } from "@/shared/ui/appConfirm";
import { PopupSelect } from "@/shared/ui/PopupSelect";
import { ChatSegmented, SettingsGroup, SettingsRow, SettingsSection, SettingsToggleRow } from "@/features/settings/SettingsSection";
import { buildProjectRows, iconValueOf, withAgentEnabled, type ProjectRow } from "@/features/settings/projectsSettingsModel";
import { useProjectScopeStore } from "@/features/settings/projectScope";
import { ProjectDefaultsSetting } from "@/features/settings/ProjectDefaultsSettings";
import {
  PROJECT_GROUPING_MODES,
  saveProjectGrouping,
  useProjectGrouping,
  type ProjectGroupingMode,
} from "@/features/chat/sidebar/projectGrouping";

/**
 * Configurações → Projetos (no grupo Código, como no T3 Code). Aplica os ajustes a um projeto escolhido, no
 * topo ("Aplicando configurações para …"): o nome, o ícone, a fixação, o arquivo, os agentes que ele usa e a
 * ordem na barra. Tudo é preferência deste aparelho, exceto a política de agentes, que já é gravada no banco.
 *
 * A página é montada em `SettingsPages.tsx` (ali ficam as âncoras da busca). Os blocos saem daqui.
 */

/** As linhas de projeto na ordem da barra (a mesma que o usuário escolheu), com os dados de conversa e de rótulo. */
function useOrderedProjects(): { ordered: ProjectRow[]; mode: ProjectOrderMode } {
  const conversations = useConversations();
  const identities = useChatProjectIdentityList();
  const prefs = useProjectOrderPrefs();
  const rows = useMemo(() => buildProjectRows({ conversations, identities }), [conversations, identities]);
  const ordered = useMemo(() => orderProjects(rows, prefs), [rows, prefs]);
  return { ordered, mode: prefs.mode };
}

/** "Aplicando configurações para …": o seletor de projeto. "Todos os projetos" é o padrão. */
export function ProjectScopeBar() {
  const { t } = useTranslation();
  const { ordered } = useOrderedProjects();
  const scope = useProjectScopeStore((s) => s.cwd);
  const setScope = useProjectScopeStore((s) => s.setCwd);
  const selectedKey = scope ? normalizeProjectPath(scope) : "";
  return (
    <div className="flex items-center gap-2 text-[13px] text-gray-500 dark:text-white/50">
      <span>{t("settings.projects.applyingFor")}</span>
      <PopupSelect aria-label={t("settings.projects.applyingFor")} value={selectedKey} onChange={(e) => setScope(e.target.value || null)}>
        <option value="">{t("settings.projects.allProjects")}</option>
        {ordered.map((row) => <option key={row.key} value={row.key}>{row.name}</option>)}
      </PopupSelect>
    </div>
  );
}

/** A ordem da barra: último pedido (o padrão), criado em, ou manual. */
export function ProjectOrderSetting() {
  const { t } = useTranslation();
  const prefs = useProjectOrderPrefs();
  return (
    <SettingsSection title={t("settings.projects.order.title")} description={t("settings.projects.order.desc")}>
      <SettingsGroup>
        <SettingsRow label={t("settings.projects.order.title")} hint={t(`settings.projects.order.hint.${prefs.mode}`)}>
          <ChatSegmented<ProjectOrderMode>
            label={t("settings.projects.order.title")}
            value={prefs.mode}
            onChange={(mode) => saveProjectOrderMode(mode)}
            options={PROJECT_ORDER_MODES.map((mode) => ({ value: mode, label: t(`settings.projects.order.${mode}`) }))}
          />
        </SettingsRow>
        <ProjectGroupingRow />
      </SettingsGroup>
    </SettingsSection>
  );
}

/** Como a barra junta os checkouts do mesmo repositório: uma seção por pasta (como era) ou uma por repositório. */
function ProjectGroupingRow() {
  const { t } = useTranslation();
  const mode = useProjectGrouping();
  return (
    <SettingsRow label={t("settings.projects.grouping.title")} hint={t(`settings.projects.grouping.hint.${mode}`)}>
      <ChatSegmented<ProjectGroupingMode>
        label={t("settings.projects.grouping.title")}
        value={mode}
        onChange={(next) => saveProjectGrouping(next)}
        options={PROJECT_GROUPING_MODES.map((option) => ({ value: option, label: t(`settings.projects.grouping.${option}`) }))}
      />
    </SettingsRow>
  );
}

/** A lista de projetos: escolher um abre os ajustes dele; fixar, arquivar e (na ordem manual) subir ou descer. */
export function ProjectListSetting() {
  const { t } = useTranslation();
  const { ordered, mode } = useOrderedProjects();
  const scope = useProjectScopeStore((s) => s.cwd);
  const setScope = useProjectScopeStore((s) => s.setCwd);
  const selectedKey = scope ? normalizeProjectPath(scope) : null;
  const keys = useMemo(() => ordered.map((row) => row.key), [ordered]);
  return (
    <SettingsSection title={t("settings.projects.list.title")}>
      {ordered.length === 0 ? (
        <SettingsGroup>
          <p className="m-0 px-4 py-3.5 text-[13px] text-gray-500 dark:text-white/50">{t("settings.projects.empty")}</p>
        </SettingsGroup>
      ) : (
        <SettingsGroup>
          {ordered.map((row, index) => (
            <ProjectListRow key={row.key} row={row} index={index} keys={keys} manual={mode === "manual"}
              selected={row.key === selectedKey} onSelect={() => setScope(row.key)} />
          ))}
        </SettingsGroup>
      )}
    </SettingsSection>
  );
}

/**
 * Os ajustes do projeto escolhido. Sem escolha, mostra só a dica para escolher um na lista: o bloco fica sempre
 * no lugar, para a busca (e o atalho do composer) ter onde rolar.
 */
export function ProjectDetailSettings() {
  const { t } = useTranslation();
  const { ordered } = useOrderedProjects();
  const scope = useProjectScopeStore((s) => s.cwd);
  const setScope = useProjectScopeStore((s) => s.setCwd);
  const selected = scope ? ordered.find((row) => row.key === normalizeProjectPath(scope)) ?? null : null;
  if (!selected) {
    return (
      <SettingsSection title={t("settings.projects.detail.none.title")}>
        <SettingsGroup>
          <p className="m-0 px-4 py-3.5 text-[13px] text-gray-500 dark:text-white/50">{t("settings.projects.detail.none")}</p>
        </SettingsGroup>
      </SettingsSection>
    );
  }
  return <ProjectDetail key={selected.key} row={selected} onForgotten={() => setScope(null)} />;
}

/** Uma linha da lista: o nome, a pasta e as ações de fixar, arquivar e (na ordem manual) subir ou descer. */
function ProjectListRow({ row, index, keys, manual, selected, onSelect }: {
  row: ProjectRow;
  index: number;
  keys: readonly string[];
  manual: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const moveTo = (delta: -1 | 1) => saveManualProjectOrder(moveInOrder(keys, row.key, delta));
  return (
    <div className={`flex items-center gap-3 px-4 py-3 ${selected ? "bg-gray-50 dark:bg-white/[0.04]" : ""}`}>
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left">
        <span className="flex items-center gap-2 text-[14px] font-medium text-gray-900 dark:text-white">
          <span className="truncate">{row.name}</span>
          {row.pinned && <Badge>{t("settings.projects.badge.pinned")}</Badge>}
          {row.archived && <Badge>{t("settings.projects.badge.archived")}</Badge>}
        </span>
        <span className="max-w-full truncate font-mono text-[11.5px] text-gray-500 dark:text-white/50">{row.cwd}</span>
      </button>
      <span className="shrink-0 text-[12px] text-gray-400 dark:text-white/40">
        {t("settings.projects.conversations", { count: row.conversations })}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        {manual && (
          <>
            <SmallButton disabled={index === 0} onClick={() => moveTo(-1)} label={t("settings.projects.moveUp")} />
            <SmallButton disabled={index === keys.length - 1} onClick={() => moveTo(1)} label={t("settings.projects.moveDown")} />
          </>
        )}
        <SmallButton onClick={() => setChatProjectIdentity(row.cwd, { known: true, pinned: !row.pinned })}
          label={row.pinned ? t("settings.projects.unpin") : t("settings.projects.pin")} />
        <SmallButton onClick={() => setChatProjectIdentity(row.cwd, { known: true, archived: !row.archived })}
          label={row.archived ? t("settings.projects.unarchive") : t("settings.projects.archive")} />
      </div>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="rounded bg-gray-100 px-1.5 py-px text-[11px] font-normal text-gray-500 dark:bg-white/[0.08] dark:text-white/60">{children}</span>;
}

function SmallButton({ label, onClick, disabled = false }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className="h-6 rounded-md px-2 text-[12px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40
        dark:text-white/60 dark:hover:bg-white/[0.08]">
      {label}
    </button>
  );
}

/** O que muda só no projeto escolhido: nome, ícone, agentes e a remoção da personalização. */
function ProjectDetail({ row, onForgotten }: { row: ProjectRow; onForgotten: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <ProjectNameSetting row={row} />
      <ProjectIconSetting row={row} />
      <ProjectAgentsSetting row={row} />
      <ProjectDefaultsSetting cwd={row.cwd} />
      <SettingsGroup>
        <SettingsRow label={t("settings.projects.remove")} hint={t("settings.projects.remove.hint")}>
          <SmallButton label={t("settings.projects.remove")} onClick={async () => {
            const ok = await appConfirm({
              title: t("settings.projects.remove.title"),
              lead: t("settings.projects.remove.lead"),
              note: t("settings.projects.remove.note"),
              confirmLabel: t("settings.projects.remove"),
              cancelLabel: t("btn.cancel"),
              tone: "danger",
            });
            if (!ok) return;
            forgetChatProjectIdentity(row.cwd);
            forgetProjectOrder(row.cwd);
            onForgotten();
          }} />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

function ProjectNameSetting({ row }: { row: ProjectRow }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(row.name);
  useEffect(() => setDraft(row.name), [row.name]);
  const save = () => {
    const name = draft.trim();
    setChatProjectIdentity(row.cwd, { known: true, name: name || null });
  };
  return (
    <SettingsSection title={t("settings.projects.name")} description={t("settings.projects.name.hint")}>
      <SettingsGroup>
        <div className="flex items-center gap-2 px-4 py-3.5">
          <input value={draft} maxLength={160} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); }}
            aria-label={t("settings.projects.name")}
            className="h-8 min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2.5 text-[13px] text-gray-900 focus:outline-none
              focus-visible:ring-2 focus-visible:ring-accent-500/40 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-white" />
          <SmallButton label={t("settings.projects.name.save")} onClick={save} disabled={draft.trim() === row.name} />
        </div>
      </SettingsGroup>
    </SettingsSection>
  );
}

function ProjectIconSetting({ row }: { row: ProjectRow }) {
  const { t } = useTranslation();
  type IconKind = "auto" | "monogram" | "emoji" | "image";
  const [kind, setKind] = useState<IconKind>(row.icon ? row.icon.kind : "auto");
  const [value, setValue] = useState(iconValueOf(row.icon) ?? "");
  useEffect(() => {
    setKind(row.icon ? row.icon.kind : "auto");
    setValue(iconValueOf(row.icon) ?? "");
  }, [row.icon]);
  const save = () => {
    // Uma imagem não se edita aqui (não há envio de arquivo nesta tela): ela sai só se a pessoa escolher outro tipo.
    if (kind === "image") return;
    const icon: ChatProjectIdentity["icon"] = kind === "auto" || !value.trim() ? null : { kind, value: value.trim() };
    setChatProjectIdentity(row.cwd, { known: true, icon });
  };
  return (
    <SettingsSection title={t("settings.projects.icon")} description={t("settings.projects.icon.hint")}>
      <SettingsGroup>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3.5">
          <ChatSegmented<IconKind>
            label={t("settings.projects.icon")}
            value={kind}
            onChange={(next) => { setKind(next); if (next === "auto") setValue(""); }}
            options={[
              { value: "auto", label: t("settings.projects.icon.auto") },
              { value: "monogram", label: t("settings.projects.icon.monogram") },
              { value: "emoji", label: t("settings.projects.icon.emoji") },
              ...(row.icon?.kind === "image" ? [{ value: "image" as const, label: t("settings.projects.icon.image") }] : []),
            ]}
          />
          {(kind === "monogram" || kind === "emoji") && (
            <input value={value} maxLength={kind === "emoji" ? 16 : 4} onChange={(e) => setValue(e.target.value)} placeholder={t("settings.projects.icon.placeholder")}
              aria-label={t("settings.projects.icon")}
              className="h-8 w-28 rounded-lg border border-gray-200 bg-white px-2.5 text-[13px] text-gray-900 focus:outline-none
                focus-visible:ring-2 focus-visible:ring-accent-500/40 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-white" />
          )}
          <SmallButton label={t("settings.projects.icon.save")} onClick={save} disabled={kind === "image"} />
        </div>
      </SettingsGroup>
    </SettingsSection>
  );
}

/**
 * Os agentes que este projeto usa: o que está desligado some dos seletores dele. Usa a mesma política gravada
 * no banco que o seletor de agentes da conversa nova lê. Não deixa desligar todos.
 */
function ProjectAgentsSetting({ row }: { row: ProjectRow }) {
  const { t } = useTranslation();
  const available = useAvailableAgents({ includeLocalAcp: true });
  const agents = useMemo(() => available.filter((a) => a.id !== SHELL_AGENT_ID), [available]);
  const [disabled, setDisabled] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDisabled(null);
    getProjectChatAgentPolicy(row.cwd)
      .then((policy) => {
        if (alive) setDisabled(policy?.disabledAgentIds ?? []);
      })
      .catch(() => {
        if (alive) setError(t("settings.projects.agents.loadError"));
      });
    return () => {
      alive = false;
    };
  }, [row.cwd, t]);

  const toggle = async (agentId: string, enabled: boolean) => {
    if (!disabled) return;
    const next = withAgentEnabled(disabled, agentId, enabled);
    if (agents.every((agent) => next.includes(agent.id))) {
      setError(t("settings.projects.agents.lastOne"));
      return;
    }
    setError(null);
    try {
      if (next.length === 0) {
        await clearProjectChatAgentPolicy(row.cwd);
        setDisabled([]);
      } else {
        const saved = await saveProjectChatAgentPolicy(row.cwd, next);
        setDisabled(saved.disabledAgentIds);
      }
    } catch {
      setError(t("settings.projects.agents.saveError"));
    }
  };

  return (
    <SettingsSection title={t("settings.projects.agents")} description={t("settings.projects.agents.desc")}>
      <SettingsGroup>
        {disabled === null && !error && <p className="m-0 px-4 py-3.5 text-[13px] text-gray-500 dark:text-white/50">{t("settings.projects.agents.loading")}</p>}
        {agents.map((agent) => (
          <SettingsToggleRow key={agent.id} label={agent.label} checked={disabled ? !disabled.includes(agent.id) : true}
            disabled={disabled === null} onChange={(enabled) => void toggle(agent.id, enabled)} />
        ))}
        {error && <p className="m-0 px-4 py-2 text-[12.5px] text-red-600 dark:text-red-400">{error}</p>}
      </SettingsGroup>
    </SettingsSection>
  );
}
