import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { homeDir } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { useAvailableAgents } from "@/features/agents/useAvailableAgents";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID } from "@/features/tabs/types";
import { baseName } from "@/features/workspaces/workspaceTree";

import { AccessMenu } from "./AccessMenu";
import { AgentModelPicker, EffortMenu } from "./AgentModelPicker";
import { startConversation } from "./chatActions";
import { BotIcon, BranchIcon, ChevronDownIcon, FolderIcon } from "./chatIcons";
import { accessModesFor, planSupported, type ChatProject } from "./chatModel";
import { loadChatPrefs, saveChatPrefs, type ChatPrefs } from "./chatPrefs";
import { ChatComposer } from "./ChatComposer";
import { usePopover } from "./usePopover";

/** O agente que o composer sugere quando não há escolha lembrada. */
const PREFERRED_AGENT = "claude-code";

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
  const available = useAvailableAgents();
  const agents = useMemo(() => available.filter((a) => a.id !== SHELL_AGENT_ID), [available]);
  const activeCwd = useTabsStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.cwd ?? null);
  const [prefs, setPrefs] = useState<ChatPrefs>(loadChatPrefs);
  const [error, setError] = useState("");

  const update = (patch: Partial<ChatPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      saveChatPrefs(next);
      return next;
    });
  };

  const cwd = folder ?? prefs.cwd ?? activeCwd ?? projects[0]?.cwd ?? null;
  const project: ChatProject | null = projects.find((p) => p.cwd === cwd) ?? (cwd ? { cwd, name: baseName(cwd), branch: null } : null);
  const agent = agents.find((a) => a.id === prefs.agentId) ?? agents.find((a) => a.id === PREFERRED_AGENT) ?? agents[0] ?? null;
  const mine = !!agent && prefs.agentId === agent.id;
  const modes = agent ? accessModesFor(agent.id) : ["ask" as const];
  const access = modes.includes(prefs.access) ? prefs.access : modes.includes("safe") ? "safe" : "ask";
  const plan = !!agent && planSupported(agent.id) && prefs.plan;

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
  const submit = async (prompt: string): Promise<boolean> => {
    setError("");
    if (!project) { setError(t("chat.new.noFolder")); return false; }
    if (!agent) { setError(t("chat.agent.none")); return false; }
    try {
      await startConversation({
        cwd: project.cwd,
        agent,
        prompt,
        model: mine ? prefs.model : null,
        effort: mine ? prefs.effort : null,
        account: mine ? prefs.accountId ?? undefined : undefined,
        access,
        plan,
      });
      update({ cwd: project.cwd, agentId: agent.id });
      return true;
    } catch (e) {
      setError(t("chat.new.failed", { error: String(e) }));
      return false;
    }
  };

  return (
    <section className="flex-1 min-h-0 flex flex-col items-center justify-center px-6 sm:px-12 pb-20">
      <h1 className="m-0 text-center text-[26px] sm:text-[30px] leading-tight font-normal tracking-tight text-gray-900 dark:text-white">
        {project ? (
          <>
            {t("chat.new.headline")}{" "}
            <ProjectPicker project={project} projects={projects} onPick={choose} onBrowse={browse} />?
          </>
        ) : t("chat.new.pickFolderHeadline")}
      </h1>
      <p className="mt-2 mb-[18px] text-[14px]">
        <button type="button" onClick={() => { void (project ? withoutProject() : browse()); }}
          className="text-gray-500 dark:text-white/45 hover:text-gray-800 dark:hover:text-white/80">
          {project ? t("chat.new.withoutProject") : t("chat.new.pickFolder")}
        </button>
      </p>

      <div className="w-full max-w-[736px]">
        <ChatComposer autoFocus cwd={project?.cwd ?? null} placeholder={t("chat.composer.placeholder")} disabled={!project || !agent}
          onSubmit={submit}
          controls={
            <>
              <AgentModelPicker agents={agents}
                value={{ agentId: agent?.id ?? null, model: mine ? prefs.model : null, effort: mine ? prefs.effort : null, account: mine ? prefs.accountId : null }}
                onChange={(v) => update({ agentId: v.agentId, model: v.model, effort: v.effort, accountId: v.account })} />
              <EffortMenu agentId={agent?.id ?? null} model={mine ? prefs.model : null} account={mine ? prefs.accountId : null}
                value={mine ? prefs.effort : null} onChange={(effort) => agent && update({ agentId: agent.id, effort, model: mine ? prefs.model : null, accountId: mine ? prefs.accountId : null })} />
              {agent && planSupported(agent.id) && (
                <button type="button" onClick={() => update({ plan: !prefs.plan })} aria-pressed={plan}
                  title={plan ? t("chat.plan.onHint") : t("chat.plan.offHint")}
                  className="flex items-center gap-1.5 h-7 px-2 rounded-lg text-[14px] font-medium text-gray-900/85 dark:text-white/85 hover:bg-gray-100 dark:hover:bg-white/[0.07]">
                  <BotIcon className="w-4 h-4 text-gray-500 dark:text-white/45" />
                  {plan ? t("chat.plan.plan") : t("chat.plan.build")}
                </button>
              )}
            </>
          } />
        <ContextStrip branch={project?.branch ?? null}>
          <AccessMenu value={access} available={modes} onChange={(next) => update({ access: next })} />
        </ContextStrip>
        {error && <p role="alert" className="mt-3 px-2 text-[12.5px] text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </section>
  );
}

/** A faixa embaixo do composer: o workspace (por enquanto sempre o checkout atual), a branch e, à direita, as permissões. */
export function ContextStrip({ branch, children }: { branch: string | null; children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-0.5 px-2 pt-2 text-[12px] text-gray-500 dark:text-white/45">
      <span className="flex items-center gap-1.5 h-6 px-1.5"><FolderIcon className="w-3.5 h-3.5" />{t("chat.new.currentCheckout")}</span>
      {branch && <span className="flex items-center gap-1.5 h-6 px-1.5 font-mono text-[11.5px]"><BranchIcon className="w-3.5 h-3.5" />{branch}</span>}
      <span className="flex-1" />
      {children}
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
          className="absolute left-1/2 -translate-x-1/2 top-full mt-2 z-50 w-72 max-h-80 cc-scroll p-1 rounded-lg text-left
            text-[13.5px] font-normal tracking-normal bg-white/[0.92] dark:bg-surface-raised/[0.92] backdrop-blur-xl
            shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_16px_40px_-18px_rgba(0,0,0,0.55)]">
          {projects.map((p) => (
            <button key={p.cwd} type="button" role="option" aria-selected={p.cwd === project.cwd} title={p.cwd}
              onClick={() => { onPick(p.cwd); setOpen(false); }}
              className={`w-full flex items-center gap-2 px-2 h-8 rounded-md
                ${p.cwd === project.cwd ? "bg-gray-100 dark:bg-white/10" : "hover:bg-gray-100 dark:hover:bg-white/[0.07]"}`}>
              <FolderIcon className="w-3.5 h-3.5 shrink-0 text-gray-400 dark:text-white/40" />
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
