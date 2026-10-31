import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";

import { WindowControls, WindowLights } from "@/app/WindowLights";
import { useTabsStore } from "@/features/tabs/store";
import type { RepoGroup } from "@/features/workspaces/workspaceTree";

import { newConversation, reopenFolder } from "./chatActions";
import { PanelRightIcon, SidebarIcon } from "./chatIcons";
import { chatProjects, conversationCards, type ChatProject, type ConversationCard } from "./chatModel";
import { ChatSidebar, IconButton, ProjectBadge, type FolderDiff } from "./ChatSidebar";
import { ChatPage } from "./ChatPage";
import { SettingsSidebar, SpacesSidebar } from "./ChatPageSidebar";
import { isSettingsRoute } from "./chatSpaces";
import { useElementWidth } from "./ComposerColumn";
import { CHAT_SHELL_ATTR, ConversationView, hasTimeline } from "./ConversationView";
import { parseUnifiedDiff } from "./diffModel";
import { scmWorkingDiff } from "./ipc";
import { startChatLive } from "./liveStore";
import { useLiveSummary } from "./liveSummary";
import { HeaderLive } from "./LiveActivity";
import { PermissionsInbox } from "./permissions/PermissionsInbox";
import { TeamHeaderBadge } from "./team/TeamThreadFeed";
import { useOpenTeamPanel } from "./team/TeamSidebar";
import { PermissionsManager } from "./permissions/PermissionsManager";
import { setInboxOpen, usePermissions } from "./permissions/permissionsStore";
import { startQueueRunner } from "./queueRunner";
import { NewConversation, pickProjectFolder } from "./NewConversation";
import { RightPanel } from "./RightPanel";
import { PanelToolbar } from "./PanelToolbar";
import { ShellModeSwitch } from "./ShellModeSwitch";
import { SummaryPane } from "./summary/SummaryPane";
import { chatInset, SUMMARY_W } from "./summary/summaryLayout";
import { addSurface, forgetLastPanel, type RightPanelTab, openTeamPanelFocused, setRightPanel, toggleRightPanel, useChatStore } from "./store";
import { matchTeamShortcut } from "./panelMenu";
import { threadCards, threadIdOf, threadKey } from "./structured/model";
import { startStructured, useStructured } from "./structured/store";
import { StructuredConversationView } from "./structured/StructuredConversationView";

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
  const panelTab = useChatStore((s) => s.panel);
  const maximized = useChatStore((s) => s.panelMaximized);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const { ref: mainRef, width: mainWidth } = useElementWidth<HTMLElement>();
  const inset = chatInset(panelTab, mainWidth);
  const [folder, setFolder] = useState<string | null>(null);
  // O "+" de um projeto na barra pede a tela de conversa nova já nessa pasta: a casca lê o pedido uma vez.
  const composeFolder = useChatStore((s) => s.composeFolder);
  useEffect(() => {
    if (!composeFolder) return;
    setFolder(composeFolder);
    useChatStore.setState({ composeFolder: null });
  }, [composeFolder]);
  const threadCard = selectedThread ? cards.find((c) => threadIdOf(c.tabId) === selectedThread) ?? null : null;
  const active = composing ? null : threadCard ?? cards.find((c) => c.tabId === activeTabId) ?? null;
  const activeThread = active ? threads.find((th) => th.id === threadIdOf(active.tabId)) ?? null : null;
  const diffs = useFolderDiffs(cards);

  useEffect(() => startChatLive(), []);
  useEffect(() => startStructured(), []);
  useEffect(() => startQueueRunner(), []);
  // O atalho do Time (⌥⌘T no macOS, Ctrl+Shift+O nos outros) abre o painel Time e foca nele. Na fase de
  // captura, antes do terminal: o acorde não chega à TUI. A casca só existe com o modo chat ligado.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matchTeamShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      openTeamPanelFocused();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
  // Uma conversa nova esquece a aba lembrada do painel: a próxima abertura mostra o estado vazio.
  useEffect(() => { if (composing) forgetLastPanel(); }, [composing]);
  // A caixa de permissões e o painel direito dividem o lado direito: abrir um fecha o outro.
  const inboxOpen = usePermissions((s) => s.inboxOpen);
  // O painel que estava à vista volta quando a caixa fecha (o Resumo é o padrão e não pode ficar fechado por isso).
  const hiddenByInbox = useRef<RightPanelTab | null>(null);
  useEffect(() => {
    const current = useChatStore.getState().panel;
    if (inboxOpen) {
      if (current && current !== "empty") hiddenByInbox.current = current;
      setRightPanel(null);
    } else if (hiddenByInbox.current) {
      if (current === null) setRightPanel(hiddenByInbox.current);
      hiddenByInbox.current = null;
    }
  }, [inboxOpen]);
  useEffect(() => { if (panelOpen) setInboxOpen(false); }, [panelOpen]);
  // Com o time ativo, o painel Time abre no lado direito (prancheta 15).
  useOpenTeamPanel(active?.tabId ?? null, openTeamSurface);

  const addProject = async () => {
    const picked = await pickProjectFolder(t("home.dialogTitle"));
    if (!picked) return;
    setFolder(picked);
    newConversation();
  };

  const project = active ? active.project : projects.find((p) => p.cwd === folder)?.name ?? null;

  return (
    <div {...{ [CHAT_SHELL_ATTR]: "" }}
      className="cc-chat-type absolute inset-0 flex bg-white dark:bg-surface-deep text-gray-900 dark:text-white">
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
        <main ref={mainRef} className="relative flex-1 min-w-[440px] flex flex-col">
          <header data-tauri-drag-region className="h-[52px] shrink-0 flex items-center gap-3 pl-5 pr-3 text-chat-ui select-none">
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
              <TeamHeaderBadge conversation={active} />
            </span>
            {active && <ActiveLive cardKey={active.tabId} />}
            {/* O seletor fica aqui (não cabe no cabeçalho da barra lateral) e nunca encolhe: o breadcrumb é que cede. */}
            <ShellModeSwitch className="shrink-0" />
            {/* A fileira de ícones do painel, como no Claude Code: Resumo, Terminal, Diff, Navegador, Aparelho, Arquivos e ⋯. */}
            <PanelToolbar tabId={activeThread ? null : active?.tabId ?? null} terminalAvailable={!!active && !activeThread && hasTimeline(active.agentId)} />
            <IconButton label={t("chat.panel.toggle")} onClick={toggleRightPanel} active={panelOpen}><PanelRightIcon className="w-4 h-4" /></IconButton>
            {/* Windows e Linux: os botões da janela ficam no canto direito (com o painel aberto, no dele). */}
            {!panelOpen && <WindowControls className="-mr-3" />}
          </header>

          {/* A conversa cede o lado direito ao Resumo (solto, sem coluna); sem lugar, o Resumo some. */}
          <div className="flex-1 min-h-0 flex flex-col" style={{ paddingRight: inset }}>
            {active && activeThread ? <StructuredConversationView key={active.tabId} card={active} thread={activeThread} cards={cards} />
              : active ? <ConversationView key={active.tabId} card={active} cards={cards} /> : <NewConversation projects={projects} folder={folder} onFolder={setFolder} />}
          </div>
          {inset > 0 && (
            <div className="absolute top-[52px] bottom-0 right-3 z-10" style={{ width: SUMMARY_W }}>
              <SummaryPane conversation={active} cwd={active?.cwd ?? folder ?? projects[0]?.cwd ?? null} tabId={activeThread ? null : active?.tabId ?? null} />
            </div>
          )}
        </main>
      )}

      {!page && <RightPanel tabId={activeThread ? null : active?.tabId ?? null} cwd={active?.cwd ?? folder ?? projects[0]?.cwd ?? null} project={project ?? ""}
        conversation={active} cards={cards} />}
      {!page && inboxOpen && <PermissionsInbox />}
      <PermissionsManager />
    </div>
  );
}

/** "Trabalhando · 52 s" no cabeçalho da conversa aberta (prancheta 13). */
function ActiveLive({ cardKey }: { cardKey: string }) {
  const live = useLiveSummary(cardKey);
  return <HeaderLive live={live} />;
}

/** Quanto esperar depois do último "a conversa cresceu" de uma pasta para reler o diff dela. */
const DIFF_DEBOUNCE_MS = 3000;

/** O `+/−` não commitado de cada pasta com conversa aberta, relido quando um agente dela trabalha. */
export function useFolderDiffs(cards: ConversationCard[]): Record<string, FolderDiff> {
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

/** Abre a aba Time do painel direito (estável: o hook do time a chama uma vez por conversa). */
function openTeamSurface(): void {
  addSurface("team");
}
