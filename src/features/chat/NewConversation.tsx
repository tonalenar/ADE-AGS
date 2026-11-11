import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { homeDir } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { useAvailableAgents } from "@/features/agents/useAvailableAgents";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID, type AgentInfo } from "@/features/tabs/types";
import { baseName } from "@/features/workspaces/workspaceTree";

import { AgentModelPicker } from "./AgentModelPicker";
import { ProjectBadge } from "./ChatProjectBadge";
import type { Attachment } from "./attachments/attachModel";
import { threadMessage, tuiMessage } from "./attachments/send";
import { startConversation } from "./chatActions";
import { setComposing } from "./store";
import { BotIcon, BranchIcon, CheckIcon, ChevronDownIcon, FolderGitIcon, FolderIcon, SettingsIcon } from "./chatIcons";
import { accessModesFor, conversationTitle, extractSlashCommand, fastModeSupported, type ChatProject } from "./chatModel";
import { matrixProviderForAgent, useHarnessCapability } from "./harnessCapabilities";
import { chatNewWorktree } from "./ipc";
import { clearDraft, setDraftLead, useTeamDraft } from "./team/draftStore";
import { TeamTargetSwitch } from "./team/TeamComposer";
import { launchDraftTeam } from "./team/teamLaunch";
import { mentionSlug } from "./team/teamModel";
import { setComposerTarget, useTeamStore } from "./team/teamStore";
import { isLocalAcpAgent, isStructuredAgent } from "./structured/model";
import { startThread } from "./structured/store";
import { openCompareDialog } from "@/features/compare/store";
import { loadChatPrefs, saveChatPrefs, type ChatPrefs } from "./chatPrefs";
import {
  clearChatProjectDefaults,
  inheritChatProjectField,
  loadChatProjectDefaults,
  loadChatProjectSettings,
  saveChatProjectDefaults,
  saveChatProjectField,
  type ChatProjectDefaultField,
  type ChatProjectDefaults,
  type ChatProjectPrefsSnapshot,
} from "./chatProjectPrefs";
import { chatProjectDefaultsEffective } from "./projectChatDefaults";
import { useProjectDefaultsVersion } from "./projectDefaultsStore";
import { clearProjectChatAgentPolicy, getProjectChatAgentPolicy, saveProjectChatAgentPolicy, type ProjectChatAgentPolicy } from "./projectChatPolicy";
import { loadOrMigrateChatThreadEnvMode, readT3WorkspacePrefs, resolveChatThreadEnvMode, resolveChatWorktreeSubmodules, type ChatThreadEnvMode, type ChatWorkspaceModeSource } from "./chatWorkspacePrefs";
import { showBotToast } from "@/shared/brand/botToastStore";
import { ChatComposer } from "./ChatComposer";
import { ComposerAssistMenu } from "./ComposerAssistMenu";
import { ProjectScriptsMenu } from "./ProjectScriptsMenu";
import { runProjectScriptsOnWorktreeCreate } from "./projectScriptAutomation";
import { registerProjectScriptWorktree } from "./projectScripts";
import { useColumnGutter } from "./ComposerColumn";
import { usePopover } from "./usePopover";
import { useAnchoredPopover } from "./anchoredPopover";
import type { MentionOption } from "./team/teamModel";

/** O agente que o composer sugere quando não há escolha lembrada. */
const PREFERRED_AGENT = "claude-code";

/** A chave do "para quem" do rascunho (o time ainda não tem orquestrador: ver `TeamTargetSwitch`). */
const DRAFT_KEY = "draft";
const EMPTY_DISABLED_AGENT_IDS: string[] = [];

/** A pasta escolhida pelo "Adicionar projeto" da sidebar chega por aqui. */
export function pickProjectFolder(title: string): Promise<string | null> {
  return openDialog({ directory: true, multiple: false, title }).then((p) => (typeof p === "string" && p ? p : null));
}

/**
 * A tela de conversa nova da prancheta 1: "O que vamos construir em <pasta>?", o composer no meio
 * e, embaixo, o workspace, a branch e as permissões. Enviar abre o agente escolhido nessa pasta.
 */
