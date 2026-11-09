import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";

import { WindowControls, WindowLights } from "@/app/WindowLights";
import { useTabsStore } from "@/features/tabs/store";
import { useLocalAcpStore } from "@/features/agents/localAcpStore";
import type { RepoGroup } from "@/features/workspaces/workspaceTree";

import { AttachCwdContext } from "./attachments/AttachmentStrip";
import { DropOverlay } from "./attachments/DropOverlay";
import { useChatFileDrop } from "./attachments/useChatFileDrop";
import { newConversation, reopenFolder } from "./chatActions";
import { PanelRightIcon, SidebarIcon } from "./chatIcons";
import { chatProjects, conversationCards, PROTOCOL_AGENTS, type ChatProject, type ConversationCard } from "./chatModel";
import { ProjectBadge } from "./ChatProjectBadge";
import { useChatProjectIdentityList } from "./chatProjectIdentity";
import { normalizeProjectPath } from "./chatProjectPrefs";
import { MissionsSection } from "@/features/missions/MissionsSection";
import { ChatSidebar, IconButton, type FolderDiff } from "./ChatSidebar";
import { ChatPage } from "./ChatPage";
import { SettingsSidebar, SpacesSidebar } from "./ChatPageSidebar";
import { isFullscreenRoute, isSettingsRoute } from "./chatSpaces";
import { useElementWidth } from "./ComposerColumn";
import { CHAT_SHELL_ATTR, ConversationView } from "./ConversationView";
import { hasTimeline } from "./chatModel";
import { parseUnifiedDiff } from "./diffModel";
import { scmWorkingDiff } from "./ipc";
import { startChatLive } from "./liveStore";
import { useLiveSummary } from "./liveSummary";
import { SummaryPane } from "./summary/SummaryPane";
import { SUMMARY_POPOVER_W, SummaryPopover } from "./summary/SummaryPopover";
import { HeaderLive } from "./LiveActivity";
import { PermissionsInbox } from "./permissions/PermissionsInbox";
import { TeamHeaderBadge } from "./team/TeamThreadFeed";
import { PermissionsManager } from "./permissions/PermissionsManager";
import { setInboxOpen, usePermissions } from "./permissions/permissionsStore";
import { startQueueRunner } from "./queueRunner";
import { NewConversation, pickProjectFolder } from "./NewConversation";
import { RightPanel } from "./RightPanel";
import { runInShell } from "./shellTerminal";
import { startProjectScriptSettleWatcher } from "./projectScriptAutomation";
import { RunCodeContext } from "./timeline/CodeBlockFrame";
import { PanelToolbar } from "./PanelToolbar";
import { ShellModeSwitch } from "./ShellModeSwitch";
import { useTeamDraft } from "./team/draftStore";
import { closeSummary, forgetLastPanel, setChatBrowserFloatRect, type RightPanelTab, panelForNewConversation, setRightPanel, toggleRightPanel, useChatStore } from "./store";
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
  const localProviders = useLocalAcpStore((s) => s.providers);
  const localProvidersLoaded = useLocalAcpStore((s) => s.loaded);
  const loadLocalProviders = useLocalAcpStore((s) => s.load);
  useEffect(() => { if (!localProvidersLoaded) void loadLocalProviders().catch(console.error); }, [localProvidersLoaded, loadLocalProviders]);
  const cards = useMemo(() => {
    const labelOf = (id: string) => detected.find((a) => a.id === id)?.label ?? localProviders.find((a) => a.id === id)?.label ?? id;
    return [...threadCards(threads, groups, labelOf, selectedThread), ...conversationCards(groups)].sort((a, b) => b.openedAt - a.openedAt);
  }, [groups, threads, detected, localProviders, selectedThread]);
  const projects = useMemo(() => chatProjects(groups), [groups]);
  const projectIdentities = useChatProjectIdentityList();
  const knownProjects = useMemo(() => {
    const byPath = new Map(projects.map((candidate) => [normalizeProjectPath(candidate.cwd), candidate]));
    for (const [cwd, metadata] of Object.entries(projectIdentities)) {
      if (!byPath.has(cwd) && metadata.known && metadata.name) byPath.set(cwd, { cwd, name: metadata.name, branch: metadata.branch });
    }
    return [...byPath.values()];
  }, [projects, projectIdentities]);
  const selectableProjects = useMemo(() => knownProjects.filter((candidate) => !projectIdentities[normalizeProjectPath(candidate.cwd)]?.archived), [knownProjects, projectIdentities]);
  const closed = useMemo(() => {
    const open = new Set(cards.map((c) => c.cwd));
    return groups.flatMap((g) => g.workspaces).filter((w) => w.closed && !open.has(w.cwd)).map((w): ChatProject => ({ cwd: w.cwd, name: w.title, branch: w.branch }));
  }, [groups, cards]);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const composing = useChatStore((s) => s.composing);
  const panelOpen = useChatStore((s) => s.panel !== null);
  const maximized = useChatStore((s) => s.panelMaximized);
  const summaryOpen = useChatStore((s) => s.summaryOpen);
  const summaryPinned = useChatStore((s) => s.summaryPinned);
  // A prancheta em tela cheia (`/design/:id`) ocupa a janela toda: sem a sidebar, com «Sair da tela cheia».
  const fullPage = isFullscreenRoute(pathname);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const { ref: mainRef } = useElementWidth<HTMLElement>();
  // Arquivos do Finder soltos na coluna do chat viram anexos do composer à vista (só os caminhos).
  useChatFileDrop(mainRef);
  useEffect(() => {
    const toggleSidebar = () => setSidebarOpen((open) => !open);
    window.addEventListener("ade:chat-sidebar-toggle", toggleSidebar);
    return () => window.removeEventListener("ade:chat-sidebar-toggle", toggleSidebar);
  }, []);
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
  const activeCwd = active?.cwd ?? null;
  // Trocar de conversa fecha o Resumo flutuante (ele é da conversa que estava à vista).
  const activeKey = active?.tabId ?? null;
  useEffect(() => { closeSummary(); }, [activeKey]);
  const runCode = useMemo(() => (activeCwd ? (command: string) => runInShell(activeCwd, command) : null), [activeCwd]);

  useEffect(() => startChatLive(), []);
  useEffect(() => startStructured(), []);
  useEffect(() => startQueueRunner(), []);
  useEffect(() => startProjectScriptSettleWatcher(), []);
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
  // O painel Time só abre quando a pessoa o pede (botão, atalho ou ao criar o time): trocar de conversa, de
  // integrante ou entrar numa conversa do time não mexe na aba do painel. Uma conversa nova só tira o Time que sobrou.
  const newScreen = !active;
  useEffect(() => {
    if (!newScreen) return;
    const next = panelForNewConversation(useChatStore.getState().panel, useTeamDraft.getState().members.length === 0);
    if (next !== useChatStore.getState().panel) setRightPanel(next);
  }, [newScreen]);

  const addProject = useCallback(async () => {
    const picked = await pickProjectFolder(t("home.dialogTitle"));
    if (!picked) return;
    setFolder(picked);
    newConversation();
  }, [t]);

  useEffect(() => {
    const onAddProject = () => { void addProject(); };
    window.addEventListener("ade:chat-add-project", onAddProject);
    return () => window.removeEventListener("ade:chat-add-project", onAddProject);
  }, [addProject]);

  const project = active ? active.project : knownProjects.find((p) => p.cwd === folder)?.name ?? null;

  return (
    <div {...{ [CHAT_SHELL_ATTR]: "" }}
      className="cc-chat-type absolute inset-0 flex bg-white dark:bg-surface-deep text-gray-900 dark:text-white">
      {sidebarOpen && page && !fullPage && (isSettingsRoute(pathname)
        ? <SettingsSidebar onBack={closePage} />
        : <SpacesSidebar activeCount={cards.length} onBack={closePage} />)}
      {sidebarOpen && !page && (
        <ChatSidebar cards={cards} projects={knownProjects} closed={closed} diffs={diffs} selectedId={active?.tabId ?? null}
          onCollapse={() => setSidebarOpen(false)} onAddProject={() => { void addProject(); }}
          onReopen={(cwd) => { void reopenFolder(cwd); }}
          // As missões também se criam e se iniciam daqui (mesmos comandos das Abas e do Canvas).
          extraTop={<MissionsSection cwd={active?.cwd ?? folder ?? projects[0]?.cwd ?? null} />} />
      )}

      {page && (
        <ChatPage onClose={closePage} sidebarOpen={sidebarOpen && !fullPage} fullscreen={fullPage} onExpandSidebar={() => setSidebarOpen(true)}>{page}</ChatPage>
      )}

      {!page && !(panelOpen && maximized) && (
        <main ref={mainRef} className="@container/main relative flex-1 min-w-[440px] flex flex-col">
          <header data-tauri-drag-region className="h-[52px] shrink-0 flex items-center gap-3 pl-5 pr-3 text-chat-ui select-none">
            {!sidebarOpen && (
              <>
                <WindowLights />
                <IconButton label={t("chat.sidebar.expand")} onClick={() => setSidebarOpen(true)}><SidebarIcon className="w-4 h-4" /></IconButton>
              </>
            )}
            <span data-tauri-drag-region className="flex-1 min-w-0 flex items-center gap-3 truncate">
              {project && <span className="flex items-center gap-2 text-gray-500 dark:text-white/50 truncate"><ProjectBadge name={project} cwd={active?.cwd ?? folder} size="sm" />{project}</span>}
              {project && <span aria-hidden="true" className="text-gray-300 dark:text-white/25">/</span>}
              <span className="font-medium truncate">{active ? active.title : t("chat.new.title")}</span>
              <TeamHeaderBadge conversation={active} />
            </span>
            {active && <ActiveLive cardKey={active.tabId} />}
            {/* O seletor fica aqui (não cabe no cabeçalho da barra lateral) e nunca encolhe: o breadcrumb é que cede. */}
            <ShellModeSwitch className="shrink-0" />
            {/* A fileira de ícones do painel, como no Claude Code: Resumo, Terminal, Diff, Navegador, Aparelho, Arquivos e ⋯. */}
            {/* O >_ alterna a gaveta do agente (TUI com timeline) ou abre a aba Terminal do painel (um shell na pasta). */}
            <PanelToolbar drawerTabId={active && !activeThread && hasTimeline(active.agentId) ? active.tabId : null} terminalAvailable={!!active} prAvailable={!!(active?.cwd ?? folder)} sideAvailable={!!active && (!!PROTOCOL_AGENTS[active.agentId] || active.agentId.startsWith("local-acp-"))} />
            <IconButton label={t("chat.panel.toggle")} onClick={toggleRightPanel} active={panelOpen}><PanelRightIcon className="w-4 h-4" /></IconButton>
            {/* Windows e Linux: os botões da janela ficam no canto direito (com o painel aberto, no dele). */}
            {!panelOpen && <WindowControls className="-mr-3" />}
          </header>

          {/* Abaixo do cabeçalho (que fica com a largura inteira): a conversa e, sem outro painel, a coluna fixa do Resumo
              (como no Claude Code). A conversa é sempre o primeiro filho, então ligar o Resumo não a remonta. */}
          <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-[320px] min-h-0 flex flex-col">
            <AttachCwdContext.Provider value={active?.cwd ?? null}>
              {/* O «Rodar» dos blocos de código vai ao terminal da pasta da conversa aberta. */}
              <RunCodeContext.Provider value={runCode}>
              {active && activeThread ? <StructuredConversationView key={active.tabId} card={active} thread={activeThread} cards={cards} />
                : active ? <ConversationView key={active.tabId} card={active} cards={cards} /> : <NewConversation projects={selectableProjects} folder={folder} onFolder={setFolder} />}
              </RunCodeContext.Provider>
            </AttachCwdContext.Provider>
          </div>
          {summaryPinned && !panelOpen && (
            <aside aria-label={t("chat.panel.open.summary")} data-summary-column=""
              className="w-[350px] min-w-[280px] shrink flex flex-col min-h-0 border-l border-gray-200 dark:border-white/[0.08] bg-white dark:bg-surface-deep">
              <SummaryPane inCard conversation={active} cwd={active?.cwd ?? folder ?? projects[0]?.cwd ?? null} tabId={activeThread ? null : active?.tabId ?? null} />
            </aside>
          )}
          </div>
          <DropOverlay />
          {/* Com outro painel aberto, o Resumo é o cartão flutuante, um pouco menor, encostado no painel. */}
          {summaryOpen && panelOpen && (
            <SummaryPopover width={SUMMARY_POPOVER_W} onClose={closeSummary}>
              <SummaryPane inCard conversation={active} cwd={active?.cwd ?? folder ?? projects[0]?.cwd ?? null} tabId={activeThread ? null : active?.tabId ?? null} />
            </SummaryPopover>
          )}
        </main>
      )}

      {!page && <RightPanel tabId={activeThread ? null : active?.tabId ?? null} cwd={active?.cwd ?? folder ?? projects[0]?.cwd ?? null} project={project ?? ""}
        conversation={active} cards={cards} />}
      <BrowserFloatHost hidden={!!page} />
      {!page && inboxOpen && <PermissionsInbox />}
      <PermissionsManager />
    </div>
  );
}

