import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";

import { WindowLights } from "@/app/WindowLights";
import { readTuning } from "@/features/canvas/tabTuning";
import { useTabsStore } from "@/features/tabs/store";
import type { RepoGroup } from "@/features/workspaces/workspaceTree";

import { newConversation, reopenFolder } from "./chatActions";
import { DetailsIcon, PanelBottomIcon, PanelRightIcon, SidebarIcon } from "./chatIcons";
import { chatProjects, conversationCards, readAccess, type ChatProject, type ConversationCard } from "./chatModel";
import { ChatSidebar, IconButton, ProjectBadge, type FolderDiff } from "./ChatSidebar";
import { ChatPage } from "./ChatPage";
import { SettingsSidebar, SpacesSidebar } from "./ChatPageSidebar";
import { isSettingsRoute } from "./chatSpaces";
import { CHAT_SHELL_ATTR, ConversationView, hasTimeline, useTerminalOpen } from "./ConversationView";
import { parseUnifiedDiff } from "./diffModel";
import { scmWorkingDiff } from "./ipc";
import { startChatLive } from "./liveStore";
import { NewConversation, pickProjectFolder } from "./NewConversation";
import { RightPanel } from "./RightPanel";
import { ShellModeSwitch } from "./ShellModeSwitch";
import { setTerminalOpen, toggleRightPanel, useChatStore } from "./store";
import { threadCards, threadIdOf, threadKey } from "./structured/model";
import { startStructured, useStructured } from "./structured/store";
import { StructuredConversationView } from "./structured/StructuredConversationView";
import { usePopover } from "./usePopover";

/**
 * A casca do modo chat (pranchetas 1 e 2, estilo T3 Code): a sidebar de conversas, a conversa aberta
 * ou a de conversa nova, e o painel direito. Fica por cima do workspace, que continua montado por
 * baixo (terminais, canvas, navegadores): trocar de modo não derruba nada. As conversas são as abas
 * de agente da janela.
 *
 * Uma rota de tela cheia (`page`: Configurações, Missões…) abre no lugar da conversa, com a sidebar
 * das seções ou dos Espaços; o painel direito some enquanto ela está aberta.
 */
