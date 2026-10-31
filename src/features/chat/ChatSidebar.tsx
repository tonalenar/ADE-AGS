import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { WindowLights } from "@/app/WindowLights";
import { useUiStore } from "@/app/uiStore";
import { agentIcon } from "@/features/agents/agentIcons";
import { useTabsStore } from "@/features/tabs/store";
import { SkillPalette, type SkillScopeTarget } from "@/features/skills/SkillPalette";
import { homeDir } from "@/shared/ipc/window";
import { ContextMenu, type ContextMenuItem } from "@/shared/ui/ContextMenu";

import { newConversation, newConversationIn, openConversation } from "./chatActions";
import { BotIcon, BranchIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, ClockIcon, DesignIcon, EyeIcon, FilterIcon, FolderPlusIcon, GlobeIcon, ListIcon, MoreHorizontalIcon, NewChatIcon, PenIcon, PlusIcon, PullRequestIcon, PushPinIcon, SearchIcon, SettingsIcon, SidebarIcon, UsageIcon, UsersIcon, WarnIcon, WrenchIcon, XIcon } from "./chatIcons";
import { projectTone, type ChatProject, type ConversationCard } from "./chatModel";
import { useLiveSummary } from "./liveSummary";
import { useChatLive } from "./liveStore";
import { INBOX_SHORTCUT } from "./permissions/PermissionCard";
import { waitingAgents } from "./permissions/permissionModel";
import { toggleInbox, usePendingAsks } from "./permissions/permissionsStore";
import { reopenSettled, setCollapsed, setUnread, settleConversation, snoozeConversation, togglePinned, toggleSection, unsnoozeConversation, useShelf } from "./shelf";
import { addSurface } from "./store";
import { buildSections, cleanTitle, countStates, initialOf, stepFocus, toggleAllProjects, visibleIds, type SessionSection } from "./sidebar/sessionsModel";
import { closeWorkspaceFolder, forgetWorkspaceFolder } from "./sidebar/workspaceActions";
import { useAutoUnread } from "./sidebar/useAutoUnread";
import { folderName, threadIdOf } from "./structured/model";
import { chatThreadRename } from "./structured/ipc";
import { openThread, reloadThreads, settleThread, useStructured } from "./structured/store";
import { TeamBadge, TeamMembers, conversationDragProps, useTeamGrouping } from "./team/TeamSidebar";
import { usePopover } from "./usePopover";

/** Abre o cartão: a conversa por protocolo, ou a aba do agente. */
function openCard(key: string): void {
  const threadId = threadIdOf(key);
  if (threadId) openThread(threadId);
  else openConversation(key);
}

