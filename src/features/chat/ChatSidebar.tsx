import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";

import { WindowLights } from "@/app/WindowLights";
import { useUiStore } from "@/app/uiStore";
import { agentIcon } from "@/features/agents/agentIcons";
import { useTabsStore } from "@/features/tabs/store";
import { SkillPalette, type SkillScopeTarget } from "@/features/skills/SkillPalette";
import { showBotToast } from "@/shared/brand/botToastStore";
import { homeDir } from "@/shared/ipc/window";
import { ContextMenu, type ContextMenuItem } from "@/shared/ui/ContextMenu";
import { ProjectBadge } from "./ChatProjectBadge";
import { ChatProjectIconDialog } from "./ChatProjectIconDialog";
import { forgetChatProjectIdentity, setChatProjectIdentity, useChatProjectIdentityList } from "./chatProjectIdentity";
import { normalizeProjectPath } from "./chatProjectPrefs";

import { newConversation, newConversationIn } from "./chatActions";
import { addQuoteFor } from "./quotes/quoteStore";
import { selectConversation } from "./unified/selectionActions";
import { ArchiveIcon, BotIcon, BranchIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, ClockIcon, DesignIcon, EyeIcon, FilterIcon, FolderPlusIcon, GlobeIcon, ListIcon, MoreHorizontalIcon, NewChatIcon, PenIcon, PlusIcon, PullRequestIcon, PushPinIcon, SearchIcon, SettingsIcon, SidebarIcon, UndoIcon, UsageIcon, UsersIcon, WarnIcon, WrenchIcon, XIcon } from "./chatIcons";
import { type ChatProject, type ConversationCard } from "./chatModel";
import { useLiveSummary } from "./liveSummary";
import { useChatLive } from "./liveStore";
import { INBOX_SHORTCUT } from "./permissions/PermissionCard";
import { waitingAgents } from "./permissions/permissionModel";
import { toggleInbox, usePendingAsks } from "./permissions/permissionsStore";
import { archiveConversation, expireSnoozed, moveConversation, moveConversationToSection, reopenSettled, restoreArchivedConversation, setCollapsed, setUnread, settleConversation, snoozeConversation, togglePinned, toggleSection, undoMoveConversation, unsnoozeConversation, useArchived, useShelf } from "./shelf";
import { SnoozeDialog } from "./SnoozeDialog";
import { addSurface, openArchivedMessagePreview, requestTabSearchJump, requestThreadSearchJump } from "./store";
import { buildSections, cleanTitle, countStates, initialOf, stepFocus, toggleAllProjects, visibleIds, type SessionSection } from "./sidebar/sessionsModel";
import { closeWorkspaceFolder, forgetWorkspaceFolder } from "./sidebar/workspaceActions";
import { useAutoUnread } from "./sidebar/useAutoUnread";
import { folderName, threadIdOf, threadKey } from "./structured/model";
import { chatThreadRename, chatThreadSearch, type MessageSearchHit } from "./structured/ipc";
import { searchArchivedSessionMessages, type ArchivedMessageSearchHit } from "@/features/sessions/ipc.conversations";
import { reloadThreads, settleThread, startStructured, useStructured } from "./structured/store";
import { invalidateSearchableTimeline, searchableTimeline, searchTuiConversation, type TuiMessageSearchHit } from "./timeline/search";
import { TeamBadge, TeamMembers, conversationDragProps, useTeamGrouping } from "./team/TeamSidebar";
import { usePopover } from "./usePopover";

/** Abre o cartão: a conversa por protocolo, ou a aba do agente. */
function openCard(key: string): void {
  selectConversation(key);
}

/** A largura da sidebar (a padrão do T3 Code). */
export const CHAT_SIDEBAR_W = 256;
const SESSION_REORDER_MIME = "application/x-ade-chat-session-reorder";
type DropPosition = "before" | "after";

export interface FolderDiff {
  added: number;
  removed: number;
}

/**
 * A barra de sessões, a mesma nos modos Chat, Abas e Canvas e no formato da barra do Claude Code: no
 * alto os semáforos, recolher, voltar/avançar e o seletor de modo; uma lista de navegação (Criar,
 * Procurar, Projetos, Artefatos, Personalização, Mais); as seções "Fixadas" e uma por projeto, com UMA
 * linha por conversa (os integrantes do time, indentados sob o orquestrador); ⋯ e clique direito em cada
 * linha e no cabeçalho do projeto; teclado (↑ ↓ Enter, F2 renomear, Delete concluir); as seções "Adiadas"
 * e "Concluídas"; e no rodapé o usuário e as Configurações.
 *
 * `showHeader` e `showFooter` ficam desligados nas Abas e no Canvas (lá o cabeçalho é o `SideHead` e o
 * rodapé é o riel); `extraTop` e `extraBottom` levam o que só esses modos têm (missões, o pet).
 */
