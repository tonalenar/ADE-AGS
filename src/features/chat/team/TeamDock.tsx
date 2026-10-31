import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { useChatShell } from "@/app/uiStore";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID } from "@/features/tabs/types";

import type { ConversationCard } from "../chatModel";
import { UsersIcon } from "../chatIcons";
import { PermissionsInbox } from "../permissions/PermissionsInbox";
import { PermissionsManager } from "../permissions/PermissionsManager";
import { setInboxOpen, usePendingAsks, usePermissions } from "../permissions/permissionsStore";
import { placeOf } from "./teamModel";
import { TeamPanel } from "./TeamPanel";
import { startTeams, useTeamStore } from "./teamStore";

const BUTTON = `cc-t flex items-center gap-1.5 h-7 px-2.5 my-auto shrink-0 rounded-lg text-[11.5px] font-medium
  text-gray-600 dark:text-gray-300 bg-black/5 dark:bg-white/[0.07] hover:text-gray-900 dark:hover:text-white hover:bg-black/10 dark:hover:bg-white/[0.12]`;

/**
 * O painel Time e a caixa de Permissões nas Abas e na Grade: os mesmos componentes do modo chat
 * (`TeamPanel`, `PermissionsInbox`), numa gaveta ao lado da barra. Só aparece quando a aba ativa está
 * num time. O `PermissionsManager` (que lê os pedidos dos terminais e aplica a política do time) roda
 * aqui, como roda no chat, e só com um time à vista.
 */
export function TeamDock() {
  const { t } = useTranslation();
  const chatShell = useChatShell();
  useEffect(() => startTeams(), []);
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const teams = useTeamStore((s) => s.teams);
  const inboxOpen = usePermissions((s) => s.inboxOpen);
  const asks = usePendingAsks();
  const [open, setOpen] = useState(false);

  const place = useMemo(() => placeOf(teams, activeTabId), [teams, activeTabId]);
  // Os cartões que o painel usa (nomes, pasta, agente): os das abas de agente abertas.
  const cards = useMemo<ConversationCard[]>(() => tabs.filter((tab) => tab.agentId !== SHELL_AGENT_ID).map((tab) => ({
    tabId: tab.id, title: tab.title, project: "", cwd: tab.cwd, branch: "", isWorktree: false, agentId: tab.agentId, agentLabel: tab.agentLabel,
    starting: tab.ptyId === null, active: tab.id === activeTabId, openedAt: tab.openedAt,
  })), [tabs, activeTabId]);
  const card = cards.find((c) => c.tabId === activeTabId) ?? null;
  // Quantos pedidos esperam alguém deste time.
  const pending = useMemo(() => {
    if (!place) return 0;
    const refs = new Set([place.team.orchestrator, ...place.team.members.map((m) => m.member)]);
    return asks.filter((ask) => (ask.ref.source === "tui" ? refs.has(ask.ref.tabId) : ask.ref.source === "thread" && refs.has(`thread:${ask.ref.threadId}`))).length;
  }, [asks, place]);

  // O atalho da caixa (⇧⌘A) abre a gaveta; Esc fecha.
  useEffect(() => {
    if (!open && !inboxOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); setInboxOpen(false); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, inboxOpen]);

  if (chatShell || !place) return null;
  const shown = open || inboxOpen;
  return (
    <>
      <PermissionsManager />
      <button type="button" data-tauri-drag-region="false" aria-pressed={shown && !inboxOpen}
        onClick={() => { setInboxOpen(false); setOpen(!open || inboxOpen); }} className={BUTTON} title={t("chat.team.dock.team")}>
        <UsersIcon className="w-3.5 h-3.5" />
        {t("chat.team.title")}
      </button>
      <button type="button" data-tauri-drag-region="false" aria-pressed={inboxOpen}
        onClick={() => { setOpen(false); setInboxOpen(!inboxOpen); }} className={BUTTON} title={t("chat.team.dock.permissions")}>
        {t("chat.inbox.title")}
        {pending > 0 && <span className="min-w-4 h-4 px-1 rounded-full bg-amber-500 text-white text-[10px] leading-4 text-center">{pending}</span>}
      </button>
      {shown && createPortal(
        <div role="dialog" aria-label={inboxOpen ? t("chat.inbox.title") : t("chat.team.title")}
          className="fixed top-11 right-3 bottom-3 z-50 w-[420px] max-w-[calc(100vw-24px)] flex flex-col overflow-hidden rounded-xl
            bg-white dark:bg-surface-deep shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_20px_50px_-20px_rgba(0,0,0,0.55)]">
          {inboxOpen ? <PermissionsInbox /> : <TeamPanel conversation={card} cards={cards} />}
        </div>,
        document.body,
      )}
    </>
  );
}