export function ChatShell({ groups, page = null }: { groups: RepoGroup[]; page?: React.ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const tabCount = useTabsStore((s) => s.tabs.length);
  const closePage = useCallback(() => navigate(tabCount > 0 ? "/workspace" : "/"), [navigate, tabCount]);
  const threads = useStructured((s) => s.threads);
  const selectedThread = useChatStore((s) => s.thread);
  const detected = useTabsStore((s) => s.detectedAgents);
  const cards = useMemo(() => {
    const labelOf = (id: string) => detected.find((a) => a.id === id)?.label ?? id;
    return [...threadCards(threads, groups, labelOf, selectedThread), ...conversationCards(groups)].sort((a, b) => b.openedAt - a.openedAt);
  }, [groups, threads, detected, selectedThread]);
  const projects = useMemo(() => chatProjects(groups), [groups]);
  const closed = useMemo(() => {
    const open = new Set(cards.map((c) => c.cwd));
    return groups.flatMap((g) => g.workspaces).filter((w) => w.closed && !open.has(w.cwd)).map((w): ChatProject => ({ cwd: w.cwd, name: w.title, branch: w.branch }));
  }, [groups, cards]);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const composing = useChatStore((s) => s.composing);
  const panelOpen = useChatStore((s) => s.panel !== null);
  const maximized = useChatStore((s) => s.panelMaximized);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [folder, setFolder] = useState<string | null>(null);
  const threadCard = selectedThread ? cards.find((c) => threadIdOf(c.tabId) === selectedThread) ?? null : null;
  const active = composing ? null : threadCard ?? cards.find((c) => c.tabId === activeTabId) ?? null;
  const activeThread = active ? threads.find((th) => th.id === threadIdOf(active.tabId)) ?? null : null;
  const diffs = useFolderDiffs(cards);

  useEffect(() => startChatLive(), []);
  useEffect(() => startStructured(), []);

  const addProject = async () => {
    const picked = await pickProjectFolder(t("home.dialogTitle"));
    if (!picked) return;
    setFolder(picked);
    newConversation();
  };

  const project = active ? active.project : projects.find((p) => p.cwd === folder)?.name ?? null;

  return (
    <div {...{ [CHAT_SHELL_ATTR]: "" }}
      className="absolute inset-0 flex bg-white dark:bg-surface-deep text-gray-900 dark:text-white">
      {sidebarOpen && page && (isSettingsRoute(pathname)
        ? <SettingsSidebar onBack={closePage} />
        : <SpacesSidebar activeCount={cards.length} onBack={closePage} />)}
      {sidebarOpen && !page && (
        <ChatSidebar cards={cards} closed={closed} diffs={diffs} selectedId={active?.tabId ?? null}
          onCollapse={() => setSidebarOpen(false)} onAddProject={() => { void addProject(); }}
          onReopen={(cwd) => { void reopenFolder(cwd); }} />
      )}

      {page && (
        <ChatPage onClose={closePage} sidebarOpen={sidebarOpen} onExpandSidebar={() => setSidebarOpen(true)}>{page}</ChatPage>
      )}

      {!page && !(panelOpen && maximized) && (
        <main className="relative flex-1 min-w-[360px] flex flex-col">
          <header data-tauri-drag-region className="h-[52px] shrink-0 flex items-center gap-3 pl-5 pr-3 text-[14px] select-none">
            {!sidebarOpen && (
              <>
                <WindowLights />
                <IconButton label={t("chat.sidebar.expand")} onClick={() => setSidebarOpen(true)}><SidebarIcon className="w-4 h-4" /></IconButton>
              </>
            )}
            <span data-tauri-drag-region className="flex-1 min-w-0 flex items-center gap-3 truncate">
              {project && <span className="flex items-center gap-2 text-gray-500 dark:text-white/50 truncate"><ProjectBadge name={project} size="sm" />{project}</span>}
              {project && <span aria-hidden="true" className="text-gray-300 dark:text-white/25">/</span>}
              <span className="font-medium truncate">{active ? active.title : t("chat.new.title")}</span>
            </span>
            <ShellModeSwitch />
            <div className="flex items-center gap-1">
              <DetailsButton card={active} />
              {active && !activeThread && hasTimeline(active.agentId) ? <TerminalToggle card={active} /> : (
                <IconButton label={t("chat.terminal.toggle")} onClick={() => undefined} className="opacity-40 pointer-events-none"><PanelBottomIcon className="w-4 h-4" /></IconButton>
              )}
              <IconButton label={t("chat.panel.toggle")} onClick={toggleRightPanel} active={panelOpen}><PanelRightIcon className="w-4 h-4" /></IconButton>
            </div>
          </header>

          {active && activeThread ? <StructuredConversationView key={active.tabId} card={active} thread={activeThread} />
            : active ? <ConversationView key={active.tabId} card={active} /> : <NewConversation projects={projects} folder={folder} onFolder={setFolder} />}
        </main>
      )}

      {!page && <RightPanel tabId={activeThread ? null : active?.tabId ?? null} cwd={active?.cwd ?? folder ?? projects[0]?.cwd ?? null} project={project ?? ""} />}
    </div>
  );
}

/** Abre e fecha a gaveta do terminal da conversa (onde a TUI do agente continua rodando). */
function TerminalToggle({ card }: { card: ConversationCard }) {
  const { t } = useTranslation();
  const open = useTerminalOpen(card);
  return (
    <IconButton label={t("chat.terminal.toggle")} onClick={() => setTerminalOpen(card.tabId, !open)} active={open}>
      <PanelBottomIcon className="w-4 h-4" />
    </IconButton>
  );
}

/** Os detalhes da conversa: agente, modelo, esforço, permissão, pasta, branch e sessão. */
function DetailsButton({ card }: { card: ConversationCard | null }) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  const tab = useTabsStore((s) => (card ? s.tabs.find((x) => x.id === card.tabId) : undefined));
  if (!card || !tab) {
    return <IconButton label={t("chat.details.title")} onClick={() => undefined} className="opacity-40 pointer-events-none"><DetailsIcon className="w-4 h-4" /></IconButton>;
  }
  const tuning = readTuning(tab.agentId, tab.command);
  const access = readAccess(tab.agentId, tab.command);
  const rows: [string, string][] = [
    [t("chat.details.agent"), tab.agentLabel],
    [t("chat.details.model"), tuning.model ?? t("chat.model.default")],
    [t("chat.details.effort"), tuning.effort ? t(`chat.effort.${tuning.effort}`, { defaultValue: tuning.effort }) : t("chat.effort.default")],
    [t("chat.details.access"), access.plan ? t("chat.plan.plan") : t(`chat.access.${access.access}`)],
    [t("chat.details.folder"), tab.cwd],
    [t("chat.details.branch"), card.branch ?? "—"],
    [t("chat.details.session"), tab.sessionId ?? "—"],
  ];
  return (
    <div ref={ref} className="relative">
      <IconButton label={t("chat.details.title")} onClick={() => setOpen(!open)} active={open}><DetailsIcon className="w-4 h-4" /></IconButton>
      {open && (
        <div role="dialog" aria-label={t("chat.details.title")}
          className="absolute right-0 top-full mt-1.5 z-50 w-[280px] p-3 rounded-lg text-[12.5px] bg-white/[0.92] dark:bg-surface-raised/[0.92] backdrop-blur-xl
            shadow-[0_0_0_1px_rgba(24,24,27,0.1),0_16px_40px_-18px_rgba(0,0,0,0.55)]">
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-gray-500 dark:text-white/45">{k}</dt>
                <dd className="m-0 truncate text-gray-900 dark:text-white" title={v}>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

/** Quanto esperar depois do último "a conversa cresceu" de uma pasta para reler o diff dela. */
const DIFF_DEBOUNCE_MS = 3000;

/** O `+/−` não commitado de cada pasta com conversa aberta, relido quando um agente dela trabalha. */
function useFolderDiffs(cards: ConversationCard[]): Record<string, FolderDiff> {
  const [diffs, setDiffs] = useState<Record<string, FolderDiff>>({});
  const cwds = useMemo(() => [...new Set(cards.map((c) => c.cwd))].sort().join("\n"), [cards]);
  const tabCwd = useRef(new Map<string, string>());
  tabCwd.current = new Map(cards.map((c) => [c.tabId, c.cwd]));
  const timers = useRef(new Map<string, number>());

  useEffect(() => {
    const load = (cwd: string) => {
      scmWorkingDiff(cwd)
        .then((diff) => {
          const files = diff ? parseUnifiedDiff(diff.text) : [];
          const total = files.reduce((n, f) => ({ added: n.added + f.added, removed: n.removed + f.removed }), { added: 0, removed: 0 });
          setDiffs((prev) => ({ ...prev, [cwd]: total }));
        })
        .catch(() => undefined);
    };
    const list = cwds ? cwds.split("\n") : [];
    list.forEach(load);
    const off = listen<{ tabId: string }>("cc-conversation-grew", (e) => {
      const cwd = tabCwd.current.get(e.payload.tabId);
      if (!cwd) return;
      const prev = timers.current.get(cwd);
      if (prev) window.clearTimeout(prev);
      timers.current.set(cwd, window.setTimeout(() => load(cwd), DIFF_DEBOUNCE_MS));
    });
    // A conversa por protocolo não tem transcript: o diff relê quando o turno dela acaba.
    const offThread = listen<{ threadId: string; type: string; phase?: string }>("cc-chat-thread", (e) => {
      if (e.payload.type !== "phase" || e.payload.phase !== "idle") return;
      const cwd = tabCwd.current.get(threadKey(e.payload.threadId));
      if (cwd) load(cwd);
    });
    const pending = timers.current;
    return () => {
      off.then((fn) => fn()).catch(() => undefined);
      offThread.then((fn) => fn()).catch(() => undefined);
      pending.forEach((id) => window.clearTimeout(id));
      pending.clear();
    };
  }, [cwds]);

  return diffs;
}
