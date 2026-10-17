import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "neogestify-ui-components";
import { AlertaToast } from "@/shared/ui/alerts";

import { useCanvasStore, conversationBoardKey } from "@/features/canvas/store";
import { useTabsStore } from "@/features/tabs/store";
import { ContextMenu } from "@/shared/ui/ContextMenu";
import { elapsed } from "@/features/workspaces/useRepoInfo";

import { parseConversationSnapshot, conversationTitle, type ConversationRow } from "./conversationModel";
import { hibernateConversation, openConversation, tabsOfConversation, type FlowContext } from "./conversationFlow";
import { useConversationsStore } from "./conversationsStore";
import { deleteConversation, updateConversation } from "./ipc.projectConversations";
import { sessionTitle } from "./ipc";

/** O ícone de uma conversa-canvas: quatro quadros, como o canvas. */
function CanvasIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" />
    </svg>
  );
}

/**
 * As conversas-canvas do projeto. Cada uma é um canvas com os seus terminais; só a ATIVA tem terminais abertos.
 * Trocar de conversa salva e fecha os terminais da atual (a sessão de cada agente fica no disco) e reabre os da
 * escolhida, retomando as sessões. Se algum agente ainda está trabalhando, pergunta antes de fechar.
 */
export function CanvasConversations({ projectKey, cwd, workspaceId, onOpened }: {
  projectKey: string;
  cwd: string;
  workspaceId: string;
  /** Depois de abrir uma conversa, leva até o canvas dela. */
  onOpened: (tabId: string | null) => void;
}) {
  const { t } = useTranslation();
  const rows = useConversationsStore((s) => s.rows);
  const load = useConversationsStore((s) => s.load);
  const upsert = useConversationsStore((s) => s.upsert);
  const remove = useConversationsStore((s) => s.remove);
  const tabs = useTabsStore((s) => s.tabs);
  const [busy, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: ConversationRow } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

  useEffect(() => { void load(workspaceId); }, [workspaceId, load]);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(null), 3000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  // O contexto da conversa vira o título: o assunto real da sessão do orquestrador (ou do primeiro agente que já
  // tenha um), não "Claude Code — C:\\pasta". Relido de tempos em tempos enquanto a conversa está ativa.
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const { rows: all } = useConversationsStore.getState();
      for (const row of all.filter((r) => r.projectKey === projectKey && r.state === "active" && !r.customTitle)) {
        const board = useCanvasStore.getState().boards[conversationBoardKey(row.cwd, row.id)];
        const lead = new Set(board?.orchestrators ?? []);
        const members = tabsOfConversation(row)
          .filter((tab) => tab.agentId !== "bash" && !tab.titleIsCustom)
          .sort((a, b) => Number(lead.has(b.id)) - Number(lead.has(a.id)));
        for (const tab of members) {
          const found = await sessionTitle({ agentId: tab.agentId, cwd: tab.cwd, sessionId: tab.sessionId ?? null, fallback: "", accountId: tab.accountId ?? null }).catch(() => null);
          const title = found && found.source !== "fallback" ? found.title.trim() : "";
          if (!alive) return;
          if (title) {
            if (title !== row.title) upsert(await updateConversation(row.id, { title }));
            break;
          }
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 45_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [projectKey, upsert]);

  const mine = useMemo(
    () => rows
      .filter((r) => r.projectKey === projectKey && !r.hidden)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (a.state === b.state ? b.lastActiveAt - a.lastActiveAt : a.state === "active" ? -1 : 1)),
    [rows, projectKey],
  );

  const ctx: FlowContext = {
    workspaceId, cwd, projectKey,
  };

  const guard = async (id: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(id);
    try {
      await work();
    } catch (e) {
      AlertaToast(t("conversations.title"), String(e), "error", 7000);
    } finally {
      setBusy(null);
    }
  };

  const open = (row: ConversationRow) => guard(row.id, async () => {
    const result = await openConversation(row, ctx);
    if (result.ok) onOpened(result.tabId);
  });

  const patch = (row: ConversationRow, change: Parameters<typeof updateConversation>[1]) => guard(row.id, async () => {
    upsert(await updateConversation(row.id, change));
  });

  const titleOf = (row: ConversationRow) => {
    const terminals = parseConversationSnapshot(row.terminals).terminals;
    if (row.state === "active" && !row.customTitle && !row.title?.trim()) {
      const live = tabsOfConversation(row)[0]?.title;
      if (live) return live;
    }
    return conversationTitle(row, terminals);
  };

  const countOf = (row: ConversationRow) => (row.state === "active" ? tabsOfConversation(row).length : parseConversationSnapshot(row.terminals).terminals.length);

  if (mine.length === 0) return null;
  void tabs; // as abas mudam a contagem das ativas

  return (
    <div className="flex flex-col gap-px">
      {mine.map((row) => (
        <div key={row.id}>
          {renaming?.id === row.id ? (
            <input autoFocus value={renaming.value} maxLength={120} aria-label={t("conversations.rename")}
              onChange={(e) => setRenaming({ id: row.id, value: e.target.value })}
              onBlur={() => { const value = renaming.value.trim(); setRenaming(null); void patch(row, { customTitle: value || null }); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setRenaming(null);
              }}
              className="mx-1 h-[25px] w-[calc(100%-0.5rem)] px-2 rounded-md text-[11px] outline-none bg-white dark:bg-white/8 border border-accent-400 text-gray-800 dark:text-gray-100" />
          ) : (
            <Button variant="custom" disabled={busy !== null} onClick={() => void open(row)}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, row }); }}
              title={t("conversations.canvas.hint", { count: countOf(row) })}
              className={`flex items-center gap-2 h-[25px] pl-1.5 pr-1 rounded-md w-full text-left transition-colors duration-150
                ${row.state === "active" ? "bg-accent-500/12 dark:bg-accent-400/13" : "hover:bg-gray-200/60 dark:hover:bg-white/5"}`}>
              <CanvasIcon className={`w-3.5 h-3.5 shrink-0 ${row.state === "active" ? "text-emerald-500" : "text-gray-400 dark:text-white/30"}`} />
              <span className={`flex-1 min-w-0 truncate text-[11px] ${row.state === "active" ? "text-gray-900 dark:text-accent-100" : "text-gray-600 dark:text-gray-400"}`}>
                {row.pinned && <span aria-hidden className="mr-1 text-accent-500">●</span>}{titleOf(row)}
              </span>
              {busy === row.id
                ? <span className="shrink-0 text-[10px] text-gray-400">…</span>
                : armed === row.id
                  ? <span className="shrink-0 text-[10px] font-medium text-red-500">{t("conversations.confirmForget")}</span>
                  : <span className="shrink-0 flex items-center gap-1 text-[10px] tabular-nums text-gray-400 dark:text-white/35">
                      <span>{countOf(row)}</span>
                      <span>{elapsed(row.lastActiveAt * 1000)}</span>
                    </span>}
            </Button>
          )}
        </div>
      ))}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
          { key: "open", label: menu.row.state === "active" ? t("conversations.canvas.show") : t("conversations.canvas.open"), onSelect: () => void open(menu.row) },
          ...(menu.row.state === "active"
            ? [{ key: "save", label: t("conversations.canvas.saveClose"), onSelect: () => void guard(menu.row.id, async () => { await hibernateConversation(menu.row, ctx, "save"); }) }]
            : []),
          { key: "pin", label: menu.row.pinned ? t("conversations.unpin") : t("conversations.pin"), separator: true, onSelect: () => void patch(menu.row, { pinned: !menu.row.pinned }) },
          { key: "rename", label: t("conversations.rename"), onSelect: () => setRenaming({ id: menu.row.id, value: titleOf(menu.row) }) },
          { key: "hide", label: t("conversations.hide"), onSelect: () => void patch(menu.row, { hidden: true }) },
          { key: "delete", label: t("conversations.canvas.delete"), danger: true, separator: true,
            onSelect: () => {
              if (armed !== menu.row.id) { setArmed(menu.row.id); return; }
              setArmed(null);
              void guard(menu.row.id, async () => {
                if (menu.row.state === "active" && !(await hibernateConversation(menu.row, ctx, "delete"))) return;
                await deleteConversation(menu.row.id);
                remove(menu.row.id);
              });
            } },
        ]} />
      )}
      {armed && (
        <p className="pl-[18px] pr-1 text-[10px] text-red-500">
          <button type="button" className="underline" onClick={() => {
            const row = rows.find((r) => r.id === armed);
            if (!row) return;
            setArmed(null);
            void guard(row.id, async () => {
              if (row.state === "active" && !(await hibernateConversation(row, ctx, "delete"))) return;
              await deleteConversation(row.id);
              remove(row.id);
            });
          }}>{t("conversations.canvas.deleteNow")}</button>
        </p>
      )}
    </div>
  );
}
