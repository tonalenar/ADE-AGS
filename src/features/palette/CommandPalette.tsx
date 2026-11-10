import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import {
  BoxIcon, ClockIcon, CloudIcon, CopyIcon, DocumentIcon, GearIcon, HomeIcon, LocationIcon, MoonIcon, NetworkIcon,
  SearchIcon, StackIcon, SunIcon, UserIcon, UsersIcon, WarningIcon, useTheme,
} from "neogestify-ui-components";

import { chatShellOn, useUiStore } from "@/app/uiStore";
import { DESKTOP_OS } from "@/app/platform";
import { newConversation, newConversationIn, newConversationLocal, newConversationWithoutProject, stopFocusedConversation } from "@/features/chat/chatActions";
import { ProjectBadge } from "@/features/chat/ChatProjectBadge";
import { useChatProjectIdentityList } from "@/features/chat/chatProjectIdentity";
import { normalizeProjectPath } from "@/features/chat/chatProjectPrefs";
import { openArchivedMessagePreview, openTeamPanelFocused, requestTabSearchJump, requestThreadSearchJump, setRightPanel, toggleDiffPanel, togglePanelMaximized, toggleRightPanel, useChatStore } from "@/features/chat/store";
import { shortcutForId, shortcutForPath } from "@/app/shortcuts";
import { useShortcutPreferences } from "@/app/shortcutPrefs";
import { GlobeIcon, PanelIcon, PullRequestIcon } from "@/app/icons";
import { agentIcon } from "@/features/agents/agentIcons";
import { useRunsStore } from "@/features/runs/store";
import { useTerminalPrefsStore } from "@/features/terminal/prefsStore";
import { TERMINAL_ZOOM } from "@/features/terminal/theme";
import { useTabsStore } from "@/features/tabs/store";
import { comparablePath } from "@/features/tabs/viewTabs";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { splitFocusedAgentGroup, useWorkspaceLayout } from "@/features/tabs/layout/layoutStore";
import { findGroup } from "@/features/tabs/layout/layoutTree";
import { activePreviewViewId, canToggleBrowserPreview, runPreviewCommand, toggleBrowserPreview } from "@/features/browser/commands";
import { isAgentModelPickerTargetMounted, isComposerCommandAvailable, isFilePickerTargetMounted, isPromptStashTargetMounted, promptStashTargetLabel, runComposerCommand, toggleAgentModelPicker, toggleFilePicker, togglePromptStash } from "@/features/chat/composerCommands";
import { useWorkspacesStore } from "@/features/workspaces/store";
import { useFocusInside } from "@/shared/ui/useFocusInside";
import { boardKeyOfTab, setWorkMode, useCanvasStore } from "@/features/canvas/store";
import { openCompareDialog } from "@/features/compare/store";
import { nextAppearanceMode, readAppearanceMode, setAppearanceMode } from "@/features/settings/appearanceMode";
import { useBotToastStore } from "@/shared/brand/botToastStore";
import { ArchiveIcon, ArrowUpIcon, DiffIcon, FolderPlusIcon, MicIcon, PaperclipIcon, PushPinIcon, SidebarIcon, StarIcon, TerminalIcon, UndoIcon, WrenchIcon } from "@/features/chat/chatIcons";
import { isFullscreenRoute } from "@/features/chat/chatSpaces";
import { activeTimelineConversationKey, findInActiveTimeline } from "@/features/chat/timeline/findModel";
import { invalidateSearchableTimeline, searchableTimeline, searchTuiConversation, type TuiMessageSearchHit } from "@/features/chat/timeline/search";
import { useChatLive } from "@/features/chat/liveStore";
import { usePendingAsks } from "@/features/chat/permissions/permissionsStore";
import { loadChatPrefs } from "@/features/chat/chatPrefs";
import { chatThreadSearch, type MessageSearchHit } from "@/features/chat/structured/ipc";
import { quickOpenFiles, type QuickOpenResult } from "@/features/search/ipc";
import { copyVisiblePullRequestNumber, isPullRequestCopyAvailable } from "@/features/forge/pullRequestCommands";
import { toggleSelectedConversationPinned } from "@/features/chat/selectedConversationCommands";
import { searchArchivedSessionMessages, type ArchivedMessageSearchHit } from "@/features/sessions/ipc.conversations";
import { settleThread, startStructured, useStructured } from "@/features/chat/structured/store";
import { folderName, threadKey } from "@/features/chat/structured/model";
import { loadChatProjectScripts } from "@/features/chat/projectScripts";
import { runStoredProjectScript } from "@/features/chat/projectScriptRunner";
import { projectScriptShortcutId } from "@/features/chat/projectScriptContext";
import { selectConversation } from "@/features/chat/unified/selectionActions";
import { useConversations, useSelectedRef } from "@/features/chat/unified/useConversations";
import { CUSTOM_THEME_CHANGED_EVENT, readThemePreferences, selectTheme } from "@/features/settings/themePreferences";
import { useShelf } from "@/features/chat/shelf";
import { canOpenWorkspaceAgent, requestWorkspaceAgent } from "@/features/tabs/workspaceCommands";
import { canToggleChatTerminal, toggleChatTerminal } from "@/features/chat/terminalCommands";
import { fileStat } from "@/features/editor/ipc";
import { listFileFavorites, normalizeFileFavoritePath, removeFileFavorite, toggleFileFavorite } from "@/features/editor/fileFavorites";
import { joinPath } from "@/features/explorer/paths";
import { showBotToast } from "@/shared/brand/botToastStore";

import { rank, type Searchable } from "./match";

type Group = "conversations" | "files" | "navigate" | "workspaces" | "actions";

interface Command extends Searchable {
  id: string;
  group: Group;
  icon: React.ReactNode;
  subtitle?: string;
  shortcut?: string;
  run: () => void;
}

const NAVIGATION_COMMAND_IDS: Record<string, string> = {
  "/": "navigation.home",
  "/sessions": "navigation.sessions",
  "/fleet": "navigation.fleet",
  "/missions": "navigation.missions",
  "/squads": "navigation.squads",
  "/forge": "navigation.forge",
  "/skills": "navigation.skills",
  "/marketplace": "navigation.marketplace",
  "/workspaces": "navigation.workspaces",
};

const GROUP_ORDER: Group[] = ["conversations", "files", "navigate", "workspaces", "actions"];

/** Tecla de atalho (kbd): mono, pastilha discreta. */
const KBD = "font-mono text-[11px] leading-4 px-1.5 py-px rounded-[5px] bg-gray-100 dark:bg-white/[0.08] text-gray-500 dark:text-white/[0.55] whitespace-nowrap";

/** O atalho que leva a uma rota, para mostrar ao lado do comando. */
function shortcutOf(path: string): string | undefined {
  return shortcutForPath(path) ?? undefined;
}

/**
 * A paleta de comandos (Ctrl+K).
 *
 * Um lugar só para ir a qualquer seção, pular para um agente aberto, abrir um workspace
 * salvo ou fazer as ações da janela — sem ter que lembrar onde cada coisa mora no riel.
 *
 * Os comandos se montam a cada abertura a partir dos stores: o que está aberto, salvo ou
 * pendente agora. A busca (ver `match.ts`) ordena por relevância; sem busca, valem a
 * ordem dos grupos e a de cada lista.
 */
export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  const { setTheme } = useTheme();
  useEffect(() => {
    const cycle = () => setAppearanceMode(nextAppearanceMode(readAppearanceMode()), setTheme);
    window.addEventListener("ade:appearance-cycle", cycle);
    return () => window.removeEventListener("ade:appearance-cycle", cycle);
  }, [setTheme]);
  if (!open) return null;
  return <PaletteDialog />;
}