export function ChatSidebar({ cards, projects = [], closed, diffs, selectedId, onCollapse, onAddProject, onReopen, onNew = newConversation, onNewIn = newConversationIn, onOpened, onArtifacts = () => addSurface("design"), width = CHAT_SIDEBAR_W, showHeader = true, showFooter = true, modeSwitch = null, extraTop = null, extraBottom = null }: {
  cards: ConversationCard[];
  /** Pastas de projeto que o app já conhece, inclusive workspaces fechados. */
  projects?: ChatProject[];
  /** As pastas fechadas que o painel lembra (reabrir traz os agentes de volta). */
  closed: ChatProject[];
  /** O `+/−` não commitado de cada pasta (a linha não o mostra; fica para o tooltip). */
  diffs: Record<string, FolderDiff>;
  selectedId: string | null;
  onCollapse: () => void;
  onAddProject: () => void;
  onReopen: (cwd: string) => void;
  /** "Criar" (nas Abas e no Canvas abre a tela inicial). */
  onNew?: () => void;
  /** O "+" do cabeçalho de um projeto: conversa nova nessa pasta (nas Abas e no Canvas leva ao chat). */
  onNewIn?: (cwd: string) => void;
  /** Depois de abrir uma conversa (nas Abas e no Canvas leva à tela do workspace). */
  onOpened?: () => void;
  /** "Artefatos": as pranchetas (a superfície Design do painel). `null` esconde a linha. */
  onArtifacts?: (() => void) | null;
  width?: number;
  showHeader?: boolean;
  showFooter?: boolean;
  /** O seletor Chat | Abas | Canvas, no canto direito do cabeçalho. */
  modeSwitch?: React.ReactNode;
  extraTop?: React.ReactNode;
  extraBottom?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setSettingsSection = useUiStore((s) => s.setSettingsSection);
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [messageHits, setMessageHits] = useState<MessageSearchHit[]>([]);
  const [tuiMessageHits, setTuiMessageHits] = useState<TuiMessageSearchHit[]>([]);
  const [archivedMessageHits, setArchivedMessageHits] = useState<ArchivedMessageSearchHit[]>([]);
  const [messageSearchLoading, setMessageSearchLoading] = useState(false);
  const [transcriptRevision, setTranscriptRevision] = useState(0);
  const [folder, setFolder] = useState<string | null>(null);
  const [closedOpen, setClosedOpen] = useState(false);
  const [pinnedProjectsOpen, setPinnedProjectsOpen] = useState(true);
  const [archivedProjectsOpen, setArchivedProjectsOpen] = useState(false);
  const [iconTarget, setIconTarget] = useState<ChatProject | null>(null);
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [snoozeTarget, setSnoozeTarget] = useState<ConversationCard | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [skillTarget, setSkillTarget] = useState<SkillScopeTarget | null>(null);
  const [hiddenKids, setHiddenKids] = useState<string[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ sectionId: string; tabId?: string; position?: DropPosition } | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const snoozedIds = useShelf((s) => s.snoozed);
  const snoozedUntil = useShelf((s) => s.snoozedUntil);
  const settled = useShelf((s) => s.settled);
  const pinned = useShelf((s) => s.pinned);
  const orderBySection = useShelf((s) => s.orderBySection);
  const unread = useShelf((s) => s.unread);
  const collapsed = useShelf((s) => s.collapsed);
  const archivedIds = useArchived((s) => s.ids);
  const projectIdentities = useChatProjectIdentityList();

  useEffect(() => { startStructured(); }, []);

  useEffect(() => {
    const nextExpiry = Object.values(snoozedUntil ?? {})
      .filter((until): until is number => typeof until === "number" && until > 0)
      .reduce<number | null>((soonest, until) => soonest === null || until < soonest ? until : soonest, null);
    if (nextExpiry === null) return;
    let timer: number | null = null;
    const wakeAtExpiry = () => {
      const remaining = nextExpiry - Date.now();
      if (remaining <= 0) {
        expireSnoozed(Date.now());
        return;
      }
      // setTimeout aceita no máximo um inteiro de 32 bits; prazos longos são rearmados sem polling.
      timer = window.setTimeout(wakeAtExpiry, Math.min(remaining, 2_147_000_000));
    };
    wakeAtExpiry();
    return () => { if (timer !== null) window.clearTimeout(timer); };
  }, [snoozedUntil]);
  const threads = useStructured((s) => s.threads);
  const threadById = useMemo(() => new Map(threads.map((thread) => [thread.id, thread] as const)), [threads]);
  const settledThreads = useMemo(() => threads.filter((th) => th.state === "settled"), [threads]);
  const folders = useMemo(() => [...new Set(cards.map((c) => c.project))], [cards]);
  const knownProjects = useMemo(() => {
    const byPath = new Map(projects.map((project) => [normalizeProjectPath(project.cwd), project]));
    for (const [cwd, metadata] of Object.entries(projectIdentities)) {
      if (!byPath.has(cwd) && (metadata.known || metadata.pinned || metadata.archived) && metadata.name) {
        byPath.set(cwd, { cwd, name: metadata.name, branch: metadata.branch });
      }
    }
    return [...byPath.values()];
  }, [projects, projectIdentities]);
  const pinnedProjects = useMemo(() => knownProjects.filter((project) => {
    const metadata = projectIdentities[normalizeProjectPath(project.cwd)];
    return metadata?.pinned && !metadata.archived;
  }), [knownProjects, projectIdentities]);
  const archivedProjects = useMemo(() => knownProjects.filter((project) => projectIdentities[normalizeProjectPath(project.cwd)]?.archived), [knownProjects, projectIdentities]);
  const tuiSearchCards = useMemo(() => cards.filter((c) =>
    (c.agentId === "claude-code" || c.agentId === "codex") && !threadIdOf(c.tabId)), [cards]);
  const activeSearchTabs = useRef<Set<string>>(new Set());
  useAutoUnread(cards, selectedId);
  // O time fica sob a conversa do orquestrador: os integrantes saem da lista e aparecem indentados (prancheta 15).
  const grouping = useTeamGrouping(cards);
  const sections = useMemo(
    () => buildSections(cards, { query, folder, pinned, archived: archivedIds, snoozed: snoozedIds, nested: grouping.nested, collapsed, orderBySection }),
    [cards, query, folder, pinned, archivedIds, snoozedIds, grouping.nested, collapsed, orderBySection],
  );

  useEffect(() => {
    const onQuickSelect = (event: Event) => {
      const quick = event as CustomEvent<{ kind?: string; index?: number }>;
      if (quick.detail?.kind !== "thread" || !navRef.current?.getClientRects().length) return;
      const index = quick.detail.index;
      if (!Number.isInteger(index) || index! < 1 || index! > 9) return;
      const id = visibleIds(sections)[index! - 1];
      if (!id) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      navRef.current.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
      setUnread(id, false);
      openCard(id);
      onOpened?.();
    };
    window.addEventListener("ade:chat-quick-select", onQuickSelect);
    return () => window.removeEventListener("ade:chat-quick-select", onQuickSelect);
  }, [onOpened, sections]);

  const asks = usePendingAsks();
  const waiting = waitingAgents(asks);
  const asksBy = useMemo(() => {
    const by: Record<string, number> = {};
    for (const a of asks) if (a.conversation) by[a.conversation] = (by[a.conversation] ?? 0) + 1;
    return by;
  }, [asks]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cards.filter((c) => (!folder || c.project === folder) && (!q || `${c.title} ${c.project} ${c.agentLabel}`.toLowerCase().includes(q)));
  }, [cards, query, folder]);
  const snoozed = matches.filter((c) => snoozedIds.includes(c.tabId));
  const archived = matches.filter((c) => archivedIds.includes(c.tabId));
  const doneCount = settled.length + settledThreads.length + closed.length;
  const counts = useMemo(() => countStates(cards), [cards]);
  const userName = useUserName();

  useEffect(() => {
    activeSearchTabs.current = searching && query.trim().replace(/\s/g, "").length >= 2
      ? new Set(tuiSearchCards.map((card) => card.tabId))
      : new Set();
  }, [query, searching, tuiSearchCards]);

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
    const term = query.trim();
    if (!searching || term.replace(/\s/g, "").length < 2) {
      setMessageHits([]);
      setTuiMessageHits([]);
      setArchivedMessageHits([]);
      setMessageSearchLoading(false);
      return;
    }
    let current = true;
    const timer = window.setTimeout(() => {
      setMessageSearchLoading(true);
      const protocolSearch = chatThreadSearch(term);
      const archivedSearch = searchArchivedSessionMessages(workspaceId, term, 10).catch(() => [] as ArchivedMessageSearchHit[]);
      const tuiSearch = Promise.all(tuiSearchCards.map(async (card) => {
        const timeline = await searchableTimeline(card.tabId);
        return timeline ? searchTuiConversation(timeline.items, term, card, 10) : [];
      })).then((groups) => groups.flat().slice(0, 30));
      void Promise.all([protocolSearch, tuiSearch, archivedSearch]).then(([protocolHits, tuiHits, archivedHits]) => {
        if (current) {
          setMessageHits(protocolHits);
          setTuiMessageHits(tuiHits);
          setArchivedMessageHits(archivedHits);
        }
      }).catch(() => {
        if (current) { setMessageHits([]); setTuiMessageHits([]); setArchivedMessageHits([]); }
      }).finally(() => {
        if (current) setMessageSearchLoading(false);
      });
    }, 180);
    return () => { current = false; window.clearTimeout(timer); };
  }, [query, searching, tuiSearchCards, transcriptRevision, workspaceId]);

  const commitRename = (card: ConversationCard, raw: string) => {
    setRenaming(null);
    const title = cleanTitle(raw);
    if (!title || title === card.title) return;
    const thread = threadIdOf(card.tabId);
    if (thread) void chatThreadRename(thread, title).then(() => reloadThreads()).catch(() => undefined);
    else useTabsStore.getState().renameTab(card.tabId, title);
  };
  const settle = (card: ConversationCard) => {
    const thread = threadIdOf(card.tabId);
    if (thread) settleThread(thread, true);
    else void settleConversation(card.tabId);
  };
  const archive = (card: ConversationCard) => {
    archiveConversation(card.tabId);
    showBotToast({
      title: t("chat.sidebar.archivedToastTitle"),
      text: t("chat.sidebar.archivedToastText", { title: card.title }),
      actionLabel: t("chat.sidebar.undo"),
      onAction: () => restoreArchivedConversation(card.tabId),
      undoable: true,
      ms: 5000,
    });
  };
  const showUndo = (card: ConversationCard, message: string, onAction: () => void) => {
    showBotToast({
      title: t("chat.sidebar.actionToastTitle"),
      text: t(message, { title: card.title }),
      actionLabel: t("chat.sidebar.undo"),
      onAction,
      undoable: true,
      ms: 5000,
    });
  };
  const canDropInSection = (sourceId: string, target: SessionSection) => {
    const source = cards.find((item) => item.tabId === sourceId);
    return !!source && !query.trim() && !folder && (target.kind === "pinned" || source.project === target.label);
  };
  const dropInSection = (sourceId: string, target: SessionSection, targetIndex: number) => {
    const source = cards.find((item) => item.tabId === sourceId);
    const sourceSection = sections.find((section) => section.items.some((item) => item.tabId === sourceId));
    if (!source || !sourceSection || !canDropInSection(sourceId, target)) return;
    const sourceIds = sourceSection.items.map((item) => item.tabId);
    const sourceIndex = sourceIds.indexOf(sourceId);
    const targetIds = target.items.map((item) => item.tabId);
    if (!moveConversationToSection(sourceId, target.id, targetIds, targetIndex)) return;
    showUndo(source, "chat.sidebar.actionMoved", () => {
      moveConversationToSection(sourceId, sourceSection.id, sourceIds, sourceIndex);
    });
  };
  const rowMenu = (card: ConversationCard): ContextMenuItem[] => {
    const section = sections.find((candidate) => candidate.items.some((item) => item.tabId === card.tabId));
    const sectionIds = section?.items.map((item) => item.tabId) ?? [];
    const index = sectionIds.indexOf(card.tabId);
    const canMove = !!section && !query.trim() && !folder;
    return [
    { key: "pin", label: pinned.includes(card.tabId) ? t("chat.sidebar.unpin") : t("chat.sidebar.pin"), icon: <PushPinIcon className="w-4 h-4" />, onSelect: () => {
      const wasPinned = pinned.includes(card.tabId);
      togglePinned(card.tabId);
      showUndo(card, wasPinned ? "chat.sidebar.actionUnpinned" : "chat.sidebar.actionPinned", () => togglePinned(card.tabId));
    } },
    { key: "rename", label: t("chat.sidebar.rename"), icon: <PenIcon className="w-4 h-4" />, hint: "F2", onSelect: () => setRenaming(card.tabId) },
    { key: "read", label: unread.includes(card.tabId) ? t("chat.sidebar.markRead") : t("chat.sidebar.markUnread"), icon: <EyeIcon className="w-4 h-4" />, onSelect: () => {
      const wasUnread = unread.includes(card.tabId);
      setUnread(card.tabId, !wasUnread);
      showUndo(card, wasUnread ? "chat.sidebar.actionRead" : "chat.sidebar.actionUnread", () => setUnread(card.tabId, wasUnread));
    } },
    ...(canMove ? [
      { key: "move-up", label: t("chat.sidebar.moveUp"), disabled: index <= 0, separator: true, onSelect: () => {
        const neighbor = sectionIds[index - 1];
        if (!neighbor) return;
        moveConversation(card.tabId, section.id, sectionIds, -1);
        showUndo(card, "chat.sidebar.actionMovedUp", () => undoMoveConversation(card.tabId, section.id, neighbor, sectionIds));
      } },
      { key: "move-down", label: t("chat.sidebar.moveDown"), disabled: index < 0 || index >= sectionIds.length - 1, onSelect: () => {
        const neighbor = sectionIds[index + 1];
        if (!neighbor) return;
        moveConversation(card.tabId, section.id, sectionIds, 1);
        showUndo(card, "chat.sidebar.actionMovedDown", () => undoMoveConversation(card.tabId, section.id, neighbor, sectionIds));
      } },
    ] : []),
    // Só as abas (TUI) têm skills e fecham como aba; a conversa por protocolo não.
    ...(threadIdOf(card.tabId) ? [] : [{
      key: "skills", label: t("skills.scope.tabAction"), icon: <WrenchIcon className="w-4 h-4" />, separator: true,
      onSelect: () => setSkillTarget({ scope: "tab", workspaceId, tabId: card.tabId, agentId: card.agentId, label: card.title }),
    }]),
    { key: "snooze", label: t("chat.sidebar.snooze"), icon: <ClockIcon className="w-4 h-4" />, separator: !!threadIdOf(card.tabId), onSelect: () => setSnoozeTarget(card) },
    { key: "archive", label: t("chat.sidebar.archive"), icon: <ArchiveIcon className="w-4 h-4" />, onSelect: () => archive(card) },
    { key: "settle", label: t("chat.sidebar.settle"), icon: <CheckIcon className="w-4 h-4" />, hint: "Del", onSelect: () => settle(card) },
    ...(threadIdOf(card.tabId) ? [] : [{
      key: "close", label: t("tabs.close"), icon: <XIcon className="w-4 h-4" />, danger: true,
      onSelect: () => useTabsStore.getState().closeTab(card.tabId),
    }]),
    ];
  };
  const projectMenu = (project: ChatProject, includeNew = true): ContextMenuItem[] => {
    const metadata = projectIdentities[normalizeProjectPath(project.cwd)];
    const update = (patch: Parameters<typeof setChatProjectIdentity>[1]) => setChatProjectIdentity(project.cwd, { known: true, name: project.name, branch: project.branch, ...patch });
    return [
      ...(includeNew ? [{ key: "new", label: t("chat.sidebar.group.new", { project: project.name }), icon: <NewChatIcon className="w-4 h-4" />, onSelect: () => onNewIn(project.cwd) }] : []),
      { key: "pin-project", label: t(metadata?.pinned ? "chat.project.unpin" : "chat.project.pin"), icon: <PushPinIcon className="w-4 h-4" />, separator: includeNew, onSelect: () => update({ pinned: !metadata?.pinned }) },
      { key: "project-icon", label: t("chat.project.changeIcon"), icon: <DesignIcon className="w-4 h-4" />, onSelect: () => setIconTarget(project) },
      { key: "archive-project", label: t(metadata?.archived ? "chat.project.restore" : "chat.project.archive"), icon: <ArchiveIcon className="w-4 h-4" />, separator: true,
        onSelect: () => update({ archived: !metadata?.archived }) },
    ];
  };
  const groupMenu = (section: SessionSection): ContextMenuItem[] => {
    const cwd = section.items[0]?.cwd;
    const project = cwd ? projects.find((candidate) => normalizeProjectPath(candidate.cwd) === normalizeProjectPath(cwd))
      ?? { cwd, name: section.label, branch: section.items[0]?.branch ?? null } : null;
    return [
      { key: "all", label: sections.filter((x) => x.kind === "project").every((x) => x.collapsed) ? t("chat.sidebar.group.expandAll") : t("chat.sidebar.group.collapseAll"),
        icon: <ChevronRightIcon className="w-4 h-4" />, onSelect: () => setCollapsed(toggleAllProjects(sections, collapsed)) },
      ...(project ? projectMenu(project) : []),
      ...(cwd ? [
        { key: "skills", label: t("skills.scope.workspaceAction"), icon: <WrenchIcon className="w-4 h-4" />, separator: true,
          onSelect: () => setSkillTarget({ scope: "workspace", workspaceId, cwd, agentId: null, label: section.label }) },
        { key: "close", label: t("workspaces.close"), icon: <XIcon className="w-4 h-4" />, danger: true, onSelect: () => { void closeWorkspaceFolder(cwd); } },
      ] : []),
    ];
  };
  const moreMenu = (): ContextMenuItem[] => [
    { key: "counts", label: t("chat.sidebar.counts", counts), disabled: true, onSelect: () => undefined },
    { key: "pr", label: t("chat.sidebar.pullRequests"), icon: <PullRequestIcon className="w-4 h-4" />, separator: true, onSelect: () => navigate("/forge") },
    { key: "usage", label: t("chat.sidebar.usage"), icon: <UsageIcon className="w-4 h-4" />, onSelect: () => { setSettingsSection("accounts"); navigate("/settings"); } },
    { key: "missions", label: t("chat.sidebar.more.missions"), icon: <BotIcon className="w-4 h-4" />, separator: true, onSelect: () => navigate("/missions") },
    { key: "fleet", label: t("chat.sidebar.more.fleet"), icon: <ListIcon className="w-4 h-4" />, onSelect: () => navigate("/fleet") },
    { key: "squads", label: t("chat.sidebar.more.squads"), icon: <UsersIcon className="w-4 h-4" />, onSelect: () => navigate("/squads") },
    { key: "skills", label: t("chat.sidebar.more.skills"), icon: <WrenchIcon className="w-4 h-4" />, onSelect: () => navigate("/skills") },
    { key: "market", label: t("chat.sidebar.more.marketplace"), icon: <GlobeIcon className="w-4 h-4" />, onSelect: () => navigate("/marketplace") },
  ];

  const canCiteIntoCurrentConversation = !!selectedId && !!threadIdOf(selectedId);
  const citeSearchHit = (hit: Pick<MessageSearchHit, "title" | "cwd" | "agentId" | "kind" | "excerpt">) => {
    if (!selectedId || !threadIdOf(selectedId)) return;
    const sourceTitle = hit.title || folderName(hit.cwd);
    const sourceAgent = cards.find((card) => card.agentId === hit.agentId)?.agentLabel ?? hit.agentId;
    const source = `${sourceTitle} · ${sourceAgent} · ${hit.kind === "user" ? t("chat.sidebar.you") : t("chat.sidebar.agent")}`;
    const added = addQuoteFor(selectedId, {
      text: `${t("chat.quote.source", { source })}\n${hit.excerpt}`,
      comment: t("chat.sidebar.crossThreadReferenceComment"),
    });
    showBotToast({
      title: t(added ? "chat.sidebar.crossThreadReferenceAdded" : "chat.sidebar.crossThreadReferenceSkipped"),
      text: t(added ? "chat.sidebar.crossThreadReferenceAddedHint" : "chat.sidebar.crossThreadReferenceSkippedHint"),
    });
  };
  const openMenuAt = (e: React.MouseEvent<HTMLElement>, items: ContextMenuItem[]) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4, items });
  };

  // ↑ ↓ andam pelas conversas à vista; o foco vai para a linha (que já abre com Enter).
  const onNavKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const focused = (e.target as HTMLElement).closest("[data-session-id]")?.getAttribute("data-session-id") ?? null;
    const next = stepFocus(visibleIds(sections), focused, e.key === "ArrowDown" ? 1 : -1);
    if (!next) return;
    e.preventDefault();
    navRef.current?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(next)}"]`)?.focus();
  };

  return (
    <aside aria-label={t("chat.sidebar.label")} style={{ width }}
      className="shrink-0 h-full flex flex-col bg-gray-50 dark:bg-black border-r border-gray-200 dark:border-white/[0.08]">
      {showHeader && (
        <div data-tauri-drag-region className="h-[52px] shrink-0 flex items-center gap-1 pl-5 pr-2 select-none">
          <WindowLights />
          <IconButton label={t("chat.sidebar.collapse")} onClick={onCollapse} className="ml-3.5"><SidebarIcon className="w-4 h-4" /></IconButton>
          <IconButton label={t("chat.sidebar.back")} onClick={() => navigate(-1)}><ChevronLeftIcon className="w-4 h-4" /></IconButton>
          <IconButton label={t("chat.sidebar.forward")} onClick={() => navigate(1)}><ChevronRightIcon className="w-4 h-4" /></IconButton>
          <span data-tauri-drag-region className="flex-1" />
          {modeSwitch}
        </div>
      )}

      {waiting > 0 && (
        <button type="button" onClick={toggleInbox} aria-keyshortcuts={INBOX_SHORTCUT}
          className="mx-2 mt-1 mb-1.5 shrink-0 flex items-center gap-2 h-[34px] px-2.5 rounded-lg text-chat-note font-medium
            bg-amber-50 dark:bg-amber-400/[0.08] ring-1 ring-inset ring-amber-300 dark:ring-amber-400/35 text-amber-800 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-400/[0.14]">
          <WarnIcon className="w-4 h-4 shrink-0" />
          <span className="truncate">{t("chat.inbox.waiting", { count: waiting })}</span>
          <span className="flex-1" />
          <kbd className="ml-1.5 px-1 rounded border border-amber-300 dark:border-amber-400/35 font-sans text-[11px] font-normal">{INBOX_SHORTCUT}</kbd>
        </button>
      )}

      {/* A lista de navegação, como a do Claude Code. */}
      <div role="navigation" aria-label={t("chat.sidebar.navLabel")} className="shrink-0 px-2 pt-1 flex flex-col gap-0.5">
        <NavRow icon={<NewChatIcon className="w-[18px] h-[18px]" />} label={t("chat.sidebar.create")} onClick={onNew} aria={t("chat.sidebar.new")} />
        <NavRow icon={<SearchIcon className="w-[18px] h-[18px]" />} label={t("chat.sidebar.nav.search")} pressed={searching}
          onClick={() => { setSearching(!searching); if (searching) { setQuery(""); setFolder(null); } }} />
        {searching && (
          <div className="flex items-center gap-0.5 pb-1">
            <label className="flex-1 min-w-0 flex items-center gap-2 h-8 px-2 rounded-md text-chat-ui text-gray-500 dark:text-white/45 bg-white dark:bg-white/[0.06] focus-within:ring-1 focus-within:ring-accent-500/70">
              <span className="sr-only">{t("chat.sidebar.search")}</span>
              <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("chat.sidebar.search")}
                onKeyDown={(e) => { if (e.key === "Escape") { setSearching(false); setQuery(""); setFolder(null); } }}
                className="flex-1 min-w-0 bg-transparent outline-none text-gray-900 dark:text-white placeholder:text-gray-500 dark:placeholder:text-white/45" />
            </label>
            <FolderFilter folders={folders} value={folder} onChange={setFolder} />
          </div>
        )}
        <NavRow icon={<FolderPlusIcon className="w-[18px] h-[18px]" />} label={t("chat.sidebar.nav.projects")} onClick={onAddProject} aria={t("chat.sidebar.addProject")} />
        {onArtifacts && <NavRow icon={<DesignIcon className="w-[18px] h-[18px]" />} label={t("chat.sidebar.nav.artifacts")} onClick={onArtifacts} />}
        <NavRow icon={<SettingsIcon className="w-[18px] h-[18px]" />} label={t("chat.sidebar.nav.personalize")} onClick={() => navigate("/settings")} aria={t("sidebar.settings")} />
        <NavRow icon={<MoreHorizontalIcon className="w-[18px] h-[18px]" />} label={t("chat.sidebar.nav.more")} onClick={(e) => openMenuAt(e, moreMenu())} hasMenu />
      </div>

      {extraTop}

      {pinnedProjects.length > 0 && (
        <div className="max-h-44 shrink-0 overflow-y-auto cc-scroll-hidden px-2 pt-2">
          <SectionHeader label={t("chat.project.pinnedProjects")} count={pinnedProjects.length} open={pinnedProjectsOpen} onToggle={() => setPinnedProjectsOpen((open) => !open)} />
          {pinnedProjectsOpen && <div className="mt-0.5 flex flex-col gap-0.5">
            {pinnedProjects.map((project) => (
              <ProjectShortcut key={project.cwd} project={project} onOpen={() => onNewIn(project.cwd)}
                onMenu={(event) => openMenuAt(event, projectMenu(project))} />
            ))}
          </div>}
        </div>
      )}

      <nav ref={navRef} aria-label={t("chat.sidebar.active")} onKeyDown={onNavKey} className="flex-1 min-h-0 cc-scroll-hidden px-2 pt-3 flex flex-col gap-3">
        {searching && query.trim().replace(/\s/g, "").length >= 2 && (
          <section aria-label={t("chat.sidebar.messageResults")} className="flex flex-col gap-1">
            <div className="px-2 text-chat-caption font-semibold text-gray-500 dark:text-white/45">{t("chat.sidebar.messageResults")}</div>
            {messageSearchLoading && <p role="status" className="px-2 py-2 text-chat-caption text-gray-400 dark:text-white/40">{t("chat.sidebar.searchingMessages")}</p>}
            {!messageSearchLoading && messageHits.length === 0 && tuiMessageHits.length === 0 && archivedMessageHits.length === 0 && <p className="px-2 py-2 text-chat-caption text-gray-400 dark:text-white/40">{t("chat.sidebar.noMessageResults")}</p>}
            {messageHits.map((hit) => {
              const Icon = agentIcon(hit.agentId);
              const thread = threadById.get(hit.threadId);
              const author = hit.kind === "user" ? t("chat.sidebar.you") : t("chat.sidebar.agent");
              const stateLabel = thread?.state === "settled" ? ` · ${t("chat.sidebar.closed")}` : "";
              return (
                <div key={`${hit.threadId}:${hit.itemId}`} className="rounded-lg px-2.5 py-2 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
                  <button type="button"
                    onClick={() => {
                      if (thread?.state === "settled") settleThread(thread.id, false);
                      requestThreadSearchJump(hit.threadId, hit.itemId);
                      selectConversation(threadKey(hit.threadId));
                      onOpened?.();
                    }}
                    className="flex w-full flex-col items-start gap-1 text-left">
                    <span className="flex w-full min-w-0 items-center gap-1.5 text-chat-caption font-medium text-gray-800 dark:text-white/80">
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{hit.title || folderName(hit.cwd)}</span>
                      <span className="shrink-0 text-gray-400 dark:text-white/35">{`${author}${stateLabel}`}</span>
                    </span>
                    <span className="line-clamp-2 pl-5 text-chat-caption text-gray-500 dark:text-white/45">{hit.excerpt}</span>
                  </button>
                  {canCiteIntoCurrentConversation && (
                    <button type="button" onClick={() => citeSearchHit(hit)}
                      aria-label={t("chat.sidebar.addMessageReference", { title: hit.title || folderName(hit.cwd) })}
                      className="ml-5 mt-1 rounded px-1.5 py-0.5 text-chat-caption text-accent-700 dark:text-accent-300 hover:bg-gray-200/70 dark:hover:bg-white/10">
                      {t("chat.sidebar.citeMessage")}
                    </button>
                  )}
                </div>
              );
            })}
            {tuiMessageHits.map((hit) => {
              const Icon = agentIcon(hit.agentId);
              return (
                <div key={`${hit.tabId}:${hit.itemId}`} className="rounded-lg px-2.5 py-2 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
                  <button type="button"
                    onClick={() => {
                      requestTabSearchJump(hit.tabId, hit.itemId);
                      openCard(hit.tabId);
                      onOpened?.();
                    }}
                    className="flex w-full flex-col items-start gap-1 text-left">
                    <span className="flex w-full min-w-0 items-center gap-1.5 text-chat-caption font-medium text-gray-800 dark:text-white/80">
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{hit.title || folderName(hit.cwd)}</span>
                      <span className="shrink-0 text-gray-400 dark:text-white/35">{hit.kind === "user" ? t("chat.sidebar.you") : t("chat.sidebar.agent")}</span>
                    </span>
                    <span className="line-clamp-2 pl-5 text-chat-caption text-gray-500 dark:text-white/45">{hit.excerpt}</span>
                  </button>
                  {canCiteIntoCurrentConversation && (
                    <button type="button" onClick={() => citeSearchHit(hit)}
                      aria-label={t("chat.sidebar.addMessageReference", { title: hit.title || folderName(hit.cwd) })}
                      className="ml-5 mt-1 rounded px-1.5 py-0.5 text-chat-caption text-accent-700 dark:text-accent-300 hover:bg-gray-200/70 dark:hover:bg-white/10">
                      {t("chat.sidebar.citeMessage")}
                    </button>
                  )}
                </div>
              );
            })}
            {archivedMessageHits.map((hit) => {
              const Icon = agentIcon(hit.agentId);
              const author = hit.kind === "user" ? t("chat.sidebar.you") : t("chat.sidebar.agent");
              return (
                <div key={`${hit.historyId}:${hit.turnIndex}`} className="rounded-lg px-2.5 py-2 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
                  <button type="button"
                    onClick={() => { if (workspaceId) openArchivedMessagePreview(workspaceId, hit); }}
                    className="flex w-full flex-col items-start gap-1 text-left">
                    <span className="flex w-full min-w-0 items-center gap-1.5 text-chat-caption font-medium text-gray-800 dark:text-white/80">
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{hit.title || folderName(hit.cwd)}</span>
                      <span className="shrink-0 text-gray-400 dark:text-white/35">{`${author} · ${t("chat.sidebar.archivedSession")}`}</span>
                    </span>
                    <span className="line-clamp-2 pl-5 text-chat-caption text-gray-500 dark:text-white/45">{hit.excerpt}</span>
                  </button>
                </div>
              );
            })}
          </section>
        )}
        {cards.length === 0 && (
          <p className="px-2 py-6 text-center text-chat-note text-gray-400 dark:text-white/40">{t("chat.sidebar.empty")}</p>
        )}
        {draggingId && !sections.some((section) => section.id === "pinned") && (() => {
          const section: SessionSection = { id: "pinned", kind: "pinned", label: "", items: [], collapsed: false };
          return (
            <SectionBlock key="drop-pinned" section={section} onMenu={() => undefined} dropActive={dropTarget?.sectionId === section.id && !dropTarget.tabId}
              onDragOver={(e) => {
                if (!draggingId || !canDropInSection(draggingId, section)) return;
                e.preventDefault();
                setDropTarget({ sectionId: section.id });
              }}
              onDrop={(e) => {
                const sourceId = e.dataTransfer.getData(SESSION_REORDER_MIME) || draggingId;
                if (!sourceId || !canDropInSection(sourceId, section)) return;
                e.preventDefault();
                e.stopPropagation();
                dropInSection(sourceId, section, 0);
                setDraggingId(null);
                setDropTarget(null);
              }}>
              <div className="h-8 flex items-center px-2.5 text-chat-caption text-gray-400 dark:text-white/40">{t("chat.sidebar.dropToPin")}</div>
            </SectionBlock>
          );
        })()}
        {sections.map((section) => (
          <SectionBlock key={section.id} section={section} onMenu={(e) => openMenuAt(e, groupMenu(section))}
            projectCwd={section.kind === "project" ? section.items[0]?.cwd : undefined}
            dropActive={dropTarget?.sectionId === section.id && !dropTarget.tabId}
            onDragOver={(e) => {
              if (!draggingId || !canDropInSection(draggingId, section)) return;
              e.preventDefault();
              setDropTarget({ sectionId: section.id });
            }}
            onDrop={(e) => {
              const sourceId = e.dataTransfer.getData(SESSION_REORDER_MIME) || draggingId;
              if (!sourceId || !canDropInSection(sourceId, section)) return;
              e.preventDefault();
              e.stopPropagation();
              dropInSection(sourceId, section, section.items.length);
              setDraggingId(null);
              setDropTarget(null);
            }}
            onNew={section.kind === "project" && section.items[0]?.cwd ? () => onNewIn(section.items[0]!.cwd) : undefined}>
            {section.items.map((card) => {
              const kids = grouping.groups[card.tabId] ?? [];
              const kidsHidden = hiddenKids.includes(card.tabId);
              const rowPosition = dropTarget?.sectionId === section.id && dropTarget.tabId === card.tabId ? dropTarget.position ?? null : null;
              return (
                <Fragment key={card.tabId}>
                  <SessionRow card={card} diff={diffs[card.cwd]} selected={card.tabId === selectedId} asks={asksBy[card.tabId] ?? 0}
                    pinned={pinned.includes(card.tabId)} unread={unread.includes(card.tabId)} renaming={renaming === card.tabId} onOpened={onOpened}
                    kids={kids.length} kidsHidden={kidsHidden} onToggleKids={() => setHiddenKids((h) => (h.includes(card.tabId) ? h.filter((x) => x !== card.tabId) : [...h, card.tabId]))}
                    onRename={(raw) => commitRename(card, raw)} onCancelRename={() => setRenaming(null)} onStartRename={() => setRenaming(card.tabId)}
                    onSettle={() => settle(card)} onMenu={(x, y) => setMenu({ x, y, items: rowMenu(card) })}
                    dropPosition={rowPosition}
                    onDragStart={(e) => {
                      conversationDragProps(card.tabId).onDragStart(e);
                      e.dataTransfer.setData(SESSION_REORDER_MIME, card.tabId);
                      e.dataTransfer.effectAllowed = "copyMove";
                      setDraggingId(card.tabId);
                    }}
                    onDragEnd={() => { setDraggingId(null); setDropTarget(null); }}
                    onDragOver={(e) => {
                      if (!draggingId || !canDropInSection(draggingId, section)) return;
                      e.preventDefault();
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      const position: DropPosition = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
                      setDropTarget({ sectionId: section.id, tabId: card.tabId, position });
                    }}
                    onDrop={(e) => {
                      const sourceId = e.dataTransfer.getData(SESSION_REORDER_MIME) || draggingId;
                      if (!sourceId || !canDropInSection(sourceId, section)) return;
                      e.preventDefault();
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      const position: DropPosition = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
                      const targetIndex = section.items.findIndex((item) => item.tabId === card.tabId) + (position === "after" ? 1 : 0);
                      dropInSection(sourceId, section, targetIndex);
                      setDraggingId(null);
                      setDropTarget(null);
                    }} />
                  {kids.length > 0 && !kidsHidden && (
                    <TeamMembers orchestrator={card.tabId} members={kids} cards={cards} selectedId={selectedId} />
                  )}
                </Fragment>
              );
            })}
          </SectionBlock>
        ))}
      </nav>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {skillTarget && <SkillPalette target={skillTarget} onClose={() => setSkillTarget(null)} />}
      {snoozeTarget && <SnoozeDialog title={snoozeTarget.title} onClose={() => setSnoozeTarget(null)} onChoose={(until) => {
        snoozeConversation(snoozeTarget.tabId, until);
        showUndo(snoozeTarget, "chat.sidebar.actionSnoozed", () => unsnoozeConversation(snoozeTarget.tabId));
        setSnoozeTarget(null);
      }} />}

      {snoozed.length > 0 && (
        <div className="px-2 pt-1">
          <SectionHeader label={t("chat.sidebar.snoozed")} count={snoozed.length} open={snoozedOpen} onToggle={() => setSnoozedOpen(!snoozedOpen)} />
          {snoozedOpen && (
            <div className="max-h-40 cc-scroll-hidden flex flex-col">
              {snoozed.map((c) => (
                <SlimRow key={c.tabId} name={c.project} title={c.title} agentId={c.agentId}
                  subtitle={typeof snoozedUntil?.[c.tabId] === "number"
                    ? t("chat.sidebar.snoozeAt", { time: new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(snoozedUntil[c.tabId]!) })
                    : undefined}
                  onOpen={() => { unsnoozeConversation(c.tabId); openCard(c.tabId); onOpened?.(); }}
                  onMenu={(x, y) => setMenu({ x, y, items: [
                    { key: "wake", label: t("chat.sidebar.wakeSnoozed"), icon: <UndoIcon className="w-4 h-4" />, onSelect: () => {
                      const until = snoozedUntil?.[c.tabId] ?? null;
                      unsnoozeConversation(c.tabId);
                      showUndo(c, "chat.sidebar.actionWoken", () => snoozeConversation(c.tabId, until));
                    } },
                  ] })} />
              ))}
            </div>
          )}
        </div>
      )}

      {archived.length > 0 && (
        <div className="px-2 pt-1">
          <SectionHeader label={t("chat.sidebar.archived")} count={archived.length} open={archivedOpen} onToggle={() => setArchivedOpen(!archivedOpen)} />
          {archivedOpen && (
            <div className="max-h-40 cc-scroll-hidden flex flex-col">
              {archived.map((c) => (
                <SlimRow key={c.tabId} name={c.project} title={c.title} agentId={c.agentId}
                  onOpen={() => { restoreArchivedConversation(c.tabId); openCard(c.tabId); onOpened?.(); }}
                  onMenu={(x, y) => setMenu({ x, y, items: [
                    { key: "restore", label: t("chat.sidebar.restore"), icon: <UndoIcon className="w-4 h-4" />, onSelect: () => restoreArchivedConversation(c.tabId) },
                  ] })} />
              ))}
            </div>
          )}
        </div>
      )}

      {doneCount > 0 && (
        <div className="px-2 pt-1">
          <SectionHeader label={t("chat.sidebar.closed")} count={doneCount} open={closedOpen} onToggle={() => setClosedOpen(!closedOpen)} />
          {closedOpen && (
            <div className="max-h-48 cc-scroll-hidden flex flex-col">
              {settled.map((e) => (
                <SlimRow key={e.id} name={e.cwd.split(/[\\/]/).filter(Boolean).pop() ?? e.cwd} title={e.title} agentId={e.agentId}
                  onOpen={() => { reopenSettled(e.id); onOpened?.(); }} />
              ))}
              {settledThreads.map((th) => (
                <SlimRow key={th.id} name={folderName(th.cwd)} title={th.title} agentId={th.agentId}
                  onOpen={() => { settleThread(th.id, false); selectConversation(threadKey(th.id)); onOpened?.(); }} />
              ))}
              {closed.map((p) => (
                <div key={p.cwd} className="group flex items-center rounded-md hover:bg-white dark:hover:bg-white/[0.05]"
                  onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: [
                    { key: "reopen", label: t("chat.sidebar.reopen", { name: p.name }), icon: <ChevronRightIcon className="w-4 h-4" />, onSelect: () => onReopen(p.cwd) },
                    { key: "forget", label: t("workspaces.forget"), icon: <XIcon className="w-4 h-4" />, danger: true, separator: true, onSelect: () => { forgetChatProjectIdentity(p.cwd); void forgetWorkspaceFolder(p.cwd); } },
                  ] }); }}>
                  <button type="button" onClick={() => onReopen(p.cwd)} title={t("chat.sidebar.reopen", { name: p.name })}
                    className="flex-1 min-w-0 h-9 flex items-center gap-2.5 px-2.5 text-left text-chat-note text-gray-600 dark:text-white/60">
                    <ProjectBadge name={p.name} cwd={p.cwd} size="sm" muted />
                    <span className="flex-1 truncate">{p.name}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {archivedProjects.length > 0 && (
        <div className="shrink-0 px-2 pb-1">
          <SectionHeader label={t("chat.project.archivedProjects")} count={archivedProjects.length} open={archivedProjectsOpen} onToggle={() => setArchivedProjectsOpen((open) => !open)} />
          {archivedProjectsOpen && <div className="max-h-40 cc-scroll-hidden flex flex-col">
            {archivedProjects.map((project) => (
              <ProjectShortcut key={project.cwd} project={project} archived
                onOpen={() => { setChatProjectIdentity(project.cwd, { known: true, archived: false, name: project.name, branch: project.branch }); onNewIn(project.cwd); }}
                onMenu={(event) => openMenuAt(event, projectMenu(project, false))} />
            ))}
          </div>}
        </div>
      )}

      {extraBottom}

      {showFooter && (
        <div className="flex items-center gap-2 px-3 pt-2 pb-3">
          <span aria-hidden="true" className="w-6 h-6 shrink-0 rounded-full bg-gray-300 dark:bg-white/20 text-[11px] font-semibold flex items-center justify-center text-gray-700 dark:text-white">{initialOf(userName)}</span>
          <span className="flex-1 min-w-0 truncate text-chat-ui text-gray-800 dark:text-white/85" title={t("chat.sidebar.account")}>{userName ?? t("chat.sidebar.account")}</span>
          <IconButton label={t("sidebar.settings")} onClick={() => navigate("/settings")}><SettingsIcon className="w-4 h-4" /></IconButton>
        </div>
      )}
      {iconTarget && (
        <ChatProjectIconDialog projectName={iconTarget.name}
          icon={projectIdentities[normalizeProjectPath(iconTarget.cwd)]?.icon ?? null}
          onSave={(icon) => { setChatProjectIdentity(iconTarget.cwd, { known: true, name: iconTarget.name, branch: iconTarget.branch, icon }); setIconTarget(null); }}
          onClose={() => setIconTarget(null)} />
      )}
    </aside>
  );
}

/** O nome do usuário do sistema (o último trecho da pasta pessoal), para o rodapé. */
function useUserName(): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => { homeDir().then((h) => setName(h.split(/[\\/]/).filter(Boolean).pop() ?? null)).catch(() => undefined); }, []);
  return name;
}