/** A largura da sidebar (a padrão do T3 Code). */
export const CHAT_SIDEBAR_W = 256;

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
export function ChatSidebar({ cards, closed, diffs, selectedId, onCollapse, onAddProject, onReopen, onNew = newConversation, onNewIn = newConversationIn, onOpened, onArtifacts = () => addSurface("design"), width = CHAT_SIDEBAR_W, showHeader = true, showFooter = true, modeSwitch = null, extraTop = null, extraBottom = null }: {
  cards: ConversationCard[];
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
  const [folder, setFolder] = useState<string | null>(null);
  const [closedOpen, setClosedOpen] = useState(false);
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [skillTarget, setSkillTarget] = useState<SkillScopeTarget | null>(null);
  const [hiddenKids, setHiddenKids] = useState<string[]>([]);
  const navRef = useRef<HTMLElement>(null);
  const snoozedIds = useShelf((s) => s.snoozed);
  const settled = useShelf((s) => s.settled);
  const pinned = useShelf((s) => s.pinned);
  const unread = useShelf((s) => s.unread);
  const collapsed = useShelf((s) => s.collapsed);
  const threads = useStructured((s) => s.threads);
  const settledThreads = useMemo(() => threads.filter((th) => th.state === "settled"), [threads]);
  const folders = useMemo(() => [...new Set(cards.map((c) => c.project))], [cards]);
  useAutoUnread(cards, selectedId);
  // O time fica sob a conversa do orquestrador: os integrantes saem da lista e aparecem indentados (prancheta 15).
  const grouping = useTeamGrouping(cards);
  const sections = useMemo(
    () => buildSections(cards, { query, folder, pinned, snoozed: snoozedIds, nested: grouping.nested, collapsed }),
    [cards, query, folder, pinned, snoozedIds, grouping.nested, collapsed],
  );
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
  const doneCount = settled.length + settledThreads.length + closed.length;
  const counts = useMemo(() => countStates(cards), [cards]);
  const userName = useUserName();

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
  const rowMenu = (card: ConversationCard): ContextMenuItem[] => [
    { key: "pin", label: pinned.includes(card.tabId) ? t("chat.sidebar.unpin") : t("chat.sidebar.pin"), icon: <PushPinIcon className="w-4 h-4" />, onSelect: () => togglePinned(card.tabId) },
    { key: "rename", label: t("chat.sidebar.rename"), icon: <PenIcon className="w-4 h-4" />, hint: "F2", onSelect: () => setRenaming(card.tabId) },
    { key: "read", label: unread.includes(card.tabId) ? t("chat.sidebar.markRead") : t("chat.sidebar.markUnread"), icon: <EyeIcon className="w-4 h-4" />, onSelect: () => setUnread(card.tabId, !unread.includes(card.tabId)) },
    // Só as abas (TUI) têm skills e fecham como aba; a conversa por protocolo não.
    ...(threadIdOf(card.tabId) ? [] : [{
      key: "skills", label: t("skills.scope.tabAction"), icon: <WrenchIcon className="w-4 h-4" />, separator: true,
      onSelect: () => setSkillTarget({ scope: "tab", workspaceId, tabId: card.tabId, agentId: card.agentId, label: card.title }),
    }]),
    { key: "snooze", label: t("chat.sidebar.snooze"), icon: <ClockIcon className="w-4 h-4" />, separator: !!threadIdOf(card.tabId), onSelect: () => snoozeConversation(card.tabId) },
    { key: "settle", label: t("chat.sidebar.settle"), icon: <CheckIcon className="w-4 h-4" />, hint: "Del", onSelect: () => settle(card) },
    ...(threadIdOf(card.tabId) ? [] : [{
      key: "close", label: t("tabs.close"), icon: <XIcon className="w-4 h-4" />, danger: true,
      onSelect: () => useTabsStore.getState().closeTab(card.tabId),
    }]),
  ];
  const groupMenu = (section: SessionSection): ContextMenuItem[] => {
    const cwd = section.items[0]?.cwd;
    return [
      { key: "all", label: sections.filter((x) => x.kind === "project").every((x) => x.collapsed) ? t("chat.sidebar.group.expandAll") : t("chat.sidebar.group.collapseAll"),
        icon: <ChevronRightIcon className="w-4 h-4" />, onSelect: () => setCollapsed(toggleAllProjects(sections, collapsed)) },
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

      <nav ref={navRef} aria-label={t("chat.sidebar.active")} onKeyDown={onNavKey} className="flex-1 min-h-0 cc-scroll px-2 pt-3 flex flex-col gap-3">
        {cards.length === 0 && (
          <p className="px-2 py-6 text-center text-chat-note text-gray-400 dark:text-white/40">{t("chat.sidebar.empty")}</p>
        )}
        {sections.map((section) => (
          <SectionBlock key={section.id} section={section} onMenu={(e) => openMenuAt(e, groupMenu(section))}
            onNew={section.kind === "project" && section.items[0]?.cwd ? () => onNewIn(section.items[0]!.cwd) : undefined}>
            {section.items.map((card) => {
              const kids = grouping.groups[card.tabId] ?? [];
              const kidsHidden = hiddenKids.includes(card.tabId);
              return (
                <Fragment key={card.tabId}>
                  <SessionRow card={card} diff={diffs[card.cwd]} selected={card.tabId === selectedId} asks={asksBy[card.tabId] ?? 0}
                    pinned={pinned.includes(card.tabId)} unread={unread.includes(card.tabId)} renaming={renaming === card.tabId} onOpened={onOpened}
                    kids={kids.length} kidsHidden={kidsHidden} onToggleKids={() => setHiddenKids((h) => (h.includes(card.tabId) ? h.filter((x) => x !== card.tabId) : [...h, card.tabId]))}
                    onRename={(raw) => commitRename(card, raw)} onCancelRename={() => setRenaming(null)} onStartRename={() => setRenaming(card.tabId)}
                    onSettle={() => settle(card)} onMenu={(x, y) => setMenu({ x, y, items: rowMenu(card) })} />
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

      {snoozed.length > 0 && (
        <div className="px-2 pt-1">
          <SectionHeader label={t("chat.sidebar.snoozed")} count={snoozed.length} open={snoozedOpen} onToggle={() => setSnoozedOpen(!snoozedOpen)} />
          {snoozedOpen && (
            <div className="max-h-40 cc-scroll flex flex-col">
              {snoozed.map((c) => (
                <SlimRow key={c.tabId} name={c.project} title={c.title} agentId={c.agentId}
                  onOpen={() => { unsnoozeConversation(c.tabId); openCard(c.tabId); onOpened?.(); }} />
              ))}
            </div>
          )}
        </div>
      )}

      {doneCount > 0 && (
        <div className="px-2 pt-1">
          <SectionHeader label={t("chat.sidebar.closed")} count={doneCount} open={closedOpen} onToggle={() => setClosedOpen(!closedOpen)} />
          {closedOpen && (
            <div className="max-h-48 cc-scroll flex flex-col">
              {settled.map((e) => (
                <SlimRow key={e.id} name={e.cwd.split(/[\\/]/).filter(Boolean).pop() ?? e.cwd} title={e.title} agentId={e.agentId}
                  onOpen={() => { reopenSettled(e.id); onOpened?.(); }} />
              ))}
              {settledThreads.map((th) => (
                <SlimRow key={th.id} name={folderName(th.cwd)} title={th.title} agentId={th.agentId}
                  onOpen={() => { settleThread(th.id, false); openThread(th.id); onOpened?.(); }} />
              ))}
              {closed.map((p) => (
                <div key={p.cwd} className="group flex items-center rounded-md hover:bg-white dark:hover:bg-white/[0.05]"
                  onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: [
                    { key: "reopen", label: t("chat.sidebar.reopen", { name: p.name }), icon: <ChevronRightIcon className="w-4 h-4" />, onSelect: () => onReopen(p.cwd) },
                    { key: "forget", label: t("workspaces.forget"), icon: <XIcon className="w-4 h-4" />, danger: true, separator: true, onSelect: () => { void forgetWorkspaceFolder(p.cwd); } },
                  ] }); }}>
                  <button type="button" onClick={() => onReopen(p.cwd)} title={t("chat.sidebar.reopen", { name: p.name })}
                    className="flex-1 min-w-0 h-9 flex items-center gap-2.5 px-2.5 text-left text-chat-note text-gray-600 dark:text-white/60">
                    <ProjectBadge name={p.name} size="sm" muted />
                    <span className="flex-1 truncate">{p.name}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
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
function SectionBlock({ section, onMenu, onNew, children }: { section: SessionSection; onMenu: (e: React.MouseEvent<HTMLElement>) => void; onNew?: () => void; children: React.ReactNode }) {
  const { t } = useTranslation();
  const label = section.kind === "pinned" ? t("chat.sidebar.pinned") : section.label;
  return (
    <section aria-label={label} className="flex flex-col gap-0.5">
      <div className="group flex items-center h-7 px-2.5 text-[12.5px] text-gray-500 dark:text-white/50">
        <button type="button" aria-expanded={!section.collapsed} onClick={() => toggleSection(section.id)} title={section.kind === "project" ? section.items[0]?.cwd : undefined}
          className="min-w-0 flex items-center gap-1.5 rounded hover:text-gray-900 dark:hover:text-white">
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

/** O quadradinho com a inicial da pasta. */
export function ProjectBadge({ name, size = "md", muted = false }: { name: string; size?: "sm" | "md"; muted?: boolean }) {
  const box = size === "sm" ? "w-3.5 h-3.5 text-[8px] rounded" : "w-4 h-4 text-[9px] rounded";
  return (
    <span aria-hidden="true"
      className={`${box} shrink-0 inline-flex items-center justify-center font-bold text-white ${projectTone(name)} ${muted ? "opacity-50 grayscale" : ""}`}>
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * UMA linha por conversa (o título numa linha só). À direita, discretos: o giro de quem trabalha, a
 * bolinha de "não lida" ou "aguardando você", o "⑂ N" de quem tem integrantes do time e a seta que os
 * esconde; o ⋯ aparece no hover e no foco. A selecionada leva fundo cinza arredondado.
 */
function SessionRow({ card, diff, selected, asks, pinned, unread, renaming, onOpened, kids, kidsHidden, onToggleKids, onRename, onCancelRename, onStartRename, onSettle, onMenu }: {
  card: ConversationCard; diff: FolderDiff | undefined; selected: boolean; asks: number;
  pinned: boolean; unread: boolean; renaming: boolean; onOpened?: () => void;
  kids: number; kidsHidden: boolean; onToggleKids: () => void;
  onRename: (title: string) => void; onCancelRename: () => void; onStartRename: () => void; onSettle: () => void;
  /** Abre o menu de contexto na posição da tela. */
  onMenu: (x: number, y: number) => void;
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
    <div role="button" tabIndex={0} data-session-id={card.tabId} onClick={() => { if (!renaming) open(); }} aria-current={selected ? "page" : undefined} title={tip}
      {...conversationDragProps(card.tabId)}
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
function SlimRow({ name, title, agentId, onOpen }: { name: string; title: string; agentId: string; onOpen: () => void }) {
  const Icon = agentIcon(agentId);
  return (
    <button type="button" onClick={onOpen} title={title}
      className="group h-9 shrink-0 flex items-center gap-2.5 px-2.5 rounded-md text-left text-chat-note text-gray-600 dark:text-white/60 hover:bg-white dark:hover:bg-white/[0.05]">
      <span className="opacity-40 grayscale group-hover:opacity-100 group-hover:grayscale-0"><ProjectBadge name={name} size="sm" /></span>
      <span className="flex-1 truncate">{title}</span>
      <Icon className="w-3.5 h-3.5 shrink-0 opacity-60" />
    </button>
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
          className="absolute left-0 top-full mt-1 z-50 w-56 max-h-72 cc-scroll p-1 rounded-lg text-chat-note
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
