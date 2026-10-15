import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertaToast, Button, ArchiveIcon, AddIcon } from "neogestify-ui-components";

import { agentIcon } from "@/features/agents/agentIcons";
import { RunningIcon } from "@/app/icons";
import { useMissionIndex } from "@/features/missions/groups";
import { useTabsStore } from "@/features/tabs/store";
import { openNewAgentWith } from "@/features/tabs/tabActions";
import { sendWhenReady } from "@/features/terminal/terminalRegistry";
import { ContextMenu } from "@/shared/ui/ContextMenu";
import { elapsed } from "@/features/workspaces/useRepoInfo";
import { MissingSkillsDialog } from "@/features/sessions/MissingSkillsDialog";
import { ResumeOptionsDialog } from "@/features/sessions/ResumeOptionsDialog";

import { isResumable } from "./agentResume";
import { boardKeyOfTab, useCanvasStore } from "@/features/canvas/store";
import { CanvasConversations } from "./CanvasConversations";
import { joinActiveConversation, startConversation } from "./conversationFlow";
import { parseConversationSnapshot } from "./conversationModel";
import { useConversationsStore } from "./conversationsStore";
import {
  buildConversations, continuePrompt, countHidden, fallbackNotice, filterConversations, groupByDay,
  type Conversation, type OpenTabInfo,
} from "./projectConversations";
import { missionSessionIds, refreshSessionTitles, updateHistoryEntry } from "./ipc.conversations";
import { sessionMarkdown, sessionTitle } from "./ipc";
import { bucketDefaultCollapsed, useConversationUi } from "./conversationUi";
import { useSessionsStore } from "./store";
import { useResumeSession } from "./useResumeSession";

/** Quantas conversas se mostram antes de "Mostrar mais". */
const PAGE = 8;
/** A partir de quantas conversas aparece a busca. */
const SEARCH_FROM = 6;
const EMPTY_SET: ReadonlySet<string> = new Set();

const secondsNow = () => Math.floor(Date.now() / 1000);

/**
 * As conversas de um projeto: as abertas e as arquivadas juntas, mais recentes primeiro. Clicar numa aberta vai
 * até ela; numa arquivada reabre e retoma de onde parou (mesma sessão, conta, skills e posição no canvas). Um
 * agente que não sabe retomar abre uma nova conversa com o resumo da anterior. Os terminais de missão ficam
 * de fora (vivem na própria missão). "+ Nova" abre o assistente de agente na pasta do projeto.
 *
 * O arquivamento é automático (ao fechar a aba e por checkpoints periódicos); aqui só se fixa, renomeia, oculta
 * (e reexibe) ou continua a partir de uma.
 */