export function NewConversation({ projects, folder, onFolder }: {
  projects: ChatProject[];
  /** A pasta escolhida (vem da sidebar também). */
  folder: string | null;
  onFolder: (cwd: string) => void;
}) {
  const { t } = useTranslation();
  const available = useAvailableAgents({ includeLocalAcp: true });
  const agents = useMemo(() => available.filter((a) => a.id !== SHELL_AGENT_ID), [available]);
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const activeCwd = useTabsStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.cwd ?? null);
  const initialProjectCwd = folder ?? loadChatPrefs().cwd ?? activeCwd ?? projects[0]?.cwd ?? null;
  const [prefs, setPrefs] = useState<ChatPrefs>(() => {
    const saved = loadChatPrefs();
    const defaults = loadChatProjectDefaults(initialProjectCwd);
    return {
      ...saved,
      ...defaults,
      worktree: resolveChatThreadEnvMode({
        projectOverride: defaults?.worktree ?? null,
        machineOverride: loadOrMigrateChatThreadEnvMode(),
        t3Default: null,
        legacyDefault: false,
      }).worktree,
    };
  });
  const [projectDefaults, setProjectDefaults] = useState<Partial<ChatProjectDefaults> | null>(() => {
    return loadChatProjectDefaults(initialProjectCwd);
  });
  const [projectSettings, setProjectSettings] = useState<ChatProjectPrefsSnapshot>(() => {
    return loadChatProjectSettings(initialProjectCwd);
  });
  const [projectSettingsCwd, setProjectSettingsCwd] = useState<string | null>(initialProjectCwd);
  const [machineWorkspaceMode, setMachineWorkspaceMode] = useState<ChatThreadEnvMode | null>(() => loadOrMigrateChatThreadEnvMode());
  const [t3WorkspaceMode, setT3WorkspaceMode] = useState<ChatThreadEnvMode | null>(null);
  const [t3WorktreeSubmodules, setT3WorktreeSubmodules] = useState<ChatPrefs["worktreeSubmodules"]>(null);
  const [conversationWorkspaceMode, setConversationWorkspaceMode] = useState<boolean | null>(null);
  const [workspaceSettingsLoadedCwd, setWorkspaceSettingsLoadedCwd] = useState<string | null>(null);
  const [workspaceSettingsError, setWorkspaceSettingsError] = useState("");
  const [error, setError] = useState("");
  const submitInFlight = useRef(false);
  const [projectAgentPolicy, setProjectAgentPolicy] = useState<ProjectChatAgentPolicy | null>(null);
  const [projectPolicyLoadedCwd, setProjectPolicyLoadedCwd] = useState<string | null>(null);
  const [projectPolicySaving, setProjectPolicySaving] = useState(false);
  const [projectPolicyError, setProjectPolicyError] = useState("");
  const [projectSettingsError, setProjectSettingsError] = useState(false);

  const update = (patch: Partial<ChatPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      return next;
    });
    // Persista só as opções alteradas: `prefs` inclui overrides efetivos do projeto.
    saveChatPrefs({ ...loadChatPrefs(), ...patch });
  };

  const cwd = folder ?? prefs.cwd ?? activeCwd ?? projects[0]?.cwd ?? null;
  // Muda quando os padrões do projeto mudam por fora do composer (a carga do banco e a página Projetos).
  const defaultsVersion = useProjectDefaultsVersion(cwd);
  const project: ChatProject | null = projects.find((p) => p.cwd === cwd) ?? (cwd ? { cwd, name: baseName(cwd), branch: null } : null);
  const inheritedWorkspaceMode = resolveChatThreadEnvMode({
    projectOverride: projectDefaults?.worktree ?? null,
    machineOverride: machineWorkspaceMode,
    t3Default: t3WorkspaceMode,
    legacyDefault: false,
  });
  const workspaceMode = conversationWorkspaceMode === null
    ? inheritedWorkspaceMode
    : { worktree: conversationWorkspaceMode, source: "conversation" as const };
  const worktreeSubmodules = resolveChatWorktreeSubmodules({
    projectOverride: projectDefaults?.worktreeSubmodules ?? null,
    machineOverride: loadChatPrefs().worktreeSubmodules,
    t3Default: t3WorktreeSubmodules,
  });
  const workspaceSettingsLoaded = workspaceSettingsLoadedCwd === cwd;
  const projectSettingsLoaded = projectSettingsCwd === cwd && workspaceSettingsLoaded;
  const policyCwd = useRef(cwd);
  useEffect(() => {
    let alive = true;
    policyCwd.current = cwd;
    setProjectPolicyLoadedCwd(null);
    setProjectPolicySaving(false);
    setProjectAgentPolicy(null);
    setProjectPolicyError("");
    if (!cwd) {
      setProjectPolicyLoadedCwd(null);
      return () => { alive = false; };
    }
    getProjectChatAgentPolicy(cwd)
      .then((policy) => { if (alive) setProjectAgentPolicy(policy); })
      .catch((cause: unknown) => { if (alive) setProjectPolicyError(String(cause)); })
      .finally(() => { if (alive) setProjectPolicyLoadedCwd(cwd); });
    return () => { alive = false; };
  }, [cwd]);
  const projectPolicyLoaded = projectPolicyLoadedCwd === cwd;
  const disabledAgentIds = projectAgentPolicy?.disabledAgentIds ?? EMPTY_DISABLED_AGENT_IDS;
  const projectAgents = useMemo(() => {
    const blocked = new Set(disabledAgentIds);
    return agents.filter((candidate) => !blocked.has(candidate.id));
  }, [agents, disabledAgentIds]);
  const workspaceSettingsCwd = useRef(cwd);
  useEffect(() => {
    const sameCwd = workspaceSettingsCwd.current === cwd;
    workspaceSettingsCwd.current = cwd;
    let alive = true;
    setConversationWorkspaceMode(null);
    setWorkspaceSettingsLoadedCwd(null);
    setT3WorkspaceMode(null);
    setT3WorktreeSubmodules(null);
    setWorkspaceSettingsError("");
    const defaults = loadChatProjectDefaults(cwd);
    setProjectDefaults(defaults);
    const settings = loadChatProjectSettings(cwd);
    setProjectSettings(settings);
    setProjectSettingsCwd(cwd);
    setProjectSettingsError(settings.storageError);
    const saved = loadChatPrefs();
    const machineMode = loadOrMigrateChatThreadEnvMode();
    setMachineWorkspaceMode(machineMode);
    setPrefs((previous) => ({ ...(sameCwd ? previous : saved), ...defaults, cwd: cwd ?? saved.cwd }));
    if (!cwd) {
      setWorkspaceSettingsLoadedCwd(null);
      return () => { alive = false; };
    }
    const needsT3Workspace = defaults?.worktree == null && machineMode == null;
    const needsT3Submodules = defaults?.worktreeSubmodules == null && saved.worktreeSubmodules == null;
    // Só lê o arquivo quando ele ainda pode decidir algum valor herdado.
    if (!needsT3Workspace && !needsT3Submodules) {
      setWorkspaceSettingsLoadedCwd(cwd);
      return () => { alive = false; };
    }
    readT3WorkspacePrefs(cwd)
      .then((t3Prefs) => {
        if (!alive) return;
        if (needsT3Workspace) setT3WorkspaceMode(t3Prefs.threadEnvMode);
        if (needsT3Submodules) setT3WorktreeSubmodules(t3Prefs.worktreeSubmodules);
      })
      .catch((cause: unknown) => { if (alive) setWorkspaceSettingsError(String(cause)); })
      .finally(() => { if (alive) setWorkspaceSettingsLoadedCwd(cwd); });
    return () => { alive = false; };
  }, [cwd, defaultsVersion]);
  // O modelo reserva do projeto: se o agente principal está sem limite de uso, a conversa nova já abre no reserva.
  // É só o ponto de partida desta tela (não grava nada); trocar de agente depois vale.
  const [fallbackNotice, setFallbackNotice] = useState<{ agent: string; until: number | null } | null>(null);
  const accountForFallback = prefs.accountId;
  useEffect(() => {
    let alive = true;
    setFallbackNotice(null);
    if (!cwd) return () => { alive = false; };
    chatProjectDefaultsEffective(cwd, accountForFallback)
      .then(({ selection }) => {
        if (!alive || !selection?.usedFallback) return;
        const chosen = agents.find((candidate) => candidate.id === selection.agentId);
        if (!chosen) return;
        setPrefs((previous) => ({ ...previous, agentId: selection.agentId, model: selection.model }));
        setFallbackNotice({ agent: chosen.label, until: selection.limitedUntil });
      })
      .catch(() => undefined);
    return () => { alive = false; };
    // `agents` entra só para esperar o catálogo carregar; mudar de agente à mão não refaz a escolha.
  }, [cwd, defaultsVersion, accountForFallback, agents.length]);
  const agent = projectAgents.find((a) => a.id === prefs.agentId) ?? projectAgents.find((a) => a.id === PREFERRED_AGENT) ?? projectAgents[0] ?? null;
  const mine = !!agent && prefs.agentId === agent.id;
  // Por protocolo (sem TUI) o agente tem os acessos e o Plano do motor dele; na TUI, os flags dela.
  const viaProtocol = !!agent && (isLocalAcpAgent(agent.id) || (prefs.structured && isStructuredAgent(agent.id)));
  const planCapability = useHarnessCapability(viaProtocol ? "chat" : "tui", matrixProviderForAgent(agent?.id), "plan");
  const hasPlan = planCapability.support === "supported";
  const modes = agent ? accessModesFor(agent.id, viaProtocol) : ["ask" as const];
  const access = modes.includes(prefs.access) ? prefs.access : modes.includes("safe") ? "safe" : "ask";
  const plan = !!agent && hasPlan && prefs.plan;
  const projectDefaultChoices: ChatProjectDefaults = {
    agentId: agent?.id ?? null,
    model: mine && !isLocalAcpAgent(agent?.id ?? "") ? prefs.model : null,
    effort: mine && !isLocalAcpAgent(agent?.id ?? "") ? prefs.effort : null,
    access,
    plan,
    fastMode: fastModeSupported(agent?.id) && !viaProtocol && prefs.fastMode,
    worktree: workspaceMode.worktree,
    worktreeSubmodules: worktreeSubmodules.mode,
    structured: isLocalAcpAgent(agent?.id ?? "") || prefs.structured,
  };

  const saveProjectDefaults = () => {
    if (!project || !projectSettingsLoaded || projectSettings.storageError) return;
    if (!saveChatProjectDefaults(project.cwd, { ...prefs, ...projectDefaultChoices })) {
      setProjectSettingsError(true);
      return;
    }
    setProjectSettings(loadChatProjectSettings(project.cwd));
    setProjectDefaults(loadChatProjectDefaults(project.cwd));
    setProjectSettingsError(false);
  };
  const removeProjectDefaults = () => {
    if (!project || !projectSettingsLoaded || projectSettings.storageError) return;
    if (!clearChatProjectDefaults(project.cwd)) {
      setProjectSettingsError(true);
      return;
    }
    setProjectDefaults(null);
    setProjectSettings(loadChatProjectSettings(project.cwd));
    setProjectSettingsError(false);
  };

  const saveProjectField = (field: ChatProjectDefaultField) => {
    if (!project || !projectSettingsLoaded || projectSettings.storageError || !saveChatProjectField(project.cwd, field, projectDefaultChoices[field])) {
      setProjectSettingsError(true);
      return;
    }
    setProjectSettings(loadChatProjectSettings(project.cwd));
    setProjectDefaults(loadChatProjectDefaults(project.cwd));
    setProjectSettingsError(false);
  };

  const resetProjectField = (field: ChatProjectDefaultField) => {
    if (!project || !projectSettingsLoaded || projectSettings.storageError || !inheritChatProjectField(project.cwd, field)) {
      setProjectSettingsError(true);
      return;
    }
    if (field === "worktree") {
      setConversationWorkspaceMode(null);
      const targetCwd = project.cwd;
      const machineMode = loadOrMigrateChatThreadEnvMode();
      setMachineWorkspaceMode(machineMode);
      setT3WorkspaceMode(null);
      setWorkspaceSettingsError("");
      if (machineMode !== null) {
        setWorkspaceSettingsLoadedCwd(targetCwd);
      } else {
        setWorkspaceSettingsLoadedCwd(null);
        readT3WorkspacePrefs(targetCwd)
          .then((t3Prefs) => {
            if (workspaceSettingsCwd.current === targetCwd) {
              setT3WorkspaceMode(t3Prefs.threadEnvMode);
              setT3WorktreeSubmodules(t3Prefs.worktreeSubmodules);
            }
          })
          .catch((cause: unknown) => {
            if (workspaceSettingsCwd.current === targetCwd) setWorkspaceSettingsError(String(cause));
          })
          .finally(() => {
            if (workspaceSettingsCwd.current === targetCwd) setWorkspaceSettingsLoadedCwd(targetCwd);
          });
      }
    } else {
      const machine = loadChatPrefs();
      switch (field) {
        case "agentId": setPrefs((previous) => ({ ...previous, agentId: machine.agentId })); break;
        case "model": setPrefs((previous) => ({ ...previous, model: machine.model })); break;
        case "effort": setPrefs((previous) => ({ ...previous, effort: machine.effort })); break;
        case "access": setPrefs((previous) => ({ ...previous, access: machine.access })); break;
        case "plan": setPrefs((previous) => ({ ...previous, plan: machine.plan })); break;
        case "fastMode": setPrefs((previous) => ({ ...previous, fastMode: machine.fastMode })); break;
        case "worktreeSubmodules": setPrefs((previous) => ({ ...previous, worktreeSubmodules: machine.worktreeSubmodules })); break;
        case "structured": setPrefs((previous) => ({ ...previous, structured: machine.structured })); break;
      }
      if (field === "worktreeSubmodules") {
        setT3WorktreeSubmodules(null);
        if (machine.worktreeSubmodules === null) {
          const targetCwd = project.cwd;
          setWorkspaceSettingsLoadedCwd(null);
          setWorkspaceSettingsError("");
          readT3WorkspacePrefs(targetCwd)
            .then((t3Prefs) => {
              if (workspaceSettingsCwd.current === targetCwd) setT3WorktreeSubmodules(t3Prefs.worktreeSubmodules);
            })
            .catch((cause: unknown) => {
              if (workspaceSettingsCwd.current === targetCwd) setWorkspaceSettingsError(String(cause));
            })
            .finally(() => {
              if (workspaceSettingsCwd.current === targetCwd) setWorkspaceSettingsLoadedCwd(targetCwd);
            });
        }
      }
    }
    setProjectSettings(loadChatProjectSettings(project.cwd));
    setProjectDefaults(loadChatProjectDefaults(project.cwd));
    setProjectSettingsError(false);
  };

  const changeWorkspaceMode = (mode: boolean | null) => {
    setConversationWorkspaceMode(mode);
  };

  const setProjectAgentEnabled = async (agentId: string, enabled: boolean) => {
    if (!project || !projectPolicyLoaded || projectPolicySaving) return;
    const targetCwd = project.cwd;
    const nextDisabled = new Set(disabledAgentIds);
    if (enabled) nextDisabled.delete(agentId);
    else nextDisabled.add(agentId);
    const ids = [...nextDisabled].sort();
    setProjectPolicySaving(true);
    setProjectPolicyError("");
    try {
      if (ids.length === 0) {
        await clearProjectChatAgentPolicy(targetCwd);
        if (policyCwd.current === targetCwd) setProjectAgentPolicy(null);
      } else {
        const saved = await saveProjectChatAgentPolicy(targetCwd, ids);
        if (policyCwd.current === targetCwd) setProjectAgentPolicy(saved);
      }
    } catch (cause) {
      if (policyCwd.current === targetCwd) {
        setProjectPolicyError(String(cause));
        try { setProjectAgentPolicy(await getProjectChatAgentPolicy(targetCwd)); } catch { /* Mantém a lista atual para permitir nova tentativa. */ }
      }
    } finally {
      if (policyCwd.current === targetCwd) setProjectPolicySaving(false);
    }
  };

  const removeProjectAgentPolicy = async () => {
    if (!project || !projectPolicyLoaded || projectPolicySaving) return;
    const targetCwd = project.cwd;
    setProjectPolicySaving(true);
    setProjectPolicyError("");
    try {
      await clearProjectChatAgentPolicy(targetCwd);
      if (policyCwd.current === targetCwd) setProjectAgentPolicy(null);
    } catch (cause) {
      if (policyCwd.current === targetCwd) setProjectPolicyError(String(cause));
    } finally {
      if (policyCwd.current === targetCwd) setProjectPolicySaving(false);
    }
  };

  // O time montado antes da conversa (painel Time): vive só enquanto esta tela existe.
  const draftMembers = useTeamDraft((s) => s.members);
  const draftTarget = useTeamStore((s) => s.targets[DRAFT_KEY] ?? "team");
  const leadCwd = project?.cwd ?? null;
  useEffect(() => { setDraftLead(agent && leadCwd ? { agentId: agent.id, label: agent.label, cwd: leadCwd } : null); }, [agent, leadCwd]);
  useEffect(() => () => { clearDraft(); setDraftLead(null); setComposerTarget(DRAFT_KEY, "team"); }, []);
  const withTeam = draftMembers.length > 0;
  const firstMember = draftMembers[0];
  const draftMentions = useMemo<MentionOption[]>(() => draftMembers.map((member) => ({
    ref: member.kind === "new" ? `draft:${member.id}` : member.conv.key,
    name: member.kind === "new" ? member.agent.label : member.conv.agentLabel,
    agentId: member.kind === "new" ? member.agent.id : member.conv.agentId,
    role: member.role,
  })), [draftMembers]);

  const choose = (path: string) => {
    onFolder(path);
    update({ cwd: path });
  };
  const browse = async () => {
    const picked = await pickProjectFolder(t("home.dialogTitle"));
    if (picked) choose(picked);
  };
  const withoutProject = async () => {
    const home = await homeDir().catch(() => null);
    if (home) choose(home);
  };

  /** `false` = não abriu: o texto fica na caixa. */
  const submit = async (prompt: string, attachments: Attachment[] = [], background = false): Promise<boolean> => {
    setError("");
    const planCommand = extractSlashCommand(prompt, "plan");
    if (planCommand.found && prompt.trim().toLowerCase() === "/plan" && attachments.length === 0) {
      if (!agent || !hasPlan) {
        setError(t("chat.plan.unsupported"));
        return false;
      }
      update({ plan: !prefs.plan });
      // `/plan` sozinho só alterna o padrão do rascunho; não cria uma conversa vazia.
      return true;
    }
    const launchPrompt = prompt;
    const launchPlan = plan;
    if (!project) { setError(t("chat.new.noFolder")); return false; }
    if (!projectPolicyLoaded || projectPolicySaving || !workspaceSettingsLoaded) return false;
    if (!agent) { setError(t("chat.agent.none")); return false; }
    if (submitInFlight.current) return false;
    submitInFlight.current = true;
    try {
      // A aba em segundo plano não deve roubar o foco da conversa anterior nem desmontar sua superfície.
      if (background) setComposing(true);
      // Num worktree novo o agente roda numa cópia do repo, na sua branch (ver `conversa.rs`).
      let cwd = project.cwd;
      if (workspaceMode.worktree) {
        const worktree = await chatNewWorktree(project.cwd, conversationTitle(launchPrompt) ?? project.name, agent.id, worktreeSubmodules.mode);
        cwd = worktree.cwd;
        registerProjectScriptWorktree(worktree.cwd, project.cwd);
        if (worktree.submodules === "failed") {
          showBotToast({ title: t("chat.workspace.submodules.title"), text: t("chat.workspace.submodules.failed"), tone: "warning", ms: 8000 });
        }
        const setupSucceeded = await runProjectScriptsOnWorktreeCreate(project.cwd, worktree.cwd);
        if (!setupSucceeded) {
          setError(t("chat.projectScripts.worktreeSetupFailed"));
          return false;
        }
      }
      if (withTeam) {
        // Com integrantes no rascunho: conversa, time e integrantes nascem juntos, ou nada fica (ver `launchTeam`).
        setComposing(true); // a tela não troca no meio da criação, nem na primeira conversa de todas
        const result = await launchDraftTeam({
          agent, cwd, workspaceId, title: conversationTitle(launchPrompt) ?? project.name, model: mine && !isLocalAcpAgent(agent?.id ?? "") ? prefs.model : null, effort: mine && !isLocalAcpAgent(agent?.id ?? "") ? prefs.effort : null,
          access, plan: launchPlan, fastMode: fastModeSupported(agent.id) && !viaProtocol && prefs.fastMode,
          accountId: mine && !isLocalAcpAgent(agent.id) ? prefs.accountId : null, account: mine && !isLocalAcpAgent(agent.id) ? prefs.accountId ?? undefined : undefined, viaProtocol,
        }, draftMembers, launchPrompt, draftTarget, attachments);
        if (!result.ok) {
          const left = result.leftovers.length > 0 ? ` ${t("chat.team.draft.leftovers", { items: result.leftovers.join("; ") })}` : "";
          setError(`${t("chat.team.draft.failed", { error: result.error })}${left}`);
          return false;
        }
        clearDraft();
        update({ cwd: project.cwd, agentId: agent.id });
        return true;
      }
      if (viaProtocol) {
        // No Claude o Plano é um modo de permissão: a conversa nasce nele e sai pelo pedido do agente.
        const sent = threadMessage(launchPrompt, attachments);
        await startThread({
          agentId: agent.id, cwd, workspaceId, title: conversationTitle(launchPrompt) ?? project.name,
          model: mine && !isLocalAcpAgent(agent?.id ?? "") ? prefs.model : null, effort: mine && !isLocalAcpAgent(agent?.id ?? "") ? prefs.effort : null, access: launchPlan ? "plan" : access,
          accountId: mine && !isLocalAcpAgent(agent?.id ?? "") ? prefs.accountId : null,
        }, sent.text, sent.images, background);
        update({ cwd: project.cwd, agentId: agent.id });
        return true;
      }
      await startConversation({
        cwd,
        agent,
        prompt: tuiMessage(agent.id, launchPrompt, attachments),
        title: conversationTitle(launchPrompt) ?? project.name,
        model: mine ? prefs.model : null,
        effort: mine ? prefs.effort : null,
        account: mine ? prefs.accountId ?? undefined : undefined,
        access,
        plan: launchPlan,
        fastMode: fastModeSupported(agent.id) && prefs.fastMode,
        background,
      });
      update({ cwd: project.cwd, agentId: agent.id });
      return true;
    } catch (e) {
      setError(t("chat.new.failed", { error: String(e) }));
      return false;
    } finally {
      submitInFlight.current = false;
    }
  };

  const column = useColumnGutter<HTMLElement>();
  return (
    <section ref={column.ref} style={column.style} className="flex-1 min-h-0 flex flex-col items-center justify-center pb-20">
      <h1 className="m-0 text-center text-[26px] sm:text-[30px] leading-tight font-normal tracking-tight text-gray-900 dark:text-white">
        {project ? (
          <>
            {t("chat.new.headline")}{" "}
            <ProjectPicker project={project} projects={projects} onPick={choose} onBrowse={browse} />?
          </>
        ) : t("chat.new.pickFolderHeadline")}
      </h1>
      <p className="mt-2 mb-[18px] text-chat-ui">
        <button type="button" onClick={() => { void (project ? withoutProject() : browse()); }}
          className="text-gray-500 dark:text-white/45 hover:text-gray-800 dark:hover:text-white/80">
          {project ? t("chat.new.withoutProject") : t("chat.new.pickFolder")}
        </button>
      </p>

      <div className="w-full max-w-[736px]">
        <ChatComposer autoFocus cwd={project?.cwd ?? null} composerTarget="new-conversation" placeholder={!withTeam ? t("chat.composer.placeholder")
            : draftTarget === "lead" ? t("chat.team.placeholderLead")
            : t("chat.team.placeholder", { agent: firstMember ? mentionSlug(firstMember.kind === "new" ? firstMember.agent.id : firstMember.conv.agentId) : "codex" })} disabled={!project || !agent || !projectPolicyLoaded || projectPolicySaving || !workspaceSettingsLoaded}
          onSubmit={submit}
          onBackgroundSubmit={!withTeam ? (prompt, attachments) => submit(prompt, attachments, true) : undefined}
          addon={(context) => <ComposerAssistMenu cwd={project?.cwd ?? null} agentId={agent?.id ?? null}
            teamOptions={withTeam ? draftMentions : undefined}
            onPlan={agent && hasPlan ? () => update({ plan: !prefs.plan }) : undefined}
            context={context} />}
          controls={({ text, attachments, hasQuotes }) => (
            <>
              {withTeam && <TeamTargetSwitch orchestrator={DRAFT_KEY} />}
              <AgentModelPicker agents={projectAgents} showAccount={!isLocalAcpAgent(agent?.id ?? "")} disabled={!projectPolicyLoaded || projectPolicySaving}
                value={{ agentId: agent?.id ?? null, model: mine && !isLocalAcpAgent(agent?.id ?? "") ? prefs.model : null, effort: mine && !isLocalAcpAgent(agent?.id ?? "") ? prefs.effort : null, account: mine && !isLocalAcpAgent(agent?.id ?? "") ? prefs.accountId : null }}
                permission={{ value: access, modes, onChange: (next) => update({ access: next, plan: false }) }}
                speed={!viaProtocol ? { fast: prefs.fastMode, onChange: (fastMode) => update({ fastMode }) } : undefined}
                onCompare={(picks) => openCompareDialog(project?.cwd ?? "", { prompt: text, picks, attachments })}
                compareDisabled={hasQuotes}
                onChange={(v) => update({ agentId: v.agentId, model: v.model, effort: v.effort, accountId: v.account, fastMode: fastModeSupported(v.agentId) ? prefs.fastMode : false })} />
              {agent && hasPlan && (
                <button type="button" onClick={() => update({ plan: !prefs.plan })} aria-pressed={plan}
                  title={plan ? t("chat.plan.onHint") : t("chat.plan.offHint")}
                  className="flex items-center gap-1.5 h-7 px-2 rounded-lg whitespace-nowrap text-chat-ui font-medium text-gray-900/85 dark:text-white/85 hover:bg-gray-100 dark:hover:bg-white/[0.07]">
                  <BotIcon className="w-4 h-4 text-gray-500 dark:text-white/45" />
                  {plan ? t("chat.plan.plan") : t("chat.plan.build")}
                </button>
              )}
            </>
          )} />
        {agent && isLocalAcpAgent(agent.id) && (
          <p className="mx-2 mt-2 mb-0 text-[11px] leading-4 text-amber-700 dark:text-amber-300">{t("chat.localAcp.permissionWarning")}</p>
        )}
        <ContextStrip branch={project?.branch ?? null}
          workspace={project ? <span className="flex items-center gap-1">
            <ProjectDefaultsMenu
              key={project.cwd}
              agents={agents}
              hasDefaults={projectSettings.hasDefaults}
              projectFields={projectSettings.projectFields}
              currentDefaults={projectDefaultChoices}
              storedDefaults={projectDefaults}
              disabled={!projectSettingsLoaded}
              storageError={projectSettings.storageError}
              onSave={saveProjectDefaults}
              onSaveField={saveProjectField}
              onInheritField={resetProjectField}
              onClear={removeProjectDefaults}
              disabledAgentIds={disabledAgentIds}
              hasAgentPolicy={!!projectAgentPolicy}
              policyLoaded={projectPolicyLoaded}
              policySaving={projectPolicySaving}
              onAgentEnabledChange={setProjectAgentEnabled}
              onClearAgentPolicy={removeProjectAgentPolicy}
            />
            <ProjectScriptsMenu key={project.cwd} cwd={project.cwd} />
            <WorkspaceMenu worktree={workspaceMode.worktree} source={workspaceMode.source}
              inheritedWorktree={inheritedWorkspaceMode.worktree} conversationOverride={conversationWorkspaceMode}
              disabled={!workspaceSettingsLoaded} onChange={changeWorkspaceMode} />
          </span> : undefined} />
        {error && <p role="alert" className="mt-3 px-2 text-chat-note text-red-600 dark:text-red-400">{error}</p>}
        {workspaceSettingsError && <p role="alert" className="mt-3 px-2 text-chat-note text-amber-700 dark:text-amber-300">{t("chat.workspace.configError")}</p>}
        {projectSettingsError && <p role="alert" className="mt-3 px-2 text-chat-note text-red-600 dark:text-red-400">{t(projectSettings.storageError ? "chat.projectDefaults.storageUnreadable" : "chat.projectDefaults.storageError")}</p>}
        {projectPolicyError && <p role="alert" className="mt-3 px-2 text-chat-note text-red-600 dark:text-red-400">{t("chat.projectDefaults.policyError", { error: projectPolicyError })}</p>}
        {fallbackNotice && prefs.agentId === agents.find((candidate) => candidate.label === fallbackNotice.agent)?.id && (
          <p role="status" className="mt-3 px-2 text-chat-note text-amber-700 dark:text-amber-300">
            {fallbackNotice.until
              ? t("chat.projectDefaults.fallbackActive", { agent: fallbackNotice.agent, time: new Date(fallbackNotice.until * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })
              : t("chat.projectDefaults.fallbackActiveNoTime", { agent: fallbackNotice.agent })}
          </p>
        )}
        {projectPolicyLoaded && agents.length > 0 && projectAgents.length === 0 && <p role="status" className="mt-3 px-2 text-chat-note text-amber-700 dark:text-amber-300">{t("chat.projectDefaults.noEnabledAgents")}</p>}
      </div>
    </section>
  );
}

