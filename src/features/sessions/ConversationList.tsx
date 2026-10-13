import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertaToast, Button, ArchiveIcon, AddIcon } from "neogestify-ui-components";

import { agentIcon } from "@/features/agents/agentIcons";
import { RunningIcon } from "@/app/icons";
import { useTabsStore } from "@/features/tabs/store";
import { openNewAgentWith } from "@/features/tabs/tabActions";
import { ContextMenu } from "@/shared/ui/ContextMenu";
import { elapsed } from "@/features/workspaces/useRepoInfo";
import { MissingSkillsDialog } from "@/features/sessions/MissingSkillsDialog";
import { ResumeOptionsDialog } from "@/features/sessions/ResumeOptionsDialog";

import { isResumable } from "./agentResume";
import {
  buildConversations, continuePrompt, filterConversations, groupByDay,
  type Conversation, type OpenTabInfo,
} from "./projectConversations";
import { updateHistoryEntry } from "./ipc.conversations";
import { sessionMarkdown } from "./ipc";
import { useSessionsStore } from "./store";
import { useResumeSession } from "./useResumeSession";

/** Quantas conversas se mostram antes de "Mostrar mais". */
const PAGE = 8;
/** A partir de quantas conversas aparece a busca. */
const SEARCH_FROM = 6;

const secondsNow = () => Math.floor(Date.now() / 1000);

/**
 * As conversas de um projeto: as abertas e as arquivadas juntas, mais recentes primeiro. Clicar numa aberta vai
 * até ela; numa arquivada reabre e retoma de onde parou (mesma sessão, conta, skills e posição no canvas).
 * "+ Nova conversa" abre o assistente de agente na pasta do projeto. O arquivamento é automático (ao fechar
 * a aba e por checkpoints periódicos); aqui só se fixa, renomeia, oculta ou continua a partir de uma.
 */