export function ConversationList({ cwd, groupCwds, projectKey, workspaceId, onOpenTab, onTabMenu }: {
  cwd: string;
  /** A raiz do projeto: agrupa as conversas-canvas dele. */
  projectKey: string;
  groupCwds: string[];
  workspaceId: string;
  onOpenTab: (tabId: string) => void;
  /** Menu de uma aba aberta (skills, fechar): é o mesmo de antes. */
  onTabMenu: (x: number, y: number, tabId: string) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const addTab = useTabsStore((s) => s.addTab);
  const tabs = useTabsStore((s) => s.tabs);
  const updateTab = useTabsStore((s) => s.updateTab);
  const history = useSessionsStore((s) => s.history);
  const loadHistory = useSessionsStore((s) => s.loadHistory);
  const deleteSession = useSessionsStore((s) => s.deleteSession);
  const missionOf = useMissionIndex();
  const { pendingResume, setPendingResume, pendingSkillChoice, setPendingSkillChoice, openSession, resume } = useResumeSession();

  const collapsed = useConversationUi((s) => !!s.projects[projectKey]);
  const toggleProject = useConversationUi((s) => s.toggleProject);
  const bucketState = useConversationUi((s) => s.buckets);
  const toggleBucket = useConversationUi((s) => s.toggleBucket);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [showHidden, setShowHidden] = useState(false);
  const [missionSessions, setMissionSessions] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [menu, setMenu] = useState<{ x: number; y: number; conv: Conversation } | null>(null);
  const [renaming, setRenaming] = useState<{ key: string; value: string } | null>(null);
  /** A conversa que espera a confirmação de apagar (se desarma sozinha). */
  const [armed, setArmed] = useState<string | null>(null);

  // O histórico se recarrega ao abrir e quando o número de abas muda (fechar uma arquiva a sessão).
  useEffect(() => { void loadHistory(workspaceId); }, [workspaceId, tabs.length, loadHistory]);
  // Os títulos fracos se refazem uma vez por projeto aberto (lê os arquivos de sessão fora do banco).
  useEffect(() => {
    let alive = true;
    refreshSessionTitles(workspaceId)
      .then((changed) => { if (alive && changed > 0) void loadHistory(workspaceId); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [workspaceId, loadHistory]);
  // As sessões que pertencem a missões: não são conversas comuns do projeto.
  useEffect(() => {
    let alive = true;
    missionSessionIds(workspaceId)
      .then((ids) => { if (alive) setMissionSessions(new Set(ids)); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [workspaceId, tabs.length]);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(null), 3000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const convRows = useConversationsStore((s) => s.rows);
  const boards = useCanvasStore((s) => s.boards);
  const projectConvs = useMemo(() => convRows.filter((r) => r.projectKey === projectKey), [convRows, projectKey]);
  // As abas e as sessões de uma conversa-canvas aparecem dentro dela, não soltas na lista de sessões anteriores.
  const inConversation = useMemo(() => {
    const tabIds = new Set<string>();
    const sessionIds = new Set<string>();
    for (const tab of tabs) {
      if (boardKeyOfTab(tab, boards).includes("#c:")) {
        tabIds.add(tab.id);
        if (tab.sessionId) sessionIds.add(tab.sessionId);
      }
    }
    for (const row of projectConvs) {
      for (const terminal of parseConversationSnapshot(row.terminals).terminals) if (terminal.sessionId) sessionIds.add(terminal.sessionId);
    }
    return { tabIds, sessionIds };
  }, [tabs, boards, projectConvs]);
  const excludeTabIds = useMemo(
    () => new Set([...tabs.filter((tab) => missionOf[tab.id]).map((tab) => tab.id), ...inConversation.tabIds]),
    [tabs, missionOf, inConversation],
  );
  const excludeSessionIds = useMemo(() => new Set([...missionSessions, ...inConversation.sessionIds]), [missionSessions, inConversation]);

  const openTabs = useMemo<OpenTabInfo[]>(() => tabs
    .filter((tab) => tab.agentId !== "bash")
    .map((tab) => ({
      tabId: tab.id,
      title: tab.title,
      agentId: tab.agentId,
      agentLabel: tab.agentLabel,
      cwd: tab.cwd,
      sessionId: tab.sessionId,
      historyId: tab.historyId,
      openedAt: tab.openedAt,
      status: tab.ptyId == null ? "starting" as const : "running" as const,
      titleIsCustom: tab.titleIsCustom,
    })), [tabs]);

  // O título real das conversas em andamento (a sessão do agente). Só entra na lista a que já teve uma mensagem.
  const [openTitles, setOpenTitles] = useState<ReadonlyMap<string, string | null>>(new Map());
  const openSignature = openTabs.map((tab) => `${tab.tabId}:${tab.sessionId ?? ""}`).join("|");
  useEffect(() => {
    let alive = true;
    const run = async () => {
      const next = new Map<string, string | null>();
      await Promise.all(openTabs.filter((tab) => tab.sessionId && !excludeTabIds.has(tab.tabId)).map(async (tab) => {
        try {
          const found = await sessionTitle({
            agentId: tab.agentId, cwd: tab.cwd, sessionId: tab.sessionId ?? null, fallback: "",
            accountId: useTabsStore.getState().tabs.find((x) => x.id === tab.tabId)?.accountId ?? null,
          });
          next.set(tab.tabId, found.source === "fallback" || !found.title.trim() ? null : found.title);
        } catch {
          next.set(tab.tabId, null);
        }
      }));
      if (alive) setOpenTitles(next);
    };
    void run();
    const timer = window.setInterval(() => void run(), 20_000);
    return () => { alive = false; window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSignature, excludeTabIds]);

  const all = useMemo(
    () => buildConversations({
      groupCwds, tabs: openTabs, history, resumable: isResumable, now: secondsNow(),
      excludeTabIds, excludeSessionIds, includeHidden: showHidden, openTitles,
    }),
    [groupCwds, openTabs, history, excludeTabIds, excludeSessionIds, showHidden, openTitles],
  );
  const hiddenCount = useMemo(
    () => countHidden({ groupCwds, history, excludeSessionIds }),
    [groupCwds, history, excludeSessionIds],
  );
  const shown = useMemo(() => filterConversations(all, query), [all, query]);
  const visible = useMemo(() => shown.slice(0, query ? shown.length : limit), [shown, limit, query]);
  const buckets = useMemo(() => groupByDay(visible, secondsNow()), [visible]);

  const entryOf = (conv: Conversation) => history.find((h) => h.id === conv.historyId) ?? null;

  const continueFrom = async (conv: Conversation) => {
    let tail = conv.preview ?? "";
    if (conv.historyId) {
      try {
        tail = (await sessionMarkdown(conv.historyId)) || tail;
      } catch {
        /* sem a conversa inteira, vale a prévia */
      }
    }
    openNewAgentWith({ cwd: conv.cwd || cwd, title: t("conversations.continueTitle", { title: conv.title }), prompt: continuePrompt(conv, tail) });
  };

  /**
   * Continua uma conversa que não dá para retomar: abre uma aba NOVA no mesmo agente, conta e entorno, já com o
   * resumo da anterior (sem passar pelo assistente). É o que acontece quando o agente não retoma sessões ou
   * quando a sessão nunca teve o id gravado.
   */
  const continueInSameAgent = async (conv: Conversation, entry: NonNullable<ReturnType<typeof entryOf>>) => {
    let tail = conv.preview ?? "";
    if (conv.historyId) {
      try {
        tail = (await sessionMarkdown(conv.historyId)) || tail;
      } catch {
        /* sem a conversa inteira, vale a prévia */
      }
    }
    const tabId = addTab({
      cwd: conv.cwd || cwd,
      agent: { id: entry.agentId, label: entry.agentLabel, command: entry.command, available: true },
      accountId: entry.accountId ?? undefined,
      prelaunch: entry.prelaunch,
      title: t("conversations.continueTitle", { title: conv.title }),
    });
    joinActiveConversation(tabId, conv.cwd || cwd);
    sendWhenReady(tabId, continuePrompt(conv, tail));
    navigate("/workspace");
  };

  const open = async (conv: Conversation) => {
    if (conv.tabId) return onOpenTab(conv.tabId);
    const entry = entryOf(conv);
    if (!entry) return;
    // Sem o que retomar, abre uma conversa nova, no mesmo agente, com o resumo da anterior. E diz o motivo certo.
    if (fallbackNotice(conv) === "summary") {
      const why = isResumable(conv.agentId) ? "conversations.noSession" : "conversations.noResume";
      AlertaToast(t("conversations.title"), t(why, { agent: conv.agentLabel }), "info", 6000);
      try {
        await continueInSameAgent(conv, entry);
      } catch (e) {
        AlertaToast(t("conversations.title"), String(e), "error", 6000);
      }
      return;
    }
    try {
      await resume(entry);
    } catch (e) {
      AlertaToast(t("conversations.title"), String(e), "error", 6000);
    }
  };

  const patch = async (conv: Conversation, change: Parameters<typeof updateHistoryEntry>[1]) => {
    if (!conv.historyId) return;
    try {
      await updateHistoryEntry(conv.historyId, change);
      await loadHistory(workspaceId);
    } catch (e) {
      AlertaToast(t("conversations.title"), String(e), "error", 6000);
    }
  };

  const commitRename = async (conv: Conversation, value: string) => {
    setRenaming(null);
    const title = value.trim();
    if (conv.tabId) {
      if (title) updateTab(conv.tabId, { title, titleIsCustom: true });
      return;
    }
    await patch(conv, { customTitle: title || null });
  };

  const forget = async (conv: Conversation) => {
    if (!conv.historyId) return;
    if (armed !== conv.key) { setArmed(conv.key); return; }
    setArmed(null);
    try {
      await deleteSession(conv.historyId, workspaceId);
    } catch (e) {
      AlertaToast(t("conversations.title"), String(e), "error", 6000);
    }
  };

  /** Nova conversa = novo canvas: salva e fecha a atual (se houver) e abre o assistente de agente na nova. */
  const startNew = async () => {
    try {
      const row = await startConversation({
        workspaceId, cwd, projectKey,
      });
      if (row) openNewAgentWith({ cwd, title: t("conversations.newTitle") });
    } catch (e) {
      AlertaToast(t("conversations.title"), String(e), "error", 7000);
    }
  };

  const bucketLabel = (bucket: string) => t(`conversations.bucket.${bucket}`);

  /** O menu de uma conversa: o das abertas leva ao menu antigo (skills, fechar) em "Mais ações". */
  const menuItems = (conv: Conversation, x: number, y: number) => {
    const live = conv.tabId !== null;
    const pinItem = {
      key: "pin",
      label: conv.pinned ? t("conversations.unpin") : conv.historyId ? t("conversations.pin") : t("conversations.pinWait"),
      disabled: !conv.historyId,
      separator: !live,
      onSelect: () => void patch(conv, { pinned: !conv.pinned }),
    };
    const renameItem = { key: "rename", label: t("conversations.rename"), onSelect: () => setRenaming({ key: conv.key, value: conv.title }) };
    const continueItem = { key: "continue", label: t("conversations.continueFrom"), onSelect: () => void continueFrom(conv) };
    if (live) {
      return [
        continueItem,
        pinItem,
        renameItem,
        { key: "more", label: t("conversations.moreActions"), separator: true, onSelect: () => onTabMenu(x, y, conv.tabId!) },
      ];
    }
    return [
      { key: "open", label: fallbackNotice(conv) === "resume" ? t("conversations.resume") : t("conversations.resumeSummary"), onSelect: () => void open(conv) },
      continueItem,
      pinItem,
      renameItem,
      conv.hidden
        ? { key: "unhide", label: t("conversations.unhide"), onSelect: () => void patch(conv, { hidden: false }) }
        : { key: "hide", label: t("conversations.hide"), onSelect: () => void patch(conv, { hidden: true }) },
      { key: "forget", label: t("conversations.forget"), danger: true, separator: true, onSelect: () => setArmed(conv.key) },
    ];
  };

  return (
    <div className="flex flex-col gap-0.5" aria-label={t("conversations.title")}>
      <div className="flex items-center gap-1.5 pl-1.5 pr-0.5">
        <button type="button" aria-expanded={!collapsed} onClick={() => toggleProject(projectKey)}
          title={collapsed ? t("conversations.expand") : t("conversations.collapse")}
          className="cc-t flex flex-1 min-w-0 items-center gap-1 h-5 rounded text-left text-[9.5px] font-bold uppercase tracking-[0.09em] text-gray-400 dark:text-white/30 hover:text-gray-600 dark:hover:text-white/60">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden
            className={`w-3 h-3 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}><path d="m9 6 6 6-6 6" /></svg>
          <span className="truncate">{t("conversations.title")}</span>
          {(all.length > 0 || projectConvs.length > 0) && <span className="tabular-nums font-normal">{all.length + projectConvs.filter((r) => !r.hidden).length}</span>}
        </button>
        <Button variant="icon" aria-label={t("conversations.new")} title={t("conversations.newHint")}
          onClick={() => void startNew()}
          className="cc-t flex items-center gap-1 h-5 px-1.5 rounded-md text-[10.5px] text-gray-500 dark:text-white/45 hover:text-gray-800 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10">
          <AddIcon className="w-3 h-3" />{t("conversations.new")}
        </Button>
      </div>

      {!collapsed && all.length >= SEARCH_FROM && (
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("conversations.search")} aria-label={t("conversations.search")}
          className="mx-1 mb-0.5 h-6 px-2 rounded-md text-[11px] outline-none bg-white dark:bg-white/6 border border-gray-200 dark:border-white/10 focus:border-accent-400 text-gray-800 dark:text-gray-100" />
      )}

      {!collapsed && <CanvasConversations projectKey={projectKey} cwd={cwd} workspaceId={workspaceId}
        onOpened={(tabId) => { if (tabId) onOpenTab(tabId); }} />}
      {!collapsed && projectConvs.some((r) => !r.hidden) && all.length > 0 && (
        <p className="pl-[18px] pt-1.5 text-[9px] font-bold uppercase tracking-wider text-gray-400/80 dark:text-white/25">{t("conversations.canvas.older")}</p>
      )}

      {!collapsed && all.length === 0 && projectConvs.length === 0 && <p className="px-[18px] py-1 text-[10.5px] text-gray-400 dark:text-white/30">{t("conversations.empty")}</p>}
      {!collapsed && shown.length === 0 && all.length > 0 && <p className="px-[18px] py-1 text-[10.5px] text-gray-400 dark:text-white/30">{t("conversations.noMatch")}</p>}

      {!collapsed && buckets.map((group) => {
        const closed = group.bucket !== "open" && !query && (bucketState[group.bucket] ?? bucketDefaultCollapsed(group.bucket));
        return (
        <div key={group.bucket} className="flex flex-col gap-px">
          {group.bucket !== "open" && (
            <button type="button" aria-expanded={!closed} onClick={() => toggleBucket(group.bucket)}
              className="cc-t flex items-center gap-1 pl-[14px] pt-1 text-left text-[9px] uppercase tracking-wider text-gray-400/80 dark:text-white/25 hover:text-gray-600 dark:hover:text-white/50">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden
                className={`w-2.5 h-2.5 shrink-0 transition-transform ${closed ? "" : "rotate-90"}`}><path d="m9 6 6 6-6 6" /></svg>
              {bucketLabel(group.bucket)} <span className="tabular-nums">{group.items.length}</span>
            </button>
          )}
          {!closed && group.items.map((conv) => {
            const Icon = agentIcon(conv.agentId, conv.agentLabel);
            const active = conv.tabId !== null && conv.tabId === useTabsStore.getState().activeTabId;
            return (
              <div key={conv.key}>
                {renaming?.key === conv.key ? (
                  <input autoFocus value={renaming.value} maxLength={120} aria-label={t("conversations.rename")}
                    onChange={(e) => setRenaming({ key: conv.key, value: e.target.value })}
                    onBlur={() => void commitRename(conv, renaming.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void commitRename(conv, renaming.value); if (e.key === "Escape") setRenaming(null); }}
                    className="mx-1 h-[25px] w-[calc(100%-0.5rem)] px-2 rounded-md text-[11px] outline-none bg-white dark:bg-white/8 border border-accent-400 text-gray-800 dark:text-gray-100" />
                ) : (
                  <Button variant="custom" onClick={() => void open(conv)}
                    onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, conv }); }}
                    title={[conv.title, conv.preview, conv.cwd].filter(Boolean).join("\n\n")}
                    className={`flex items-center gap-2 h-[25px] pl-1.5 pr-1 rounded-md w-full text-left transition-colors duration-150
                      ${active ? "bg-accent-500/12 dark:bg-accent-400/13" : "hover:bg-gray-200/60 dark:hover:bg-white/5"} ${conv.hidden ? "opacity-60" : ""}`}>
                    {conv.state === "archived"
                      ? <ArchiveIcon className="w-3.5 h-3.5 shrink-0 text-gray-400 dark:text-white/25" />
                      : <RunningIcon className={`w-3.5 h-3.5 shrink-0 ${conv.state === "working" ? "text-emerald-500" : "text-amber-500"}`} />}
                    <span className="shrink-0 flex items-center justify-center w-3.5 h-3.5 rounded text-gray-500 dark:text-gray-400"><Icon className="w-3.5 h-3.5" /></span>
                    <span className={`flex-1 min-w-0 truncate text-[11px] ${active ? "text-gray-900 dark:text-accent-100" : conv.state === "archived" ? "text-gray-500 dark:text-gray-500" : "text-gray-600 dark:text-gray-400"}`}>
                      {conv.pinned && <span aria-hidden className="mr-1 text-accent-500">●</span>}{conv.title}
                    </span>
                    {armed === conv.key
                      ? <span className="shrink-0 text-[10px] font-medium text-red-500">{t("conversations.confirmForget")}</span>
                      : <span className="shrink-0 text-[10px] tabular-nums text-gray-400 dark:text-white/35">{elapsed(conv.lastActiveAt * 1000)}</span>}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
        );
      })}

      {!collapsed && !query && shown.length > visible.length && (
        <Button variant="custom" onClick={() => setLimit((n) => n + PAGE)}
          className="cc-t ml-[18px] h-5 w-fit px-1.5 rounded text-[10.5px] text-accent-600 dark:text-accent-300 hover:bg-accent-500/10">
          {t("conversations.showMore", { count: shown.length - visible.length })}
        </Button>
      )}

      {!collapsed && hiddenCount > 0 && (
        <Button variant="custom" aria-pressed={showHidden} onClick={() => setShowHidden((on) => !on)}
          className="cc-t ml-[18px] h-5 w-fit px-1.5 rounded text-[10.5px] text-gray-500 dark:text-white/40 hover:bg-gray-200/60 dark:hover:bg-white/5">
          {showHidden ? t("conversations.hideHidden") : t("conversations.showHidden", { count: hiddenCount })}
        </Button>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={menuItems(menu.conv, menu.x, menu.y)} />
      )}
      {armed && all.find((c) => c.key === armed) && (
        <p className="pl-[18px] pr-1 text-[10px] text-red-500">
          <button type="button" className="underline" onClick={() => { const conv = all.find((c) => c.key === armed); if (conv) void forget(conv); }}>
            {t("conversations.forgetNow")}
          </button>
        </p>
      )}

      {pendingSkillChoice && (
        <ResumeOptionsDialog entry={pendingSkillChoice.entry} statuses={pendingSkillChoice.statuses}
          onCancel={() => setPendingSkillChoice(null)}
          onConfirm={({ skillIds, prelaunch }) => { const { entry } = pendingSkillChoice; setPendingSkillChoice(null); openSession(entry, skillIds, prelaunch).catch(console.error); }} />
      )}
      {pendingResume && (
        <MissingSkillsDialog sessionTitle={pendingResume.entry.title ?? pendingResume.entry.agentLabel} statuses={pendingResume.statuses}
          onCancel={() => setPendingResume(null)}
          onContinue={() => { const { entry } = pendingResume; setPendingResume(null); openSession(entry).catch(console.error); }} />
      )}
    </div>
  );
}