function ProjectDefaultsMenu({ agents, hasDefaults, projectFields, currentDefaults, storedDefaults, disabled, storageError, onSave, onSaveField, onInheritField, onClear, disabledAgentIds, hasAgentPolicy, policyLoaded, policySaving, onAgentEnabledChange, onClearAgentPolicy }: {
  agents: AgentInfo[];
  hasDefaults: boolean;
  projectFields: ChatProjectDefaultField[];
  currentDefaults: ChatProjectDefaults;
  storedDefaults: Partial<ChatProjectDefaults> | null;
  disabled: boolean;
  storageError: boolean;
  onSave: () => void;
  onSaveField: (field: ChatProjectDefaultField) => void;
  onInheritField: (field: ChatProjectDefaultField) => void;
  onClear: () => void;
  disabledAgentIds: string[];
  hasAgentPolicy: boolean;
  policyLoaded: boolean;
  policySaving: boolean;
  onAgentEnabledChange: (agentId: string, enabled: boolean) => void;
  onClearAgentPolicy: () => void;
}) {
  const { t } = useTranslation();
  const { open, setOpen, close, triggerRef, panelRef, style } = useAnchoredPopover();
  const currentAgentLabel = agents.find((candidate) => candidate.id === currentDefaults.agentId)?.label ?? currentDefaults.agentId;
  const rows: Array<{ field: ChatProjectDefaultField; label: string; value: string }> = [
    { field: "agentId", label: t("chat.projectDefaults.field.agent"), value: currentAgentLabel || t("chat.projectDefaults.value.automatic") },
    { field: "model", label: t("chat.projectDefaults.field.model"), value: currentDefaults.model ?? t("chat.projectDefaults.value.automatic") },
    { field: "effort", label: t("chat.projectDefaults.field.effort"), value: currentDefaults.effort ?? t("chat.projectDefaults.value.automatic") },
    { field: "access", label: t("chat.projectDefaults.field.access"), value: t(`chat.access.${currentDefaults.access}`) },
    { field: "plan", label: t("chat.projectDefaults.field.plan"), value: t(currentDefaults.plan ? "chat.plan.plan" : "chat.plan.build") },
    { field: "fastMode", label: t("chat.projectDefaults.field.speed"), value: t(currentDefaults.fastMode ? "chat.projectDefaults.value.fast" : "chat.projectDefaults.value.standard") },
    { field: "structured", label: t("chat.projectDefaults.field.conversationMode"), value: t(currentDefaults.structured ? "chat.projectDefaults.value.structured" : "chat.projectDefaults.value.terminal") },
    { field: "worktree", label: t("chat.projectDefaults.field.workspace"), value: t(currentDefaults.worktree ? "chat.workspace.newWorktree" : "chat.new.currentCheckout") },
    { field: "worktreeSubmodules", label: t("chat.projectDefaults.field.worktreeSubmodules"), value: t(`chat.workspace.submodules.${currentDefaults.worktreeSubmodules === "top-level" ? "topLevel" : currentDefaults.worktreeSubmodules}`) },
  ];
  return (
    <span className="relative">
      <button ref={triggerRef} type="button" aria-label={t("chat.projectDefaults.open")} aria-haspopup="dialog" aria-expanded={open} disabled={disabled}
        title={t("chat.projectDefaults.open")} onClick={() => setOpen(!open)}
        className={`flex items-center justify-center w-7 h-7 rounded-lg hover:bg-gray-100 dark:hover:bg-white/[0.07] disabled:opacity-45 ${hasDefaults || hasAgentPolicy ? "text-accent-600 dark:text-accent-400" : "text-gray-500 dark:text-white/45"}`}>
        <SettingsIcon className="w-3.5 h-3.5" />
      </button>
      {open && createPortal(<section ref={panelRef} popover="manual" role="dialog" aria-label={t("chat.projectDefaults.open")} tabIndex={-1} style={style}
        className="w-[min(24rem,calc(100vw-1.5rem))] overflow-y-auto overscroll-contain rounded-xl border border-gray-200 bg-white p-2 shadow-xl dark:border-white/10 dark:bg-surface-raised">
        <header className="px-2 pb-2">
          <h2 className="m-0 text-[13px] font-semibold text-gray-900 dark:text-white">{t("chat.projectDefaults.open")}</h2>
          <p className="mt-1 mb-0 text-[10px] leading-4 text-gray-500 dark:text-white/50">{t("chat.projectDefaults.description")}</p>
        </header>
        {storageError && <p role="alert" className="m-0 px-2 pb-1.5 text-[10px] leading-4 text-amber-700 dark:text-amber-300">{t("chat.projectDefaults.storageUnreadable")}</p>}
        <div className="my-1 border-t border-gray-200 dark:border-white/10" />
        <p className="m-0 px-2 pt-1.5 text-[11px] font-medium text-gray-700 dark:text-white/75">{t("chat.projectDefaults.allowedAgents")}</p>
        <p className="m-0 px-2 pb-1.5 text-[10px] leading-4 text-gray-500 dark:text-white/45">{t("chat.projectDefaults.allowedAgentsHint")}</p>
        {!policyLoaded ? <p role="status" className="m-0 px-2 py-2 text-[11px] text-gray-500 dark:text-white/50">{t("chat.projectDefaults.loading")}</p>
          : agents.length === 0 ? <p className="m-0 px-2 py-2 text-[11px] text-gray-500 dark:text-white/50">{t("chat.projectDefaults.noAgents")}</p>
            : agents.map((agent) => {
              const enabled = !disabledAgentIds.includes(agent.id);
              return <button key={agent.id} type="button" role="checkbox" aria-checked={enabled} disabled={!policyLoaded || policySaving}
                onClick={() => onAgentEnabledChange(agent.id, !enabled)}
                className="flex w-full items-center gap-2 px-2 py-1.5 rounded-lg text-left text-[11px] text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-white/[0.07] disabled:opacity-50">
                <span aria-hidden="true" className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${enabled ? "border-accent-500 bg-accent-500 text-white" : "border-gray-300 dark:border-white/20"}`}>{enabled && <CheckIcon className="h-3 w-3" />}</span>
                <span className="min-w-0 truncate">{agent.label}</span>
              </button>;
            })}
        {hasAgentPolicy && <button type="button" disabled={!policyLoaded || policySaving} onClick={() => { onClearAgentPolicy(); close(); }}
          className="mt-1 w-full px-2 py-2 rounded-lg text-left text-[11px] text-gray-600 dark:text-white/65 hover:bg-gray-100 dark:hover:bg-white/[0.07] disabled:opacity-50">{t("chat.projectDefaults.resetAgents")}</button>}
        <div className="my-1 border-t border-gray-200 dark:border-white/10" />
        <p className="m-0 px-2 pt-1.5 text-[11px] font-medium text-gray-700 dark:text-white/75">{t("chat.projectDefaults.fieldsTitle")}</p>
        <p className="m-0 px-2 pb-1.5 text-[10px] leading-4 text-gray-500 dark:text-white/45">{t("chat.projectDefaults.fieldsHint")}</p>
        <div className="space-y-1">
          {rows.map(({ field, label, value }) => {
            const saved = projectFields.includes(field);
            const sameValue = saved && Object.is(storedDefaults?.[field], currentDefaults[field]);
            return <div key={field} className="rounded-lg px-2 py-1.5 hover:bg-gray-50 dark:hover:bg-white/[0.04]">
              <div className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="shrink-0 text-gray-700 dark:text-white/75">{label}</span>
                <span className="min-w-0 truncate text-right text-gray-500 dark:text-white/45" title={value}>{value}</span>
              </div>
              <div className="mt-1 flex justify-end gap-3">
                <button type="button" disabled={disabled || storageError || sameValue}
                  onClick={() => onSaveField(field)}
                  className="text-[10px] text-accent-700 dark:text-accent-300 hover:underline disabled:opacity-45 disabled:no-underline">
                  {t("chat.projectDefaults.useCurrent")}
                </button>
                {saved && <button type="button" disabled={disabled || storageError} onClick={() => onInheritField(field)}
                  className="text-[10px] text-gray-500 dark:text-white/50 hover:underline">
                  {t(field === "worktree" || field === "worktreeSubmodules" ? "chat.projectDefaults.inheritWorkspace" : "chat.projectDefaults.inheritMachine")}
                </button>}
              </div>
            </div>;
          })}
        </div>
        <div className="my-1 border-t border-gray-200 dark:border-white/10" />
        <button type="button" disabled={disabled || storageError} onClick={() => { onSave(); close(); }}
          className="w-full px-2 py-2 rounded-lg text-left text-[12px] text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-white/[0.07] disabled:opacity-50 disabled:hover:bg-transparent">
          {t(hasDefaults ? "chat.projectDefaults.update" : "chat.projectDefaults.save")}
        </button>
        {hasDefaults && <button type="button" disabled={disabled || storageError} onClick={() => { onClear(); close(); }}
          className="w-full px-2 py-2 rounded-lg text-left text-[12px] text-gray-600 dark:text-white/65 hover:bg-gray-100 dark:hover:bg-white/[0.07]">
          {t("chat.projectDefaults.clear")}
        </button>}
      </section>, document.body)}
    </span>
  );
}

/** A faixa embaixo do composer: o workspace e a branch. Agente, modelo e acesso ficam juntos no seletor. */
export function ContextStrip({ branch, workspace, worktree = false, showContext = true, children }: {
  branch: string | null;
  /** Mostra o workspace e a branch. Desligado (o contexto do composer), sobra só o que `children` traz. */
  showContext?: boolean;
  /** O seletor de workspace (conversa nova); sem ele, só o rótulo. */
  workspace?: React.ReactNode;
  /** A conversa roda num worktree. */
  worktree?: boolean;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-nowrap items-center gap-0.5 px-3 pt-1.5 text-chat-note text-gray-500 dark:text-white/45">
      {showContext && (workspace ?? (
        <span title={worktree ? t("chat.workspace.worktree") : t("chat.new.currentCheckout")} className="flex shrink-0 items-center gap-1.5 h-7 px-1.5 whitespace-nowrap">
          {worktree ? <FolderGitIcon className="w-3.5 h-3.5" /> : <FolderIcon className="w-3.5 h-3.5" />}
          {/* Coluna estreita (`ComposerColumn`): só o ícone, numa linha com o branch e o acesso. */}
          <span className="@max-[28rem]/composer:sr-only">{worktree ? t("chat.workspace.worktree") : t("chat.new.currentCheckout")}</span>
        </span>
      ))}
      {showContext && branch && <span className="flex min-w-0 items-center gap-1.5 h-7 px-1.5 font-mono text-[11.5px]" title={branch}><BranchIcon className="w-3.5 h-3.5 shrink-0" /><span className="truncate">{branch}</span></span>}
      <span className="flex-1" />
      {children && <span className="flex shrink-0 items-center">{children}</span>}
    </div>
  );
}

function ProjectPicker({ project, projects, onPick, onBrowse }: {
  project: ChatProject;
  projects: ChatProject[];
  onPick: (cwd: string) => void;
  onBrowse: () => void;
}) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover<HTMLSpanElement>();
  return (
    <span ref={ref} className="relative inline-block">
      <button type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-0.5 font-medium text-gray-900 dark:text-white hover:underline underline-offset-4 decoration-gray-300 dark:decoration-white/25">
        {project.name}
        <ChevronDownIcon className="w-5 h-5 text-gray-400 dark:text-white/40" />
      </button>
      {open && (
        <div role="listbox" aria-label={t("chat.new.projects")}
          className="absolute left-1/2 -translate-x-1/2 top-full mt-2 z-50 w-72 max-h-80 cc-scroll-hidden p-1 rounded-lg text-left
            text-chat-ui font-normal tracking-normal bg-white/[0.92] dark:bg-surface-raised/[0.92] backdrop-blur-xl
            shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_16px_40px_-18px_rgba(0,0,0,0.55)]">
          {projects.map((p) => (
            <button key={p.cwd} type="button" role="option" aria-selected={p.cwd === project.cwd} title={p.cwd}
              onClick={() => { onPick(p.cwd); setOpen(false); }}
              className={`w-full flex items-center gap-2 px-2 h-8 rounded-md
                ${p.cwd === project.cwd ? "bg-gray-100 dark:bg-white/10" : "hover:bg-gray-100 dark:hover:bg-white/[0.07]"}`}>
              <ProjectBadge name={p.name} cwd={p.cwd} size="sm" />
              <span className="flex-1 truncate text-gray-900 dark:text-white">{p.name}</span>
              {p.branch && <span className="truncate max-w-24 font-mono text-[11px] text-gray-400 dark:text-white/40">{p.branch}</span>}
            </button>
          ))}
          <button type="button" onClick={() => { setOpen(false); onBrowse(); }}
            className="w-full flex items-center gap-2 px-2 h-8 rounded-md text-gray-500 dark:text-white/50 hover:bg-gray-100 dark:hover:bg-white/[0.07]">
            {t("chat.new.otherFolder")}
          </button>
        </div>
      )}
    </span>
  );
}

/** Onde a conversa nova roda: no checkout, num worktree ou seguindo o padrão configurado. */
function WorkspaceMenu({ worktree, source, inheritedWorktree, conversationOverride, disabled, onChange }: {
  worktree: boolean;
  source: ChatWorkspaceModeSource;
  inheritedWorktree: boolean;
  conversationOverride: boolean | null;
  disabled: boolean;
  onChange: (worktree: boolean | null) => void;
}) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  const options = [
    { value: false, icon: FolderIcon, label: t("chat.new.currentCheckout"), hint: t("chat.workspace.currentHint"), selected: conversationOverride === false },
    { value: true, icon: FolderGitIcon, label: t("chat.workspace.newWorktree"), hint: t("chat.workspace.newHint"), selected: conversationOverride === true },
    { value: null, icon: inheritedWorktree ? FolderGitIcon : FolderIcon, label: t("chat.workspace.inherit"), hint: t("chat.workspace.inheritHint"), selected: conversationOverride === null },
  ];
  const current = options.find((o) => o.value === worktree)!;
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}
        title={t(`chat.workspace.source.${source}`)}
        className={`flex items-center gap-1.5 h-6 px-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-white/[0.07] hover:text-gray-800 dark:hover:text-white/80 ${open ? "bg-gray-100 dark:bg-white/[0.07]" : ""}`}>
        <current.icon className="w-3.5 h-3.5" />{current.label}
      </button>
      {open && (
        <div role="menu" aria-label={t("chat.workspace.title")}
          className="absolute left-0 top-full mt-1.5 z-50 w-72 p-1.5 rounded-lg bg-white/[0.92] dark:bg-surface-raised/[0.92] backdrop-blur-xl
            shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_16px_40px_-18px_rgba(0,0,0,0.55)]">
          <div className="px-2 pt-1 pb-1.5">
            <div className="text-chat-caption font-medium text-gray-500 dark:text-white/45">{t("chat.workspace.title")}</div>
            <div className="mt-0.5 text-[10px] leading-4 text-gray-500/80 dark:text-white/35">{t(`chat.workspace.source.${source}`)}</div>
          </div>
          {options.map((o) => (
            <button key={String(o.value)} type="button" role="menuitemradio" aria-checked={o.selected} disabled={disabled}
              onClick={() => { onChange(o.value); setOpen(false); }}
              className="w-full flex items-start gap-2 px-2 py-1.5 rounded-md text-left hover:bg-gray-100 dark:hover:bg-white/[0.07] disabled:opacity-45 disabled:hover:bg-transparent">
              <o.icon className="w-4 h-4 mt-0.5 shrink-0 text-gray-500 dark:text-white/45" />
              <span className="flex-1 min-w-0">
                <span className="block text-chat-ui font-medium text-gray-900 dark:text-white">{o.label}</span>
                <span className="block text-chat-caption text-gray-500 dark:text-white/45">{o.hint}</span>
              </span>
              {o.selected && <CheckIcon className="w-3.5 h-3.5 mt-0.5 text-gray-900 dark:text-white" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