/** Mantém a prévia flutuante ancorada ao canto inferior direito da conversa, inclusive ao redimensionar a janela. */
function BrowserFloatHost({ hidden }: { hidden: boolean }) {
  const floating = useChatStore((s) => s.browserFloating);
  const viewId = useChatStore((s) => s.browser?.viewId ?? null);
  const measure = useCallback(() => {
    if (!floating || hidden || !viewId) return;
    const shell = document.querySelector<HTMLElement>(`[${CHAT_SHELL_ATTR}]`);
    const main = shell?.querySelector<HTMLElement>("main");
    if (!shell || !main) return;
    const shellRect = shell.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    const state = useChatStore.getState();
    const current = state.browser;
    if (!current || current.viewId !== viewId) return;
    const maxWidth = Math.max(280, mainRect.width - 24);
    const width = Math.round(Math.min(state.browserFloatRect?.width ?? Math.min(560, Math.max(320, mainRect.width * 0.48)), maxWidth));
    const maxHeight = Math.max(220, mainRect.height - 72);
    const height = Math.round(Math.min(state.browserFloatRect?.height ?? Math.min(400, Math.max(240, mainRect.height * 0.42)), maxHeight));
    setChatBrowserFloatRect({
      left: Math.round(mainRect.right - shellRect.left - width - 18),
      top: Math.round(mainRect.bottom - shellRect.top - height - 18),
      width,
      height,
    });
  }, [floating, hidden, viewId]);

  useLayoutEffect(() => {
    if (!floating || hidden || !viewId) return;
    measure();
    const shell = document.querySelector<HTMLElement>(`[${CHAT_SHELL_ATTR}]`);
    const main = shell?.querySelector<HTMLElement>("main");
    if (!shell || !main) return;
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    observer.observe(main);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [floating, hidden, measure, viewId]);

  return null;
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