/** Uma linha da lista de navegação (Criar, Procurar, Projetos…): ícone e rótulo, sem fundo até o hover. */
function NavRow({ icon, label, onClick, aria, pressed, hasMenu = false }: {
  icon: React.ReactNode; label: string; onClick: (e: React.MouseEvent<HTMLElement>) => void; aria?: string; pressed?: boolean; hasMenu?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} aria-label={aria ?? label} aria-pressed={pressed} aria-haspopup={hasMenu ? "menu" : undefined}
      className={`w-full h-9 shrink-0 flex items-center gap-3 px-2.5 rounded-lg text-left text-[14px] text-gray-800 dark:text-white/85
        ${pressed ? "bg-gray-200/70 dark:bg-white/[0.10]" : "hover:bg-gray-200/60 dark:hover:bg-white/[0.07]"}`}>
      <span className="shrink-0 text-gray-600 dark:text-white/60">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

/** Uma seção: "Fixadas" ou um projeto. O cabeçalho é cinza e pequeno, com a seta que recolhe; o ⋯ aparece no hover. */
function SectionBlock({ section, onMenu, onNew, children, dropActive = false, onDragOver, onDrop, projectCwd }: {
  section: SessionSection;
  onMenu: (e: React.MouseEvent<HTMLElement>) => void;
  onNew?: () => void;
  children: React.ReactNode;
  dropActive?: boolean;
  onDragOver?: (e: React.DragEvent<HTMLElement>) => void;
  onDrop?: (e: React.DragEvent<HTMLElement>) => void;
  projectCwd?: string;
}) {
  const { t } = useTranslation();
  const label = section.kind === "pinned" ? t("chat.sidebar.pinned") : section.label;
  return (
    <section aria-label={label} onDragOver={onDragOver} onDrop={onDrop}
      className={`flex flex-col gap-0.5 rounded-lg ${dropActive ? "ring-1 ring-inset ring-accent-500/70" : ""}`}>
      <div className="group flex items-center h-7 px-2.5 text-[12.5px] text-gray-500 dark:text-white/50">
        <button type="button" aria-expanded={!section.collapsed} onClick={() => toggleSection(section.id)} title={section.kind === "project" ? section.items[0]?.cwd : undefined}
          className="min-w-0 flex items-center gap-1.5 rounded hover:text-gray-900 dark:hover:text-white">
          {section.kind === "project" && <ProjectBadge name={label} cwd={projectCwd} size="sm" />}
          <span className="truncate">{label}</span>
          <span aria-hidden="true" className={`text-[8px] transition-transform ${section.collapsed ? "-rotate-90" : ""}`}>▼</span>
        </button>
        <span className="flex-1" />
        {onNew && (
          <button type="button" onClick={onNew} aria-label={t("chat.sidebar.group.new", { project: label })} title={t("chat.sidebar.group.new", { project: label })}
            className="hidden group-hover:flex group-focus-within:flex w-6 h-6 items-center justify-center rounded hover:bg-gray-200/70 dark:hover:bg-white/10">
            <PlusIcon className="w-3.5 h-3.5" />
          </button>
        )}
        {section.kind === "project" && (
          <button type="button" onClick={onMenu} aria-label={t("chat.sidebar.group.more")} title={t("chat.sidebar.group.more")} aria-haspopup="menu"
            className="hidden group-hover:flex group-focus-within:flex w-6 h-6 items-center justify-center rounded hover:bg-gray-200/70 dark:hover:bg-white/10">
            <MoreHorizontalIcon className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {!section.collapsed && children}
    </section>
  );
}

function ProjectShortcut({ project, archived = false, onOpen, onMenu }: {
  project: ChatProject;
  archived?: boolean;
  onOpen: () => void;
  onMenu: (event: React.MouseEvent<HTMLElement>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="group flex items-center rounded-lg hover:bg-gray-100 dark:hover:bg-white/[0.06]">
      <button type="button" onClick={onOpen} title={project.cwd}
        className="flex-1 min-w-0 h-8 flex items-center gap-2.5 rounded-lg px-2.5 text-left text-chat-note text-gray-700 dark:text-white/75">
        <ProjectBadge name={project.name} cwd={project.cwd} size="sm" muted={archived} />
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
        {project.branch && <span className="max-w-16 truncate text-chat-caption text-gray-400 dark:text-white/35">{project.branch}</span>}
      </button>
      <button type="button" onClick={onMenu} aria-label={t("chat.sidebar.group.more")} title={t("chat.sidebar.group.more")} aria-haspopup="menu"
        className="hidden group-hover:flex group-focus-within:flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-200/70 dark:text-white/50 dark:hover:bg-white/10">
        <MoreHorizontalIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * UMA linha por conversa (o título numa linha só). À direita, discretos: o giro de quem trabalha, a
 * bolinha de "não lida" ou "aguardando você", o "⑂ N" de quem tem integrantes do time e a seta que os
 * esconde; o ⋯ aparece no hover e no foco. A selecionada leva fundo cinza arredondado.
 */
function SessionRow({ card, diff, selected, asks, pinned, unread, renaming, onOpened, kids, kidsHidden, onToggleKids, onRename, onCancelRename, onStartRename, onSettle, onMenu, dropPosition, onDragStart, onDragEnd, onDragOver, onDrop }: {
  card: ConversationCard; diff: FolderDiff | undefined; selected: boolean; asks: number;
  pinned: boolean; unread: boolean; renaming: boolean; onOpened?: () => void;
  kids: number; kidsHidden: boolean; onToggleKids: () => void;
  onRename: (title: string) => void; onCancelRename: () => void; onStartRename: () => void; onSettle: () => void;
  /** Abre o menu de contexto na posição da tela. */
  onMenu: (x: number, y: number) => void;
  dropPosition: DropPosition | null;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
}) {
  const { t } = useTranslation();
  const live = useLiveSummary(card.tabId);
  const threadId = threadIdOf(card.tabId);
  const tabPhase = useChatLive((s) => s.phase[card.tabId]);
  const tabQuestion = useChatLive((s) => s.question[card.tabId]);
  const tabAwaiting = useChatLive((s) => card.tabId in s.awaiting);
  // Conversa por protocolo: o estado vem dos eventos do agente, não do canal da aba.
  const threadPhase = useStructured((s) => (threadId ? s.live[threadId]?.phase : undefined));
  const threadAsk = useStructured((s) => (threadId ? s.live[threadId]?.requests[0]?.kind ?? null : null));
  const phase = threadId ? threadPhase : tabPhase;
  const question = threadId ? threadAsk === "question" : tabQuestion;
  const awaiting = threadId ? !!threadAsk && threadAsk !== "question" : tabAwaiting;
  const needsYou = asks > 0 || awaiting || question;
  const working = !needsYou && (phase === "working" || live.working);
  const open = () => { setUnread(card.tabId, false); openCard(card.tabId); onOpened?.(); };
  const stateLabel = needsYou ? t("chat.status.approval") : working ? t("chat.sidebar.working") : unread ? t("chat.sidebar.unread") : null;
  const tip = [card.cwd, card.branch, diff && diff.added + diff.removed > 0 ? `+${diff.added} −${diff.removed}` : null].filter(Boolean).join(" · ");
  return (
    <div role="button" tabIndex={0} draggable={!renaming} data-session-id={card.tabId} onClick={() => { if (!renaming) open(); }} aria-current={selected ? "page" : undefined} title={tip}
      onDragStart={onDragStart} onDragEnd={onDragEnd} onDragOver={onDragOver} onDrop={onDrop}
      onContextMenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}
      onKeyDown={(e) => {
        if (renaming || e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
        else if (e.key === "F2") { e.preventDefault(); onStartRename(); }
        else if (e.key === "Delete") { e.preventDefault(); onSettle(); }
        else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(r.left + 24, r.top + 24);
        }
      }}
      className={`group w-full h-8 shrink-0 flex items-center gap-2 pl-2.5 pr-1.5 rounded-lg text-left cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-accent-500/70
        ${dropPosition === "before" ? "border-t-2 border-t-accent-500" : dropPosition === "after" ? "border-b-2 border-b-accent-500" : ""}
        ${selected ? "bg-gray-200/70 dark:bg-white/[0.10]" : "hover:bg-gray-200/50 dark:hover:bg-white/[0.06]"}`}>
      {renaming ? (
        <input autoFocus defaultValue={card.title} aria-label={t("chat.sidebar.renameLabel")}
          onClick={(e) => e.stopPropagation()} onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") onRename(e.currentTarget.value);
            else if (e.key === "Escape") onCancelRename();
          }}
          onBlur={(e) => onRename(e.currentTarget.value)} onFocus={(e) => e.currentTarget.select()}
          className="flex-1 min-w-0 h-6 px-1 -mx-1 rounded bg-white dark:bg-white/10 outline-none ring-1 ring-accent-500/70 text-[13px] text-gray-900 dark:text-white" />
      ) : (
        <span className={`flex-1 min-w-0 truncate text-[13.5px] text-gray-900 dark:text-white ${unread ? "font-semibold" : ""}`}>{card.title}</span>
      )}
      {pinned && <PushPinIcon className="w-3 h-3 shrink-0 text-gray-400 dark:text-white/40" />}
      {kids > 0 && (
        <span className="shrink-0 flex items-center gap-1 text-[12px] text-accent-600 dark:text-accent-400 tabular-nums" title={t("chat.sidebar.team", { count: kids })}>
          <BranchIcon className="w-3 h-3" />{kids}
        </span>
      )}
      {kids > 0 && (
        <button type="button" aria-expanded={!kidsHidden} aria-label={t("chat.sidebar.kids")} title={t("chat.sidebar.kids")}
          onClick={(e) => { e.stopPropagation(); onToggleKids(); }}
          className="shrink-0 w-4 h-5 flex items-center justify-center text-[8px] text-gray-400 dark:text-white/40 hover:text-gray-800 dark:hover:text-white">
          <span aria-hidden="true" className={kidsHidden ? "-rotate-90 inline-block" : "inline-block"}>▼</span>
        </button>
      )}
      <TeamBadge convKey={card.tabId} />
      {working && <span role="img" aria-label={stateLabel ?? ""} className="shrink-0 w-3 h-3 rounded-full border-2 border-gray-300 dark:border-white/25 border-t-accent-500 animate-spin" />}
      {!working && (needsYou || unread) && <span role="img" aria-label={stateLabel ?? ""} className="shrink-0 w-2 h-2 rounded-full bg-amber-500" />}
      <button type="button" aria-label={t("chat.sidebar.more")} title={t("chat.sidebar.more")} aria-haspopup="menu"
        onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); onMenu(r.left, r.bottom + 4); }}
        className="hidden group-hover:flex group-focus-within:flex shrink-0 w-6 h-6 items-center justify-center rounded text-gray-500 dark:text-white/50 hover:bg-gray-300/60 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white">
        <MoreHorizontalIcon className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function SectionHeader({ label, count, open, onToggle }: { label: string; count: number; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" aria-expanded={open} onClick={onToggle}
      className="w-full flex items-center h-8 px-2 rounded-md text-chat-note font-medium text-gray-500 dark:text-white/45 hover:bg-white dark:hover:bg-white/[0.05]">
      <span className="flex-1 text-left">{label}</span>
      <span className="tabular-nums mr-1.5">{count}</span>
      <ChevronRightIcon className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`} />
    </button>
  );
}

/** Linha fina das seções de baixo (Adiadas, Concluídas): pasta apagada até o hover, título e agente. */
function SlimRow({ name, title, agentId, subtitle, onOpen, onMenu }: { name: string; title: string; agentId: string; subtitle?: string; onOpen: () => void; onMenu?: (x: number, y: number) => void }) {
  const { t } = useTranslation();
  const Icon = agentIcon(agentId);
  const openMenu = (e: React.MouseEvent<HTMLElement>) => {
    if (!onMenu) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    onMenu(rect.left, rect.bottom + 4);
  };
  return (
    <div className="group min-h-9 shrink-0 flex items-center rounded-md hover:bg-white dark:hover:bg-white/[0.05]" onContextMenu={openMenu}>
      <button type="button" onClick={onOpen} title={title}
        className="min-w-0 flex-1 min-h-9 flex items-center gap-2.5 px-2.5 rounded-md text-left text-chat-note text-gray-600 dark:text-white/60">
        <span className="opacity-40 grayscale group-hover:opacity-100 group-hover:grayscale-0"><ProjectBadge name={name} size="sm" /></span>
        <span className="flex-1 min-w-0 flex flex-col justify-center">
          <span className="truncate">{title}</span>
          {subtitle && <span className="truncate text-[10px] leading-3 text-gray-400 dark:text-white/35">{subtitle}</span>}
        </span>
        <Icon className="w-3.5 h-3.5 shrink-0 opacity-60" />
      </button>
      {onMenu && <button type="button" aria-label={t("chat.sidebar.more")} title={t("chat.sidebar.more")} onClick={openMenu}
        className="mr-1 hidden group-hover:flex group-focus-within:flex w-6 h-6 items-center justify-center rounded text-gray-500 dark:text-white/50 hover:bg-gray-200/70 dark:hover:bg-white/10">
        <MoreHorizontalIcon className="w-3.5 h-3.5" />
      </button>}
    </div>
  );
}

function FolderFilter({ folders, value, onChange }: { folders: string[]; value: string | null; onChange: (v: string | null) => void }) {
  const { t } = useTranslation();
  const { open, setOpen, ref } = usePopover();
  return (
    <div ref={ref} className="relative">
      <IconButton label={t("chat.sidebar.filter")} onClick={() => setOpen(!open)} active={value !== null}><FilterIcon className="w-4 h-4" /></IconButton>
      {open && (
        <div role="menu" aria-label={t("chat.sidebar.filter")}
          className="absolute left-0 top-full mt-1 z-50 w-56 max-h-72 cc-scroll-hidden p-1 rounded-lg text-chat-note
            bg-white/95 dark:bg-surface-raised/95 backdrop-blur-xl shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_16px_40px_-18px_rgba(0,0,0,0.55)]">
          <MenuItem on={value === null} onClick={() => { onChange(null); setOpen(false); }}>{t("chat.sidebar.allFolders")}</MenuItem>
          {folders.map((f) => (
            <MenuItem key={f} on={value === f} onClick={() => { onChange(f); setOpen(false); }}>
              <ProjectBadge name={f} size="sm" /> <span className="truncate">{f}</span>
            </MenuItem>
          ))}
        </div>
      )}
    </div>
  );
}

function MenuItem({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={on} onClick={onClick}
      className={`w-full flex items-center gap-2 min-h-7 px-2 rounded text-left text-gray-800 dark:text-white/85
        ${on ? "bg-gray-100 dark:bg-white/10" : "hover:bg-gray-100 dark:hover:bg-white/[0.07]"}`}>
      {children}
    </button>
  );
}

export function IconButton({ label, onClick, children, className = "", active = false }: {
  label: string; onClick: () => void; children: React.ReactNode; className?: string; active?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} data-tauri-drag-region="false" aria-pressed={active || undefined}
      className={`w-7 h-7 shrink-0 flex items-center justify-center rounded-md
        ${active ? "bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-white" : "text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white"} ${className}`}>
      {children}
    </button>
  );
}

export function FooterButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label}
      className="w-8 h-8 flex items-center justify-center rounded-md text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white">
      {children}
    </button>
  );
}
