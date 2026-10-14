/**
 * Conversas de projeto no QG do bot: título, resumo da equipe e ordem. Puro (sem React, sem store).
 */
import { parseConversationSnapshot, type ConversationRow } from "@/features/sessions/conversationModel";

/** Um terminal da equipe, como aparece no resumo. */
export interface TeamMember {
  label: string;
  orchestrator: boolean;
}

/** Textos do resumo (vêm do i18n na tela; os padrões são em português). */
export interface SummaryWords {
  terminals: (n: number) => string;
  orchestrator: string;
  none: string;
}

const DEFAULT_WORDS: SummaryWords = {
  terminals: (n) => (n === 1 ? "1 terminal" : `${n} terminais`),
  orchestrator: "orquestrador",
  none: "sem terminais",
};

/** Título exibido: o personalizado, senão o título, senão `fallback` (traduzido na tela). */
export function conversationHeadline(row: ConversationRow, fallback = "Conversa sem título"): string {
  const custom = typeof row.customTitle === "string" ? row.customTitle.trim() : "";
  if (custom) return custom;
  const title = typeof row.title === "string" ? row.title.trim() : "";
  return title || fallback;
}

/**
 * Os terminais da equipe: os vivos (quando a conversa está ativa) ou os do snapshot guardado.
 * `liveTabs` vazio ou ausente cai no snapshot.
 */
export function teamOf(row: ConversationRow, liveTabs?: TeamMember[]): TeamMember[] {
  if (liveTabs && liveTabs.length > 0) return liveTabs;
  return parseConversationSnapshot(row.terminals).terminals.map((t) => ({ label: t.agentLabel, orchestrator: t.orchestrator }));
}

/** Linha de resumo: "3 terminais: Claude Code (orquestrador), Codex, Antigravity". Pura. */
export function conversationSummary(row: ConversationRow, liveTabs?: TeamMember[], words: SummaryWords = DEFAULT_WORDS): string {
  const team = teamOf(row, liveTabs);
  if (team.length === 0) return words.none;
  const names = team.map((m) => (m.orchestrator ? `${m.label} (${words.orchestrator})` : m.label));
  return `${words.terminals(team.length)}: ${names.join(", ")}`;
}

/** Monta a equipe viva a partir das abas da conversa e das ids marcadas como coroa. Pura. */
export function liveTeamOf(tabs: { id: string; agentLabel: string }[], orchestrators: string[]): TeamMember[] {
  const crowns = new Set(orchestrators);
  return tabs.map((tab) => ({ label: tab.agentLabel, orchestrator: crowns.has(tab.id) }));
}

/** Conversas visíveis, ativas primeiro e depois pela última atividade (mais recente antes). Não muda `rows`. */
export function recentConversations(rows: ConversationRow[], limit = 12): ConversationRow[] {
  return rows
    .filter((r) => !r.hidden)
    .sort((a, b) => {
      if (a.state !== b.state) return a.state === "active" ? -1 : 1;
      return b.lastActiveAt - a.lastActiveAt;
    })
    .slice(0, Math.max(0, limit));
}

/** Tempo desde a última atividade, em partes para a tela traduzir. `ts` em segundos (como no backend). */
export type AgoParts = { unit: "now" } | { unit: "minutes" | "hours" | "days"; n: number };

export function agoParts(ts: number, nowSeconds: number): AgoParts {
  const diff = Math.max(0, nowSeconds - ts);
  if (diff < 60) return { unit: "now" };
  if (diff < 3600) return { unit: "minutes", n: Math.floor(diff / 60) };
  if (diff < 86_400) return { unit: "hours", n: Math.floor(diff / 3600) };
  return { unit: "days", n: Math.floor(diff / 86_400) };
}