export function ConversationList({ cwd, groupCwds, workspaceId, onOpenTab, onTabMenu }: {
  cwd: string;
  groupCwds: string[];
  workspaceId: string;
  onOpenTab: (tabId: string) => void;
  /** Menu de uma aba aberta (skills, fechar): é o mesmo de antes. */
  onTabMenu: (e: React.MouseEvent, tabId: string) => void;
}) {
  const { t } = useTranslation();
  const tabs = useTabsStore((s) => s.tabs);
  const updateTab = useTabsStore((s) => s.updateTab);
  const history = useSessionsStore((s) => s.history);
  const loadHistory = useSessionsStore((s) => s.loadHistory);
  const deleteSession = useSessionsStore((s) => s.deleteSession);
  const { pendingResume, setPendingResume, pendingSkillChoice, setPendingSkillChoice, openSession, resume } = useResumeSession();

  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [menu, setMenu] = useState<{ x: number; y: number; conv: Conversation } | null>(null);
  const [renaming, setRenaming] = useState<{ key: string; value: string } | null>(null);
  /** A conversa que espera a confirmação de apagar (se desarma sozinha). */
  const [armed, setArmed] = useState<string | null>(null);

  // O histórico se recarrega ao abrir e quando o número de abas muda (fechar uma arquiva a sessão).
  useEffect(() => { void loadHistory(workspaceId); }, [workspaceId, tabs.length, loadHistory]);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(null), 3000);
    return () => window.clearTimeout(timer);
  }, [armed]);

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
    })), [tabs]);

  const all = useMemo(
    () => buildConversations({ groupCwds, tabs: openTabs, history, resumable: isResumable, now: secondsNow() }),
    [groupCwds, openTabs, history],
  );
  const shown = useMemo(() => filterConversations(all, query), [all, query]);
  const visible = useMemo(() => shown.slice(0, query ? shown.length : limit), [shown, limit, query]);
  const buckets = useMemo(() => groupByDay(visible, secondsNow()), [visible]);

  const entryOf = (conv: Conversation) => history.find((h) => h.id === conv.historyId) ?? null;

  const open = async (conv: Conversation) => {
    if (conv.tabId) return onOpenTab(conv.tabId);
    const entry = entryOf(conv);
    if (!entry) return;
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

  const bucketLabel = (bucket: string) => t(`conversations.bucket.${bucket}`);

  return (
    <div className="flex flex-col gap-0.5" aria-label={t("conversations.title")}>
      <div className="flex items-center gap-1.5 pl-[18px] pr-0.5">
        <span className="flex-1 text-[9.5px] font-bold uppercase tracking-[0.09em] text-gray-400 dark:text-white/30">
          {t("conversations.title")} {all.length > 0 && <span className="tabular-nums font-normal">{all.length}</span>}
        </span>
        <Button variant="icon" aria-label={t("conversations.new")} title={t("conversations.newHint")}
          onClick={() => openNewAgentWith({ cwd, title: t("conversations.newTitle") })}
          className="cc-t flex items-center gap-1 h-5 px-1.5 rounded-md text-[10.5px] text-gray-500 dark:text-white/45 hover:text-gray-800 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10">
          <AddIcon className="w-3 h-3" />{t("conversations.new")}
        </Button>
      </div>

      {all.length >= SEARCH_FROM && (
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("conversations.search")} aria-label={t("conversations.search")}
          className="mx-1 mb-0.5 h-6 px-2 rounded-md text-[11px] outline-none bg-white dark:bg-white/6 border border-gray-200 dark:border-white/10 focus:border-accent-400 text-gray-800 dark:text-gray-100" />
      )}

      {all.length === 0 && <p className="px-[18px] py-1 text-[10.5px] text-gray-400 dark:text-white/30">{t("conversations.empty")}</p>}
      {shown.length === 0 && all.length > 0 && <p className="px-[18px] py-1 text-[10.5px] text-gray-400 dark:text-white/30">{t("conversations.noMatch")}</p>}

      {buckets.map((group) => (
        <div key={group.bucket} className="flex flex-col gap-px">
          {group.bucket !== "open" && <p className="pl-[18px] pt-1 text-[9px] uppercase tracking-wider text-gray-400/80 dark:text-white/25">{bucketLabel(group.bucket)}</p>}
          {group.items.map((conv) => {
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
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (conv.tabId) onTabMenu(e, conv.tabId);
                      else setMenu({ x: e.clientX, y: e.clientY, conv });
                    }}
                    title={[conv.title, conv.preview, conv.cwd].filter(Boolean).join("\n\n")}
                    className={`flex items-center gap-2 h-[25px] pl-1.5 pr-1 rounded-md w-full text-left transition-colors duration-150
                      ${active ? "bg-accent-500/12 dark:bg-accent-400/13" : "hover:bg-gray-200/60 dark:hover:bg-white/5"}`}>
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
      ))}

      {!query && shown.length > visible.length && (
        <Button variant="custom" onClick={() => setLimit((n) => n + PAGE)}
          className="cc-t ml-[18px] h-5 w-fit px-1.5 rounded text-[10.5px] text-accent-600 dark:text-accent-300 hover:bg-accent-500/10">
          {t("conversations.showMore", { count: shown.length - visible.length })}
        </Button>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
          { key: "open", label: menu.conv.resumable ? t("conversations.resume") : t("conversations.reopen"), onSelect: () => void open(menu.conv) },
          { key: "continue", label: t("conversations.continueFrom"), onSelect: () => void continueFrom(menu.conv) },
          { key: "pin", label: menu.conv.pinned ? t("conversations.unpin") : t("conversations.pin"), separator: true, onSelect: () => void patch(menu.conv, { pinned: !menu.conv.pinned }) },
          { key: "rename", label: t("conversations.rename"), onSelect: () => setRenaming({ key: menu.conv.key, value: menu.conv.title }) },
          { key: "hide", label: t("conversations.hide"), onSelect: () => void patch(menu.conv, { hidden: true }) },
          { key: "forget", label: t("conversations.forget"), danger: true, separator: true, onSelect: () => setArmed(menu.conv.key) },
        ]} />
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