function PaletteDialog() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, setTheme } = useTheme();
  const shortcutBindings = useShortcutPreferences((s) => s.bindings);
  const ui = useUiStore();
  const currentThread = useChatStore((s) => s.thread);
  const selectedConversationRef = useSelectedRef();
  const pinnedConversationIds = useShelf((s) => s.pinned);
  const conversations = useConversations();
  const chatComposing = useChatStore((s) => s.composing);
  const composeFolder = useChatStore((s) => s.composeFolder);
  const rightPanel = useChatStore((s) => s.panel);
  const rightPanelMaximized = useChatStore((s) => s.panelMaximized);
  const chatBrowser = useChatStore((s) => s.browser);
  const browserFloating = useChatStore((s) => s.browserFloating);
  const viewTabs = useViewTabsStore((s) => s.views);
  const activeViewId = useViewTabsStore((s) => s.activeViewId);
  const structuredThreads = useStructured((s) => s.threads);
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const workspaceLayout = useWorkspaceLayout();
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const projectIdentities = useChatProjectIdentityList();
  const loadWorkspaces = useWorkspacesStore((s) => s.loadWorkspaces);
  const focusIfOpen = useWorkspacesStore((s) => s.focusIfOpen);
  const focusAdjacentOpenWorkspace = useWorkspacesStore((s) => s.focusAdjacentOpenWorkspace);
  const openWorkspace = useWorkspacesStore((s) => s.openWorkspace);
  const approvals = useRunsStore((s) => s.approvals.length);
  const hasUndo = useBotToastStore((s) => s.toasts.some((toast) => toast.undoable && toast.onAction));
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const activeView = viewTabs.find((view) => view.id === activeViewId);
  const focusedLayoutGroup = workspaceLayout ? findGroup(workspaceLayout, workspaceLayout.focused) : undefined;
  const canSplitFocusedTerminal = !chatShellOn(ui)
    && location.pathname.startsWith("/workspace")
    && !!activeTab?.cwd
    && !!focusedLayoutGroup?.active?.startsWith("a:");
  const canCreateWorkspaceAgent = canOpenWorkspaceAgent(location.pathname);
  const canToggleConversationTerminal = canToggleChatTerminal(location.pathname);
  const activeTabCanRestart = useChatLive((s) => !!activeTabId
    && s.phase[activeTabId] === "idle"
    && !s.question[activeTabId]
    && !s.awaiting[activeTabId]);
  const pendingAsks = usePendingAsks();
  const canRestartActiveAgent = !!activeTab
    && activeTab.agentId !== "bash"
    && !!activeTab.sessionId
    && activeTabCanRestart
    && !pendingAsks.some((ask) => ask.conversation === activeTab.id)
    && (!ui.chatMode || ui.shellMode !== "chat" || (!currentThread && !chatComposing));
  const structuredThread = currentThread ? structuredThreads.find((thread) => thread.id === currentThread) : null;
  // A paleta só oferece ações do contexto que a pessoa está vendo. Durante um rascunho
  // usa a pasta escolhida no composer; se não houver uma, não pega scripts de outra aba.
  const projectScriptCwd = ui.chatMode && ui.shellMode === "chat"
    ? currentThread ? structuredThread?.cwd ?? null
      : chatComposing ? composeFolder ?? loadChatPrefs().cwd
        : activeTab?.cwd ?? null
    : activeTab?.cwd ?? null;
  const workspaceRoute = location.pathname === "/workspace" || location.pathname.startsWith("/workspace/");
  const favoriteRoot = !chatShellOn(ui) && workspaceRoute ? activeTab?.cwd ?? null : null;
  const activeFileView = favoriteRoot && activeView?.kind === "file"
    && comparablePath(activeView.cwd) === comparablePath(favoriteRoot) ? activeView : null;
  const activeFileFavoritePath = favoriteRoot && activeFileView
    ? normalizeFileFavoritePath(favoriteRoot, activeFileView.path)
    : null;
  const [savedFileFavorites, setSavedFileFavorites] = useState<{ root: string; paths: string[] } | null>(null);
  const favoritePaths = savedFileFavorites?.root === favoriteRoot ? savedFileFavorites.paths : [];
  const activeFileIsFavorite = !!activeFileFavoritePath && favoritePaths.includes(activeFileFavoritePath);
  const projectScripts = useMemo(() => loadChatProjectScripts(projectScriptCwd), [projectScriptCwd]);
  const canvasKey = activeTab ? boardKeyOfTab(activeTab) : null;
  const canvasOn = useCanvasStore((s) => (canvasKey ? s.modes[canvasKey] === "canvas" : false));
  const canFindConversation = activeTimelineConversationKey() !== null;
  const previewViewId = activePreviewViewId();
  const canTogglePreview = canToggleBrowserPreview();
  const projectSearchAvailable = !chatShellOn(ui) && location.pathname.startsWith("/workspace") && !!activeTab?.cwd;
  const filePickerTarget = chatComposing ? "new-conversation" : selectedConversationRef;
  const filePickerAvailable = chatShellOn(ui) && isFilePickerTargetMounted(filePickerTarget);
  const modelPickerAvailable = chatShellOn(ui) && isAgentModelPickerTargetMounted(filePickerTarget);
  const promptStashAvailable = chatShellOn(ui) && isPromptStashTargetMounted(filePickerTarget);
  const promptStashLabel = promptStashAvailable ? promptStashTargetLabel(filePickerTarget) : null;
  const composerSendAlternateAvailable = chatShellOn(ui) && isComposerCommandAvailable(filePickerTarget, "sendAlternate");
  const composerSendBackgroundAvailable = chatShellOn(ui) && isComposerCommandAvailable(filePickerTarget, "sendBackground");
  const composerSendAndNewThreadAvailable = chatShellOn(ui) && isComposerCommandAvailable(filePickerTarget, "sendAndNewThread");
  const pullRequestCopyAvailable = isPullRequestCopyAvailable();
  const selectedConversation = chatShellOn(ui) && !chatComposing && !isFullscreenRoute(location.pathname)
    ? conversations.find((conversation) => conversation.ref === selectedConversationRef) ?? null
    : null;
  const selectedConversationPinned = !!selectedConversationRef && pinnedConversationIds.includes(selectedConversationRef);

  const [query, setQuery] = useState("");
  const [themePreferences, setThemePreferences] = useState(() => readThemePreferences());
  const [messageHitsQuery, setMessageHitsQuery] = useState("");
  const actionsOnly = query.trimStart().startsWith(">");
  const actionQuery = actionsOnly ? query.trimStart().slice(1).trim() : "";
  const messageQuery = actionsOnly ? "" : query.trim();
  const searchMessages = messageQuery.replace(/\s/g, "").length >= 2;
  const [messageHits, setMessageHits] = useState<MessageSearchHit[]>([]);
  const [tuiMessageHits, setTuiMessageHits] = useState<TuiMessageSearchHit[]>([]);
  const [archivedMessageHits, setArchivedMessageHits] = useState<ArchivedMessageSearchHit[]>([]);
  const [messageSearchLoading, setMessageSearchLoading] = useState(false);
  const [quickOpenResult, setQuickOpenResult] = useState<{ root: string; query: string; result: QuickOpenResult } | null>(null);
  const [quickOpenLoading, setQuickOpenLoading] = useState(false);
  const [transcriptRevision, setTranscriptRevision] = useState(0);
  const [cursor, setCursor] = useState(0);
  const frameRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const activeSearchTabs = useRef<Set<string>>(new Set());
  useFocusInside(frameRef);
  useEffect(() => { startStructured(); }, []);

  const tuiSearchConversations = useMemo(
    () => conversations.filter((conversation) => conversation.kind === "pty" && (conversation.agentId === "claude-code" || conversation.agentId === "codex")),
    [conversations],
  );
  const projectFolders = useMemo(() => {
    const projects = new Map<string, { cwd: string; name: string }>();
    for (const conversation of conversations) {
      if (!conversation.cwd) continue;
      const key = normalizeProjectPath(conversation.cwd);
      if (projectIdentities[key]?.archived) continue;
      projects.set(key, { cwd: conversation.cwd, name: projectIdentities[key]?.name ?? folderName(conversation.cwd) });
    }
    for (const [cwd, identity] of Object.entries(projectIdentities)) {
      if (!identity.known || identity.archived) continue;
      const key = normalizeProjectPath(cwd);
      projects.set(key, { cwd, name: identity.name ?? folderName(cwd) });
    }
    return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name) || a.cwd.localeCompare(b.cwd));
  }, [conversations, projectIdentities]);

  useEffect(() => {
    activeSearchTabs.current = searchMessages
      ? new Set(tuiSearchConversations.map((conversation) => conversation.ref))
      : new Set();
  }, [searchMessages, tuiSearchConversations]);

  useEffect(() => {
    let disposed = false;
    let off: (() => void) | null = null;
    let refreshTimer: number | null = null;
    void listen<{ tabId: string }>("cc-conversation-grew", (event) => {
      invalidateSearchableTimeline(event.payload.tabId);
      if (activeSearchTabs.current.has(event.payload.tabId)) {
        if (refreshTimer !== null) window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => {
          refreshTimer = null;
          setTranscriptRevision((revision) => revision + 1);
        }, 180);
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else off = unlisten;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      off?.();
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, []);
  useEffect(() => {
    if (!favoriteRoot) {
      setSavedFileFavorites(null);
      return;
    }
    let cancelled = false;
    const stored = listFileFavorites(favoriteRoot);
    void Promise.all(stored.map(async (relative) => {
      try {
        return { relative, exists: !!(await fileStat(joinPath(favoriteRoot, relative))) };
      } catch {
        // Erro de acesso não transforma um favorito temporariamente ilegível em arquivo removido.
        return { relative, exists: null as boolean | null };
      }
    })).then((checked) => {
      if (cancelled) return;
      const missing = checked.filter((item) => item.exists === false);
      for (const item of missing) removeFileFavorite(favoriteRoot, joinPath(favoriteRoot, item.relative));
      setSavedFileFavorites({ root: favoriteRoot, paths: checked.filter((item) => item.exists !== false).map((item) => item.relative) });
    });
    return () => { cancelled = true; };
  }, [favoriteRoot]);

  useEffect(() => {
    let disposed = false;
    let offArchive: (() => void) | null = null;
    let offWorkspace: (() => void) | null = null;
    void listen<number>("cc-archived-transcript-indexed", () => {
      setTranscriptRevision((revision) => revision + 1);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else offArchive = unlisten;
    }).catch(() => undefined);
    void listen("cc-workspace-changed", () => {
      setTranscriptRevision((revision) => revision + 1);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else offWorkspace = unlisten;
    }).catch(() => undefined);
    return () => { disposed = true; offArchive?.(); offWorkspace?.(); };
  }, []);

  useEffect(() => {
    if (!searchMessages) {
      setMessageHits([]);
      setTuiMessageHits([]);
      setArchivedMessageHits([]);
      setMessageHitsQuery("");
      setMessageSearchLoading(false);
      return;
    }
    let current = true;
    setMessageHitsQuery("");
    setMessageSearchLoading(true);
    const timer = window.setTimeout(() => {
      const structuredSearch = chatThreadSearch(messageQuery, 12);
      const archivedSearch = searchArchivedSessionMessages(workspaceId, messageQuery, 12).catch(() => [] as ArchivedMessageSearchHit[]);
      const tuiSearch = Promise.all(tuiSearchConversations.map(async (conversation) => {
        const timeline = await searchableTimeline(conversation.ref);
        return timeline ? searchTuiConversation(timeline.items, messageQuery, {
          tabId: conversation.ref,
          title: conversation.title,
          agentId: conversation.agentId,
          cwd: conversation.cwd,
        }, 20) : [];
      })).then((groups) => groups.flat());
      void Promise.all([structuredSearch, tuiSearch, archivedSearch]).then(([structuredHits, tuiHits, archivedHits]) => {
        if (current) {
          setMessageHits(structuredHits);
          setTuiMessageHits(tuiHits);
          setArchivedMessageHits(archivedHits);
          setMessageHitsQuery(messageQuery);
        }
      }).catch(() => {
        if (current) {
          setMessageHits([]);
          setTuiMessageHits([]);
          setArchivedMessageHits([]);
          setMessageHitsQuery(messageQuery);
        }
      }).finally(() => {
        if (current) setMessageSearchLoading(false);
      });
    }, 180);
    return () => { current = false; window.clearTimeout(timer); };
  }, [messageQuery, searchMessages, tuiSearchConversations, transcriptRevision, workspaceId]);

  useEffect(() => {
    const root = projectScriptCwd;
    if (actionsOnly || !root || !messageQuery) {
      setQuickOpenResult(null);
      setQuickOpenLoading(false);
      return;
    }
    let current = true;
    setQuickOpenResult(null);
    setQuickOpenLoading(true);
    const timer = window.setTimeout(() => {
      void quickOpenFiles(root, messageQuery)
        .then((result) => {
          if (current && !result.cancelled) setQuickOpenResult({ root, query: messageQuery, result });
        })
        .catch(() => { if (current) setQuickOpenResult(null); })
        .finally(() => { if (current) setQuickOpenLoading(false); });
    }, 140);
    return () => { current = false; window.clearTimeout(timer); };
  }, [actionsOnly, messageQuery, projectScriptCwd]);

  const messageResultCommands = useMemo<Command[]>(() => {
    const authorLabel = (kind: "user" | "assistant") => t(kind === "user" ? "chat.sidebar.you" : "chat.sidebar.agent");
    const searchableThreads = new Map(structuredThreads.filter((thread) => !thread.isSideChat).map((thread) => [thread.id, thread] as const));
    const currentMessageHits = messageHitsQuery === messageQuery ? messageHits : [];
    const currentTuiMessageHits = messageHitsQuery === messageQuery ? tuiMessageHits : [];
    const currentArchivedMessageHits = messageHitsQuery === messageQuery ? archivedMessageHits : [];
    const structured = currentMessageHits.filter((hit) => searchableThreads.has(hit.threadId)).map((hit) => {
      const thread = searchableThreads.get(hit.threadId)!;
      const closedLabel = thread.state === "settled" ? ` · ${t("chat.sidebar.closed")}` : "";
      const Icon = agentIcon(hit.agentId, hit.agentId);
      return {
        id: `message:thread:${hit.threadId}:${hit.itemId}`,
        group: "conversations" as const,
        title: hit.excerpt,
        subtitle: `${t("palette.messageResultSubtitle", { conversation: hit.title || hit.cwd, author: authorLabel(hit.kind) })}${closedLabel}`,
        keywords: ["message", "mensagem", "thread", "conversa", hit.title, hit.cwd, hit.agentId, hit.excerpt, authorLabel(hit.kind), thread.state, messageQuery],
        icon: <Icon className={icon} />,
        run: () => {
          if (thread.state === "settled") settleThread(thread.id, false);
          requestThreadSearchJump(hit.threadId, hit.itemId);
          selectConversation(threadKey(hit.threadId));
          const state = useUiStore.getState();
          if (!state.chatMode) state.setChatMode(true);
          state.setShellMode("chat");
          navigate("/");
        },
      };
    });
    const tui = currentTuiMessageHits.map((hit) => {
      const Icon = agentIcon(hit.agentId, hit.agentId);
      return {
        id: `message:tab:${hit.tabId}:${hit.itemId}`,
        group: "conversations" as const,
        title: hit.excerpt,
        subtitle: t("palette.messageResultSubtitle", { conversation: hit.title || hit.cwd, author: authorLabel(hit.kind) }),
        keywords: ["message", "mensagem", "conversation", "conversa", hit.title, hit.cwd, hit.agentId, hit.excerpt, authorLabel(hit.kind), messageQuery],
        icon: <Icon className={icon} />,
        run: () => {
          requestTabSearchJump(hit.tabId, hit.itemId);
          selectConversation(hit.tabId);
          navigate("/workspace");
        },
      };
    });
    const archived = currentArchivedMessageHits.map((hit) => {
      const Icon = agentIcon(hit.agentId, hit.agentId);
      return {
        id: `message:archive:${hit.historyId}:${hit.turnIndex}`,
        group: "conversations" as const,
        title: hit.excerpt,
        subtitle: t("palette.archivedMessageResultSubtitle", { conversation: hit.title || hit.cwd, author: authorLabel(hit.kind) }),
        keywords: ["message", "mensagem", "archived", "arquivada", "conversation", "conversa", hit.title, hit.cwd, hit.agentId, hit.excerpt, authorLabel(hit.kind), messageQuery],
        icon: <Icon className={icon} />,
        run: () => { if (workspaceId) openArchivedMessagePreview(workspaceId, hit); },
      };
    });
    return rank([...structured, ...tui, ...archived], messageQuery).slice(0, 20);
  }, [archivedMessageHits, messageHits, messageQuery, messageHitsQuery, structuredThreads, tuiMessageHits, workspaceId, t, navigate]);

  useEffect(() => { loadWorkspaces().catch(console.error); }, [loadWorkspaces]);
  useEffect(() => { startStructured(); }, []);
  useEffect(() => {
    const refresh = () => setThemePreferences(readThemePreferences());
    window.addEventListener(CUSTOM_THEME_CHANGED_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(CUSTOM_THEME_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const close = () => ui.setPaletteOpen(false);
  const go = (path: string) => () => navigate(path);
  const icon = "w-4 h-4";

  const currentQuickOpenResult = !actionsOnly
    && quickOpenResult?.root === projectScriptCwd
    && quickOpenResult.query === messageQuery
    ? quickOpenResult.result
    : null;
  const quickOpenCommands = useMemo<Command[]>(() => currentQuickOpenResult && projectScriptCwd
    ? currentQuickOpenResult.files.map((file) => ({
      id: `file:${file.path}`,
      group: "files",
      title: file.name,
      subtitle: file.rel,
      keywords: ["file", "open file", "arquivo", "abrir arquivo", file.rel],
      icon: <DocumentIcon className={icon} />,
      run: () => useViewTabsStore.getState().openFile(projectScriptCwd, file.path),
    }))
    : [], [currentQuickOpenResult, projectScriptCwd, icon]);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];

    if (favoriteRoot) {
      for (const relative of favoritePaths) {
        const path = joinPath(favoriteRoot, relative);
        const title = relative.split("/").filter(Boolean).pop() ?? relative;
        list.push({
          id: `editor.openFavorite:${encodeURIComponent(relative)}`,
          group: "files",
          title,
          subtitle: relative,
          keywords: ["favorite", "favorites", "open favorite", "favorito", "favoritos", "abrir favorito", relative],
          icon: <StarIcon filled className="w-4 h-4 text-amber-500" />,
          run: () => {
            void fileStat(path).then((stat) => {
              if (stat) {
                useViewTabsStore.getState().openFile(favoriteRoot, path);
                return;
              }
              removeFileFavorite(favoriteRoot, path);
              showBotToast({ title: t("palette.fileFavorite.title"), text: t("palette.fileFavorite.missing", { file: relative }), tone: "info" });
            }).catch(() => {
              showBotToast({ title: t("palette.fileFavorite.title"), text: t("palette.fileFavorite.unavailable", { file: relative }), tone: "warning" });
            });
          },
        });
      }
    }

    if (favoriteRoot && activeFileView && activeFileFavoritePath) {
      list.push({
        id: "editor.favorite.toggle",
        group: "actions",
        title: t(activeFileIsFavorite ? "palette.fileFavorite.remove" : "palette.fileFavorite.add"),
        subtitle: activeFileView.path,
        keywords: ["favorite", "star", "favorito", "favoritar", "desfavoritar", activeFileView.path],
        icon: <StarIcon filled={activeFileIsFavorite} className={`w-4 h-4 ${activeFileIsFavorite ? "text-amber-500" : ""}`} />,
        run: () => {
          const result = toggleFileFavorite(favoriteRoot, activeFileView.path);
          if (!["added", "removed", "unchanged"].includes(result.status)) {
            showBotToast({ title: t("palette.fileFavorite.title"), text: t("palette.fileFavorite.saveError"), tone: "warning" });
          }
          setSavedFileFavorites({ root: favoriteRoot, paths: listFileFavorites(favoriteRoot) });
        },
      });
    }

    for (const conversation of conversations) {
      const Icon = agentIcon(conversation.agentId, conversation.agentId);
      const title = conversation.kind === "pty"
        ? conversation.title.split(" — ")[0]
        : conversation.title;
      list.push({
        id: `conversation:${conversation.ref}`,
        group: "conversations",
        title,
        subtitle: conversation.cwd,
        keywords: ["conversation", "thread", "conversa", "chat", conversation.title, conversation.agentId, conversation.cwd, conversation.teamId ?? "", conversation.role ?? ""],
        icon: <Icon className={icon} />,
        run: () => {
          selectConversation(conversation.ref);
          if (conversation.kind === "protocol") {
            const state = useUiStore.getState();
            if (!state.chatMode) state.setChatMode(true);
            useUiStore.getState().setShellMode("chat");
            navigate("/");
          } else {
            navigate("/workspace");
          }
        },
      });
    }

    if (projectScriptCwd) {
      for (const script of projectScripts) {
        list.push({
          // Os ids de script são locais ao projeto; incluir o caminho evita colisões
          // entre workspaces que tenham uma ação com o mesmo id.
          id: `script.${encodeURIComponent(projectScriptCwd)}.${script.id}.run`,
          group: "actions",
          title: script.name,
          subtitle: projectScriptCwd,
          shortcut: shortcutForId(projectScriptShortcutId(projectScriptCwd, script.id)) ?? undefined,
          keywords: ["script", "project action", "ação de projeto", "run", "executar", script.name, projectScriptCwd],
          icon: <WrenchIcon className={icon} />,
          // Lê o comando protegido, revalida e abre um PTY dedicado.
          run: () => runStoredProjectScript(projectScriptCwd, script.id, script.name),
        });
      }
    }

    if (approvals > 0) {
      list.push({
        id: "navigation.approvals",
        group: "navigate",
        title: t("palette.cmd.approvals", { count: approvals }),
        keywords: ["approval", "permission", "permissão", "aprovação"],
        icon: <WarningIcon className={`${icon} text-amber-500`} />,
        run: go("/fleet"),
      });
    }

    if (hasUndo) {
      list.push({
        id: "thread.undo",
        group: "actions",
        title: t("shortcuts.threadUndo"),
        keywords: ["undo", "desfazer", "reverter", "restore"],
        icon: <UndoIcon className={icon} />,
        shortcut: shortcutForId("thread.undo") ?? undefined,
        run: () => { useBotToastStore.getState().undoLatest(); },
      });
    }

    const sections: [string, string, React.ReactNode, string[]][] = [
      ["/", t("sidebar.home"), <HomeIcon className={icon} />, ["home", "inicio", "novo agente", "new agent"]],
      ["/sessions", t("sidebar.sessions"), <ClockIcon className={icon} />, ["sessions", "history", "histórico"]],
      ["/fleet", t("sidebar.fleet"), <NetworkIcon className={icon} />, ["fleet", "frota", "flota"]],
      ["/missions", t("sidebar.missions"), <LocationIcon className={icon} />, ["missions", "misiones"]],
      ["/squads", t("sidebar.squads"), <UsersIcon className={icon} />, ["squads", "equipes", "teams"]],
      ["/forge", t("sidebar.forge"), <PullRequestIcon className={icon} />, ["forge", "pull request", "issues", "github"]],
      ["/skills", t("sidebar.skills"), <BoxIcon className={icon} />, ["skills", "habilidades"]],
      ["/marketplace", t("sidebar.marketplace"), <CloudIcon className={icon} />, ["marketplace", "loja"]],
      ["/workspaces", t("rail.workspaces"), <StackIcon className={icon} />, ["workspaces"]],
    ];
    for (const [path, title, el, keywords] of sections) {
      list.push({ id: NAVIGATION_COMMAND_IDS[path] ?? `navigation:${path.slice(1)}`, group: "navigate", title, keywords, icon: el, shortcut: shortcutOf(path), run: go(path) });
    }

    for (const ws of [...workspaces].sort((a, b) => b.lastActive - a.lastActive)) {
      list.push({
        id: `workspace:${ws.id}`,
        group: "workspaces",
        title: ws.name,
        subtitle: t("palette.workspaceMeta", { count: ws.tabCount }),
        keywords: ["workspace"],
        icon: <StackIcon className={icon} />,
        // Já aberto em outra janela: só a traz para frente. Senão abre ao lado, sem fechar
        // nada — fechar o que está aberto é decisão do diálogo da tela de Workspaces.
        run: () => {
          focusIfOpen(ws.id)
            .then((focused) => (focused ? undefined : openWorkspace(ws.id, false)))
            .catch(console.error);
        },
      });
    }

    if (workspaces.filter((workspace) => workspace.windowCount > 0).length > 1) {
      list.push(
        {
          id: "workspace.focusNext",
          group: "workspaces",
          title: t("shortcuts.workspaceFocusNext"),
          keywords: ["workspace", "next", "focus", "próximo", "foco", "janela"],
          icon: <StackIcon className={icon} />,
          shortcut: shortcutForId("workspace.focusNext") ?? undefined,
          run: () => { void focusAdjacentOpenWorkspace(1).catch(console.error); },
        },
        {
          id: "workspace.focusPrevious",
          group: "workspaces",
          title: t("shortcuts.workspaceFocusPrevious"),
          keywords: ["workspace", "previous", "focus", "anterior", "foco", "janela"],
          icon: <StackIcon className={icon} />,
          shortcut: shortcutForId("workspace.focusPrevious") ?? undefined,
          run: () => { void focusAdjacentOpenWorkspace(-1).catch(console.error); },
        },
      );
    }

    if (canSplitFocusedTerminal) {
      list.push(
        {
          id: "terminal.splitRight",
          group: "actions",
          title: t("shortcuts.terminalSplitRight"),
          keywords: ["terminal", "split", "pane", "right", "direita", "dividir"],
          icon: <TerminalIcon className={icon} />,
          shortcut: shortcutForId("terminal.splitRight") ?? undefined,
          run: () => splitFocusedAgentGroup("right"),
        },
        {
          id: "terminal.splitDown",
          group: "actions",
          title: t("shortcuts.terminalSplitDown"),
          keywords: ["terminal", "split", "pane", "down", "abaixo", "dividir"],
          icon: <TerminalIcon className={icon} />,
          shortcut: shortcutForId("terminal.splitDown") ?? undefined,
          run: () => splitFocusedAgentGroup("down"),
        },
      );
    }

    if (canCreateWorkspaceAgent) {
      list.push({
        id: "terminal.new",
        group: "actions",
        title: t("shortcuts.terminalNew"),
        keywords: ["terminal", "new", "agent", "session", "novo terminal", "novo agente", "nova sessão"],
        icon: <TerminalIcon className={icon} />,
        shortcut: shortcutForId("terminal.new") ?? undefined,
        run: () => { requestWorkspaceAgent(location.pathname); },
      });
    }

    if (selectedConversation) {
      list.push({
        id: "thread.pin",
        group: "actions",
        title: t(selectedConversationPinned ? "chat.sidebar.unpin" : "chat.sidebar.pin"),
        subtitle: selectedConversation.title,
        keywords: ["pin", "unpin", "conversation", "thread", "fixar", "desafixar", "conversa", "thread.pin"],
        icon: <PushPinIcon className={icon} />,
        shortcut: shortcutForId("thread.pin") ?? undefined,
        run: () => { toggleSelectedConversationPinned(); },
      });
    }

    if (pullRequestCopyAvailable) {
      list.push({
        id: "pullRequest.copyNumber",
        group: "actions",
        title: t("forge.pr.copyNumber"),
        keywords: ["copy pull request number", "copy pr number", "copiar número do pull request", "copiar número do pr"],
        icon: <CopyIcon className={icon} />,
        shortcut: shortcutForId("pullRequest.copyNumber") ?? undefined,
        run: () => { copyVisiblePullRequestNumber(); },
      });
    }

    if (ui.chatMode) {
      list.push({
        id: "chat.mode.toggle",
        group: "actions",
        title: t("chat.mode.toggle"),
        keywords: ["chat", "workspace", "tabs", "canvas", "modo chat", "alternar modo"],
        icon: <PanelIcon className={icon} />,
        shortcut: shortcutForId("chat.toggle") ?? undefined,
        run: () => {
          const { shellMode, setShellMode } = useUiStore.getState();
          setShellMode(shellMode === "chat" ? "workspace" : "chat");
          if (shellMode === "chat" && useTabsStore.getState().tabs.length > 0) navigate("/workspace");
        },
      });
      list.push({
        id: "chat.addProject",
        group: "actions",
        title: t("chat.sidebar.addProject"),
        keywords: ["add project", "choose folder", "adicionar projeto", "escolher pasta", "nova pasta"],
        icon: <FolderPlusIcon className={icon} />,
        run: () => window.dispatchEvent(new Event("ade:chat-add-project")),
      });
      list.push({
        id: "chat.new",
        group: "actions",
        title: t("chat.new.title"),
        keywords: ["new conversation", "new thread", "nova conversa", "novo chat"],
        icon: <HomeIcon className={icon} />,
        shortcut: shortcutForId("chat.new") ?? undefined,
        run: () => {
          useUiStore.getState().setShellMode("chat");
          newConversation();
          navigate("/");
        },
      });
      list.push({
        id: "chat.newWithoutProject",
        group: "actions",
        title: t("shortcuts.chatNewWithoutProject"),
        keywords: ["new conversation", "without project", "nova conversa", "sem projeto"],
        icon: <HomeIcon className={icon} />,
        shortcut: shortcutForId("chat.newWithoutProject") ?? undefined,
        run: () => {
          useUiStore.getState().setShellMode("chat");
          newConversationWithoutProject();
          navigate("/");
        },
      });
      list.push({
        id: "chat.newLocal",
        group: "actions",
        title: t("shortcuts.chatNewLocal"),
        keywords: ["new conversation", "current project", "current folder", "nova conversa", "projeto atual", "pasta atual"],
        icon: <HomeIcon className={icon} />,
        shortcut: shortcutForId("chat.newLocal") ?? undefined,
        run: () => {
          useUiStore.getState().setShellMode("chat");
          newConversationLocal();
          navigate("/");
        },
      });
      for (const { cwd, name: project } of projectFolders) {
        list.push({
          id: `chat.newInProject.${encodeURIComponent(cwd)}`,
          group: "actions",
          title: t("palette.cmd.newInProject", { project }),
          subtitle: cwd,
          keywords: ["new conversation", "new thread", "project", "nova conversa", "novo chat", "projeto", project, cwd],
          icon: <ProjectBadge name={project} cwd={cwd} size="sm" />,
          run: () => {
            useUiStore.getState().setShellMode("chat");
            newConversationIn(cwd);
            navigate("/");
          },
        });
      }
      list.push({
        id: "thread.stop",
        group: "actions",
        title: t("shortcuts.threadStop"),
        keywords: ["stop", "interrupt", "parar", "interromper", "turno"],
        icon: <WarningIcon className={`${icon} text-red-500`} />,
        shortcut: shortcutForId("thread.stop") ?? undefined,
        run: () => { stopFocusedConversation(); },
      });
      if (canRestartActiveAgent && activeTab) {
        list.push({
          id: "agent.restartSession",
          group: "actions",
          title: t("palette.cmd.restartAgentSession"),
          keywords: ["restart", "reset process", "session", "reiniciar", "sessão", activeTab.agentLabel],
          icon: <TerminalIcon className={icon} />,
          run: () => { useTabsStore.getState().restartAgent(activeTab.id); },
        });
      }
      if (canFindConversation) {
        list.push({
          id: "chat.find",
          group: "actions",
          title: t("shortcuts.chatFind"),
          keywords: ["find", "search", "messages", "conversation", "buscar", "pesquisar", "mensagens", "conversa"],
          icon: <SearchIcon className={icon} />,
          shortcut: shortcutForId("chat.find") ?? undefined,
          run: () => { findInActiveTimeline(); },
        });
      }
    }

    if (projectSearchAvailable) {
      list.push({
        id: "projectSearch.toggle",
        group: "actions",
        title: t("shortcuts.projectSearchToggle"),
        keywords: ["project search", "search files", "contents", "busca no projeto", "buscar arquivos", "conteúdo"],
        icon: <SearchIcon className={icon} />,
        shortcut: shortcutForId("projectSearch.toggle") ?? undefined,
        run: () => useUiStore.getState().openDrawer("search"),
      });
    }
    if (filePickerAvailable) {
      list.push({
        id: "filePicker.toggle",
        group: "actions",
        title: t("shortcuts.filePickerToggle"),
        keywords: ["attach", "attachment", "file picker", "anexar", "anexo", "arquivo"],
        icon: <PaperclipIcon className={icon} />,
        shortcut: shortcutForId("filePicker.toggle") ?? undefined,
        run: () => { if (isFilePickerTargetMounted(filePickerTarget)) toggleFilePicker(filePickerTarget); },
      });
    }
    if (modelPickerAvailable) {
      list.push({
        id: "modelPicker.toggle",
        group: "actions",
        title: t("shortcuts.modelPickerToggle"),
        keywords: ["agent", "model", "provider", "reasoning", "effort", "agente", "modelo", "provedor", "raciocínio", "esforço"],
        icon: <UsersIcon className={icon} />,
        shortcut: shortcutForId("modelPicker.toggle") ?? undefined,
        run: () => { if (isAgentModelPickerTargetMounted(filePickerTarget)) toggleAgentModelPicker(filePickerTarget); },
      });
    }
    if (promptStashAvailable) {
      list.push({
        id: "composer.stash",
        group: "actions",
        title: promptStashLabel ?? t("shortcuts.composerStash"),
        keywords: ["stash", "save prompt", "restore prompt", "rascunho", "guardar prompt", "restaurar prompt", "composer.stash"],
        icon: <ArchiveIcon className={icon} />,
        shortcut: shortcutForId("composer.stash") ?? undefined,
        run: () => { if (isPromptStashTargetMounted(filePickerTarget)) togglePromptStash(filePickerTarget); },
      });
    }
    if (composerSendAlternateAvailable) {
      list.push({
        id: "composer.sendAlternate",
        group: "actions",
        title: t("shortcuts.composerSendAlternate"),
        keywords: ["send alternate", "queue", "steer", "send now", "envio alternativo", "fila", "direcionar", "enviar agora", "composer.sendAlternate"],
        icon: <ArrowUpIcon className={icon} />,
        shortcut: shortcutForId("composer.sendAlternate") ?? undefined,
        run: () => { if (isComposerCommandAvailable(filePickerTarget, "sendAlternate")) runComposerCommand(filePickerTarget, "sendAlternate"); },
      });
    }
    if (composerSendBackgroundAvailable) {
      list.push({
        id: "composer.sendBackground",
        group: "actions",
        title: t("shortcuts.composerSendBackground"),
        keywords: ["send background", "start in background", "new draft", "segundo plano", "novo rascunho", "composer.sendBackground"],
        icon: <CloudIcon className={icon} />,
        shortcut: shortcutForId("composer.sendBackground") ?? undefined,
        run: () => { if (isComposerCommandAvailable(filePickerTarget, "sendBackground")) runComposerCommand(filePickerTarget, "sendBackground"); },
      });
    }
    if (composerSendAndNewThreadAvailable) {
      list.push({
        id: "composer.sendAndNewThread",
        group: "actions",
        title: t("shortcuts.composerSendAndNewThread"),
        keywords: ["send and new thread", "new conversation", "new thread", "enviar e nova conversa", "enviar e novo chat", "composer.sendAndNewThread"],
        icon: <HomeIcon className={icon} />,
        shortcut: shortcutForId("composer.sendAndNewThread") ?? undefined,
        run: () => { if (isComposerCommandAvailable(filePickerTarget, "sendAndNewThread")) runComposerCommand(filePickerTarget, "sendAndNewThread"); },
      });
    }

    const openThemeSettings = () => {
      const state = useUiStore.getState();
      state.setSettingsSection("appearance");
      if (!location.pathname.startsWith("/settings")) state.setSettingsOpen(true);
    };
    const toggleThemeEditor = () => {
      const state = useUiStore.getState();
      if (location.pathname.startsWith("/settings") && state.settingsSection === "appearance") {
        navigate(tabs.length > 0 ? "/workspace" : "/");
        return;
      }
      openThemeSettings();
    };
    list.push(
      {
        id: "theme.select",
        group: "actions",
        title: t("shortcuts.themeSelect"),
        keywords: ["theme", "appearance", "select theme", "tema", "aparência", "selecionar tema"],
        icon: <SunIcon className={icon} />,
        shortcut: shortcutForId("theme.select") ?? undefined,
        run: openThemeSettings,
      },
      {
        id: "appearance.cycle",
        group: "actions",
        title: t("shortcuts.appearanceCycle"),
        keywords: ["theme", "appearance", "cycle", "system", "light", "dark", "alternar aparência", "sistema", "claro", "escuro"],
        icon: <MoonIcon className={icon} />,
        shortcut: shortcutForId("appearance.cycle") ?? undefined,
        run: () => setAppearanceMode(nextAppearanceMode(readAppearanceMode()), setTheme),
      },
      {
        id: "themeEditor.toggle",
        group: "actions",
        title: t("shortcuts.themeEditorToggle"),
        keywords: ["theme editor", "custom theme", "colors", "editor de tema", "tema personalizado", "cores"],
        icon: <SunIcon className={icon} />,
        shortcut: shortcutForId("themeEditor.toggle") ?? undefined,
        run: toggleThemeEditor,
      },
    );

    if (ui.chatMode && ui.shellMode === "chat") {
      if (!isFullscreenRoute(location.pathname)) {
        list.push({
          id: "sidebar.toggle",
          group: "actions",
          title: t("shortcuts.toggleChatSidebar"),
          keywords: ["sidebar", "navigation", "hide sidebar", "show sidebar", "barra lateral", "ocultar barra lateral", "mostrar barra lateral"],
          icon: <SidebarIcon className={icon} />,
          shortcut: shortcutForId("sidebar.toggle") ?? undefined,
          run: () => window.dispatchEvent(new Event("ade:chat-sidebar-toggle")),
        });
      }
      list.push({
        id: "rightPanel.toggle",
        group: "actions",
        title: t("shortcuts.toggleRightPanel"),
        keywords: ["right panel", "side panel", "toggle panel", "painel direito", "alternar painel"],
        icon: <PanelIcon className={icon} />,
        shortcut: shortcutForId("rightPanel.toggle") ?? undefined,
        run: toggleRightPanel,
      });
      if (canToggleConversationTerminal) {
        list.push({
          id: "terminal.toggle",
          group: "actions",
          title: t("shortcuts.terminalToggle"),
          keywords: ["terminal", "toggle", "shell", "drawer", "alternar terminal", "terminal da conversa"],
          icon: <TerminalIcon className={icon} />,
          shortcut: shortcutForId("terminal.toggle") ?? undefined,
          run: () => { toggleChatTerminal(location.pathname); },
        });
      }
      if (rightPanel !== null) {
        list.push(
          {
            id: "rightPanel.close",
            group: "actions",
            title: t("shortcuts.closeRightPanel"),
            keywords: ["close panel", "hide panel", "fechar painel", "ocultar painel"],
            icon: <PanelIcon className={`${icon} -scale-x-100`} />,
            shortcut: shortcutForId("rightPanel.close") ?? undefined,
            run: () => setRightPanel(null),
          },
          {
            id: "rightPanel.toggleMaximized",
            group: "actions",
            title: rightPanelMaximized ? t("shortcuts.restoreRightPanel") : t("shortcuts.maximizeRightPanel"),
            keywords: ["maximize panel", "restore panel", "expand panel", "maximizar painel", "restaurar painel", "expandir painel"],
            icon: <PanelIcon className={icon} />,
            shortcut: shortcutForId("rightPanel.toggleMaximized") ?? undefined,
            run: togglePanelMaximized,
          },
        );
      }
      list.push({
        id: "rightPanel.new",
        group: "actions",
        title: t("shortcuts.panelNewSurface"),
        keywords: ["new surface", "right panel", "browser", "terminal", "files", "nova superfície", "painel direito"],
        icon: <PanelIcon className={icon} />,
        shortcut: shortcutForId("rightPanel.new") ?? undefined,
        run: () => setRightPanel("empty"),
      });
      list.push({
        id: "diff.toggle",
        group: "actions",
        title: t("shortcuts.diffToggle"),
        keywords: ["diff", "changes", "patch", "alterações", "mudanças", "diferenças"],
        icon: <DiffIcon className={icon} />,
        shortcut: shortcutForId("diff.toggle") ?? undefined,
        run: toggleDiffPanel,
      });
      list.push({
        id: "chat.teamPanel",
        group: "actions",
        title: t("chat.team.shortcut"),
        keywords: ["team", "squad", "orchestrator", "time", "equipe", "orquestrador"],
        icon: <UsersIcon className={icon} />,
        shortcut: shortcutForId("chat.teamPanel") ?? undefined,
        run: openTeamPanelFocused,
      });
      const voiceUnavailable = DESKTOP_OS === "windows"
        ? t("voiceInput.unavailable.windows")
        : DESKTOP_OS === "linux"
          ? t("voiceInput.unavailable.linux")
          : undefined;
      list.push({
        id: "voiceInput.toggle",
        group: "actions",
        title: t("shortcuts.dictation"),
        subtitle: voiceUnavailable,
        keywords: ["dictation", "voice input", "microphone", "ditado", "voz", "microfone"],
        icon: <MicIcon className={icon} />,
        shortcut: shortcutForId("composer.dictation") ?? undefined,
        run: () => window.dispatchEvent(new Event("ade:voice-input-toggle")),
      });
    }

    if (canTogglePreview) {
      list.push({
        id: "preview.toggle",
        group: "actions",
        title: t("shortcuts.previewToggle"),
        keywords: ["browser", "preview", "web", "navegador", "prévia", "visualização"],
        icon: <GlobeIcon className={icon} />,
        shortcut: shortcutForId("preview.toggle") ?? undefined,
        run: toggleBrowserPreview,
      });
    }
    if (previewViewId) {
      const previewCommands = [
        ["preview.refresh", "shortcuts.previewRefresh", ["browser", "reload", "refresh", "recarregar", "atualizar"], "refresh"],
        ["preview.focusUrl", "shortcuts.previewFocusUrl", ["browser", "url", "address", "focus", "endereço", "focar"], "focusUrl"],
        ["preview.zoomIn", "shortcuts.previewZoomIn", ["browser", "zoom", "in", "aumentar", "aproximar"], "zoomIn"],
        ["preview.zoomOut", "shortcuts.previewZoomOut", ["browser", "zoom", "out", "diminuir", "afastar"], "zoomOut"],
        ["preview.resetZoom", "shortcuts.previewResetZoom", ["browser", "zoom", "reset", "restaurar", "100%"], "resetZoom"],
      ] as const;
      list.push(...previewCommands.map(([id, label, keywords, command]) => ({
        id,
        group: "actions" as const,
        title: t(label),
        keywords: [...keywords],
        icon: <GlobeIcon className={icon} />,
        shortcut: shortcutForId(id) ?? undefined,
        run: () => { runPreviewCommand(command); },
      })));
    }

    const adjustTextZoom = (delta: -1 | 0 | 1) => {
      const state = useTerminalPrefsStore.getState();
      state.setZoom(delta === 0 ? TERMINAL_ZOOM.default : state.zoom + delta * TERMINAL_ZOOM.step);
    };
    list.push(
      {
        id: "text.zoom.in",
        group: "actions",
        title: t("palette.cmd.zoomIn"),
        keywords: ["zoom", "text size", "font size", "aumentar", "texto", "fonte"],
        icon: <TerminalIcon className={icon} />,
        shortcut: shortcutForId("zoom.in.equals") ?? undefined,
        run: () => adjustTextZoom(1),
      },
      {
        id: "text.zoom.out",
        group: "actions",
        title: t("palette.cmd.zoomOut"),
        keywords: ["zoom", "text size", "font size", "diminuir", "texto", "fonte"],
        icon: <TerminalIcon className={icon} />,
        shortcut: shortcutForId("zoom.out") ?? undefined,
        run: () => adjustTextZoom(-1),
      },
      {
        id: "text.zoom.reset",
        group: "actions",
        title: t("palette.cmd.zoomReset"),
        keywords: ["zoom", "text size", "font size", "reset", "normal", "texto", "fonte"],
        icon: <TerminalIcon className={icon} />,
        shortcut: shortcutForId("zoom.reset") ?? undefined,
        run: () => adjustTextZoom(0),
      },
    );

    list.push(
      {
        id: "navigation.back",
        group: "actions",
        title: t("palette.cmd.back"),
        keywords: ["back", "previous page", "voltar", "página anterior"],
        icon: <LocationIcon className={icon} />,
        shortcut: shortcutForId("navigation.back") ?? undefined,
        run: () => navigate(-1),
      },
      {
        id: "navigation.forward",
        group: "actions",
        title: t("palette.cmd.forward"),
        keywords: ["forward", "next page", "avançar", "próxima página"],
        icon: <LocationIcon className={`${icon} -scale-x-100`} />,
        shortcut: shortcutForId("navigation.forward") ?? undefined,
        run: () => navigate(1),
      },
    );

    if (canvasKey) {
      list.push({
        id: "workspace.view.toggle",
        group: "actions",
        title: canvasOn ? t("palette.cmd.tabsMode") : t("palette.cmd.canvas"),
        keywords: ["canvas", "abas", "tabs", "nodes", "conectar", "connect"],
        icon: <StackIcon className={icon} />,
        run: () => { setWorkMode(canvasKey, canvasOn ? "tabs" : "canvas"); navigate("/workspace"); },
      });
    }

    list.push(
      {
        id: "appearance.theme.default",
        group: "actions",
        title: t("palette.cmd.useDefaultTheme"),
        subtitle: themePreferences.activeThemeId === null ? t("palette.current") : undefined,
        keywords: ["theme", "tema", "default theme", "tema padrão", "reset theme", "restaurar tema", "appearance", "aparência"],
        icon: <SunIcon className={icon} />,
        run: () => { selectTheme(null); },
      },
      ...themePreferences.themes.map((theme) => ({
        id: `appearance.theme.custom.${theme.id}`,
        group: "actions" as const,
        title: theme.name,
        subtitle: themePreferences.activeThemeId === theme.id ? t("palette.current") : t("palette.cmd.activateTheme"),
        keywords: ["theme", "tema", "custom theme", "tema personalizado", "appearance", "aparência", theme.name],
        icon: <SunIcon className={icon} />,
        run: () => { selectTheme(theme.id); },
      })),
      {
        id: "compare.models",
        group: "actions",
        title: t("compare.paletteCmd"),
        keywords: ["compare", "comparar", "modelos", "models", "worktree", "multi"],
        icon: <StackIcon className={icon} />,
        run: () => { openCompareDialog(activeTab?.cwd ?? ""); },
      },
      {
        id: "appearance.theme.toggle",
        group: "actions",
        title: theme === "dark" ? t("palette.cmd.lightTheme") : t("palette.cmd.darkTheme"),
        keywords: ["theme", "tema", "dark", "light", "escuro", "claro"],
        icon: theme === "dark" ? <SunIcon className={icon} /> : <MoonIcon className={icon} />,
        run: () => setAppearanceMode(theme === "dark" ? "light" : "dark", setTheme),
      },
      {
        id: "appearance.theme.system",
        group: "actions",
        title: t("palette.cmd.systemTheme"),
        keywords: ["theme", "tema", "system", "sistema", "appearance", "aparência"],
        icon: <MoonIcon className={icon} />,
        run: () => setAppearanceMode("system", setTheme),
      },
      {
        id: "panel.workspaces.toggle",
        group: "actions",
        title: ui.workspacesCollapsed ? t("palette.cmd.showWorkspaces") : t("palette.cmd.hideWorkspaces"),
        keywords: ["panel", "painel", "sidebar"],
        icon: <PanelIcon className={icon} />,
        run: ui.toggleWorkspaces,
      },
      {
        id: "panel.context.toggle",
        group: "actions",
        title: ui.sidePanelHidden ? t("palette.cmd.showSidePanel") : t("palette.cmd.hideSidePanel"),
        keywords: ["panel", "painel", "context", "contexto", "pr", "tarefas"],
        icon: <PanelIcon className={`${icon} -scale-x-100`} />,
        run: ui.toggleSidePanel,
      },
      {
        id: "panel.files.open",
        group: "actions",
        title: t("palette.cmd.files"),
        keywords: ["explorer", "files", "arquivos", "árvore"],
        icon: <PanelIcon className={`${icon} -scale-x-100`} />,
        run: () => ui.openDrawer("files"),
      },
      {
        id: "navigation.rail.toggle",
        group: "actions",
        title: ui.railExpanded ? t("rail.collapse") : t("rail.expand"),
        keywords: ["rail", "riel", "menu", "labels", "rótulos"],
        icon: <PanelIcon className={icon} />,
        run: ui.toggleRail,
      },
      {
        id: "accounts.open",
        group: "actions",
        title: t("settings.accounts"),
        keywords: ["accounts", "login", "contas", "cuentas", "quota", "cota"],
        icon: <UserIcon className={icon} />,
        run: () => ui.setAccountsOpen(true),
      },
      {
        id: "settings.open",
        group: "actions",
        title: t("sidebar.settings"),
        keywords: ["settings", "preferences", "configurações", "preferências"],
        icon: <GearIcon className={icon} />,
        shortcut: shortcutForId("settings.open") ?? undefined,
        run: () => ui.setSettingsOpen(true),
      },
    );

    return [...list, ...quickOpenCommands, ...messageResultCommands];
    // `ui` muda de identidade a cada render do store; os campos usados estão listados.
  }, [conversations, activeTab, tabs.length, canRestartActiveAgent, canSplitFocusedTerminal, canCreateWorkspaceAgent, canToggleConversationTerminal, favoriteRoot, favoritePaths, activeFileView, activeFileFavoritePath, activeFileIsFavorite, approvals, hasUndo, workspaces, focusAdjacentOpenWorkspace, themePreferences, theme, setTheme, canvasKey, canvasOn, projectScriptCwd, projectScripts, projectFolders, messageResultCommands, quickOpenCommands, pullRequestCopyAvailable, selectedConversation, selectedConversationPinned, ui.workspacesCollapsed, ui.sidePanelHidden, ui.railExpanded, ui.chatMode, ui.shellMode, currentThread, chatComposing, rightPanel, rightPanelMaximized, chatBrowser, browserFloating, viewTabs, activeViewId, previewViewId, canTogglePreview, projectSearchAvailable, filePickerAvailable, filePickerTarget, modelPickerAvailable, promptStashAvailable, promptStashLabel, composerSendAlternateAvailable, composerSendBackgroundAvailable, composerSendAndNewThreadAvailable, location.pathname, shortcutBindings, t, navigate]);

  // `>` limita a paleta a ações da ADE; a busca normal continua incluindo agentes e pastas.
  // Sem busca, os grupos ficam na ordem fixa. Com busca, uma lista só por relevância.
  const results = useMemo(() => {
    if (actionsOnly) {
      const actions = commands.filter((command) => command.group === "actions");
      return actionQuery ? rank(actions, actionQuery) : actions;
    }
    if (query.trim()) return rank(commands, query.trim());
    return GROUP_ORDER.flatMap((g) => commands.filter((c) => c.group === g));
  }, [commands, query, actionsOnly, actionQuery]);

  useEffect(() => { setCursor(0); }, [query]);
  // A lista pode encolher sem a busca mudar (uma aba fecha, uma aprovação some): o cursor não fica no vazio.
  useEffect(() => { setCursor((c) => (c >= results.length ? Math.max(0, results.length - 1) : c)); }, [results.length]);

  // A linha sob o cursor sempre visível, também navegando pelo teclado.
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const runAt = (index: number) => {
    const cmd = results[index];
    if (!cmd) return;
    close();
    cmd.run();
  };

  useEffect(() => {
    const onQuickSelect = (event: Event) => {
      const quick = event as CustomEvent<{ kind?: string; index?: number }>;
      if (quick.detail?.kind !== "palette") return;
      const index = quick.detail.index;
      if (!Number.isInteger(index) || index! < 1 || index! > 9) return;
      const command = results[index! - 1];
      if (!command) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      useUiStore.getState().setPaletteOpen(false);
      command.run();
    };
    window.addEventListener("ade:chat-quick-select", onQuickSelect);
    return () => window.removeEventListener("ade:chat-quick-select", onQuickSelect);
  }, [results]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (results.length ? (c + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (results.length ? (c - 1 + results.length) % results.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(cursor);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const grouped = !query.trim() && !actionsOnly;

  return (
    <div className="fixed inset-0 z-110 flex justify-center items-start pt-[12vh] px-4">
      <div className="cc-fade absolute inset-0 bg-gray-900/30 dark:bg-black/55" onMouseDown={close} />

      <div
        ref={frameRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.open")}
        onKeyDown={onKeyDown}
        className="cc-pop relative w-full max-w-[560px] flex flex-col max-h-[60vh] overflow-hidden
          rounded-xl border border-black/[0.08] dark:border-white/[0.08]
          bg-white/90 dark:bg-surface-raised/75 backdrop-blur-[30px] backdrop-saturate-[180%]
          shadow-[0_0_0_0.5px_rgba(255,255,255,0.08),0_10px_30px_rgba(0,0,0,0.45),0_2px_6px_rgba(0,0,0,0.3)]"
      >
        <div className="flex items-center gap-3 h-14 px-[18px] shrink-0 border-b border-black/[0.08] dark:border-white/[0.08]">
          <SearchIcon className="w-[18px] h-[18px] shrink-0 text-gray-500 dark:text-white/55" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t(actionsOnly ? "palette.placeholderActions" : "palette.placeholder")}
            placeholder={t(actionsOnly ? "palette.placeholderActions" : "palette.placeholder")}
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent outline-none text-[18px] leading-6
              text-gray-900 dark:text-gray-50 placeholder:text-gray-400 dark:placeholder:text-white/30"
          />
          <kbd className={KBD}>Esc</kbd>
        </div>

        <div ref={listRef} className="cc-scroll flex-1 min-h-0 py-2" role="listbox">
          {messageSearchLoading && (
            <p role="status" className="px-4 py-2 text-[12px] text-gray-400 dark:text-white/35">
              {t("palette.searchingMessages")}
            </p>
          )}
          {quickOpenLoading && (
            <p role="status" className="px-4 py-2 text-[12px] text-gray-400 dark:text-white/35">
              {t("palette.searchingFiles")}
            </p>
          )}
          {currentQuickOpenResult?.truncated && !quickOpenLoading && (
            <p role="status" className="px-4 py-2 text-[11px] text-gray-400 dark:text-white/35">
              {t("palette.filesTruncated")}
            </p>
          )}
          {results.length === 0 && !messageSearchLoading && !quickOpenLoading && (
            <p className="px-4 py-8 text-center text-sm text-gray-400 dark:text-white/35">
              {t("palette.empty")}
            </p>
          )}

          {results.map((cmd, index) => {
            const header = grouped && (index === 0 || results[index - 1].group !== cmd.group);
            const selected = index === cursor;
            return (
              <div key={cmd.id}>
                {header && (
                  <div className="px-[18px] pt-2.5 pb-1 text-[11px] leading-[14px] uppercase tracking-[0.06em]
                    text-gray-500 dark:text-white/[0.32]">
                    {t(`palette.group.${cmd.group}`)}
                  </div>
                )}
                <div
                  role="option"
                  aria-selected={selected}
                  data-index={index}
                  data-command-id={cmd.id}
                  onMouseMove={() => { if (!selected) setCursor(index); }}
                  onClick={() => runAt(index)}
                  className={`mx-1.5 flex items-center gap-2.5 h-9 px-3 rounded-md cursor-pointer
                    ${selected
                      ? "bg-accent-500/15 text-gray-900 dark:bg-accent-500/20 dark:text-white"
                      : "text-gray-700 dark:text-gray-300"}`}
                >
                  <span className={`shrink-0 flex ${selected ? "text-accent-600 dark:text-accent-400" : "text-gray-500 dark:text-white/50"}`}>{cmd.icon}</span>
                  <span className="truncate text-[13px]" title={cmd.title}>{cmd.title}</span>
                  {cmd.id === `conversation:${selectedConversationRef}` && (
                    <span className="shrink-0 text-[11px] text-gray-400 dark:text-white/30">{t("palette.current")}</span>
                  )}
                  {cmd.subtitle && (
                    <span className="truncate text-[11px] font-mono text-gray-400 dark:text-white/30" title={cmd.subtitle}>{cmd.subtitle}</span>
                  )}
                  {cmd.shortcut && (
                    <span className="ml-auto shrink-0 font-mono text-[12px] tabular-nums text-gray-400 dark:text-white/[0.45]">
                      {cmd.shortcut}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-4 h-9 px-4 shrink-0 border-t border-black/[0.08] dark:border-white/[0.08]
          text-[12px] leading-4 text-gray-500 dark:text-white/[0.45]">
          <span className="flex items-center gap-1.5"><kbd className={KBD}>↑↓</kbd>{t("palette.hint.move")}</span>
          <span className="flex items-center gap-1.5"><kbd className={KBD}>↵</kbd>{t("palette.hint.run")}</span>
        </div>
      </div>
    </div>
  );
}
