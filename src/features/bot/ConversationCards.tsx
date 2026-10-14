import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useCanvasStore, conversationBoardKey } from "@/features/canvas/store";
import { tabsOfConversation } from "@/features/sessions/conversationFlow";
import type { ConversationRow } from "@/features/sessions/conversationModel";
import { sustainedTabIds } from "@/features/terminal/activity";
import { useTabsStore } from "@/features/tabs/store";
import { SHELL_AGENT_ID } from "@/features/tabs/types";

import { agoParts, conversationHeadline, conversationSummary, liveTeamOf, type SummaryWords, type TeamMember } from "./conversationStats";

/** Lo que pasa agora en una conversa activa: su equipe viva y cuántos terminales trabajan. */
export interface ConversationLive {
  team: TeamMember[];
  working: number;
}

/** El estado vivo de las conversas activas. Se recalcula con `now` (el panel corre su reloj). */
export function useConversationLive(rows: ConversationRow[], now: number): Map<string, ConversationLive> {
  const tabs = useTabsStore((s) => s.tabs);
  const boards = useCanvasStore((s) => s.boards);
  return useMemo(() => {
    const sustained = new Set(sustainedTabIds());
    const out = new Map<string, ConversationLive>();
    for (const row of rows) {
      if (row.state !== "active") continue;
      const own = tabsOfConversation(row).filter((tab) => tab.agentId !== SHELL_AGENT_ID);
      const crowns = boards[conversationBoardKey(row.cwd, row.id)]?.orchestrators ?? [];
      out.set(row.id, {
        team: liveTeamOf(own, crowns),
        working: own.filter((tab) => sustained.has(tab.id)).length,
      });
    }
    return out;
  }, [rows, tabs, boards, now]);
}

/** Lista simple de conversas: título, resumo, selo ativa/salva y tiempo (o cuántos trabajan, en AO VIVO). */
export function ConversationList({ rows, live, now, showWorking = false }: {
  rows: ConversationRow[];
  live: Map<string, ConversationLive>;
  now: number;
  showWorking?: boolean;
}) {
  const { t } = useTranslation();
  const words: SummaryWords = {
    terminals: (n) => (n === 1 ? t("botPanel.conversations.terminalsOne") : t("botPanel.conversations.terminalsMany", { n })),
    orchestrator: t("botPanel.conversations.orchestrator"),
    none: t("botPanel.conversations.noTerminals"),
  };
  const untitled = t("botPanel.conversations.untitled");

  return (
    <div className="ags-hq__list">
      {rows.map((row) => {
        const active = row.state === "active";
        const lv = active ? live.get(row.id) : undefined;
        const summary = conversationSummary(row, lv && lv.team.length > 0 ? lv.team : undefined, words);
        const ago = agoParts(row.lastActiveAt, now);
        const agoText = ago.unit === "now"
          ? t("botPanel.conversations.agoNow")
          : t(`botPanel.conversations.ago.${ago.unit}`, { n: ago.n });
        return (
          <div key={row.id} className="ags-hq__item ags-hq__conv">
            <span style={{ color: active ? "var(--hq-green)" : "var(--hq-dim)" }}>{active ? "▶" : "○"}</span>
            <span className="ags-hq__conv-main">
              <span className="ags-hq__item-title">{conversationHeadline(row, untitled)}</span>
              <span className="ags-hq__conv-sum">{summary}</span>
            </span>
            <span className={`ags-hq__pill ${active ? "" : "ags-hq__pill--saved"}`}>
              {active ? t("botPanel.conversations.active") : t("botPanel.conversations.saved")}
            </span>
            <span className="ags-hq__dim">
              {showWorking ? t("botPanel.conversations.working", { n: lv?.working ?? 0 }) : agoText}
            </span>
          </div>
        );
      })}
    </div>
  );
}
