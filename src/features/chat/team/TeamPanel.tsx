import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { openConversation } from "../chatActions";
import type { ConversationCard } from "../chatModel";
import { threadIdOf } from "../structured/model";
import { openThread } from "../structured/store";
import { DraftTeamPanel } from "./DraftTeamPanel";
import { LinkAgentForm, conversationRefOf } from "./LinkAgentForm";
import { AgentMono, PanelHeader, StateDot, useRoleLabel } from "./TeamParts";
import { CONVERSATION_DRAG_MIME, defaultPolicy, placeOf, rosterRows, takenRefs, type RosterRow } from "./teamModel";
import { dissolveTeam, linkExisting, loadFeed, makeOrchestrator, setAdding, startTeams, unlinkMember, useTeamStore } from "./teamStore";
import { useTeamLive } from "./useTeamLive";

/** Abre a conversa de um integrante (a aba ou a conversa por protocolo). */
export function openMember(ref: string): void {
  const thread = threadIdOf(ref);
  if (thread) openThread(thread);
  else openConversation(ref);
}

/**
 * O painel "Time" (prancheta 15), a aba do painel direito: o cabeçalho com "4 agentes · 1 orquestrador"
 * e "+ Ligar agente", o formulário de ligar, a lista com modelo, papel, estado, política e branch de
 * cada um, e o rodapé. Arrastar uma conversa da sidebar para cá a liga ao time.
 *
 * `conversation` é a conversa aberta; `cards`, os cartões da sidebar (nomes, branch, agentes abertos).
 */
export function TeamPanel({ conversation, cards }: { conversation: ConversationCard | null; cards: ConversationCard[] }) {
  const { t } = useTranslation();
  const teams = useTeamStore((s) => s.teams);
  const feeds = useTeamStore((s) => s.feeds);
  const adding = useTeamStore((s) => s.adding);
  const live = useTeamLive(cards);
  const [dropping, setDropping] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  useEffect(() => startTeams(), []);

  const place = placeOf(teams, conversation?.tabId);
  const team = place?.team ?? null;
  useEffect(() => { if (team) void loadFeed(team.id); }, [team?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const feed = team ? feeds[team.id] ?? [] : [];
  const rows = useMemo(
    () => (team ? rosterRows(team, feed, { ...live, orchestratorPolicy: live.accessOf(team.orchestrator) }) : []),
    [team, feed, live],
  );

  // Sem conversa aberta é a tela "Nova conversa": o time se monta em rascunho e nasce com a primeira mensagem.
  if (!conversation) return <DraftTeamPanel cards={cards} />;

  if (!team) {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <PanelHeader summary={null} />
        <div className="m-3.5 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-surface-raised px-3 py-3 flex flex-col gap-2 text-chat-note">
          <b className="font-semibold text-gray-900 dark:text-white">{t("chat.team.empty.title")}</b>
          <p className="m-0 text-gray-600 dark:text-white/60 leading-relaxed">{t("chat.team.empty.body")}</p>
          {error && <p role="alert" className="m-0 text-chat-caption text-red-700 dark:text-red-400">{error}</p>}
          <button type="button" onClick={() => { setError(""); makeOrchestrator(conversationRefOf(conversation)).catch((e) => setError(String(e))); }}
            className="self-end h-[30px] px-3 rounded-lg bg-accent-600 text-white font-medium hover:bg-accent-700">
            {t("chat.team.empty.make")}
          </button>
        </div>
        <Footer />
      </div>
    );
  }

  const taken = takenRefs(teams);
  const onDrop = (e: React.DragEvent) => {
    setDropping(false);
    const key = e.dataTransfer.getData(CONVERSATION_DRAG_MIME);
    const card = cards.find((c) => c.tabId === key);
    if (!card || taken.has(key)) return;
    e.preventDefault();
    setError("");
    linkExisting(team.id, conversationRefOf(card), "generalist", defaultPolicy("generalist")).catch((err) => setError(String(err)));
  };

  return (
    <div className={`flex-1 min-h-0 flex flex-col ${dropping ? "ring-2 ring-inset ring-accent-500/70" : ""}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes(CONVERSATION_DRAG_MIME)) { e.preventDefault(); setDropping(true); } }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}>
      <PanelHeader summary={t("chat.team.summary", { count: team.headcount })}
        onAdd={() => setAdding(team.id, !adding[team.id])} adding={!!adding[team.id]} />
      {place?.member && (
        <button type="button" onClick={() => openMember(team.orchestrator)}
          className="mx-3.5 mt-2.5 text-left text-chat-caption text-accent-700 dark:text-accent-400 hover:underline">
          {t("chat.team.memberOf", { name: live.nameOf(team.orchestrator) ?? team.label })}
        </button>
      )}
      {adding[team.id] && <LinkAgentForm key={team.id} team={team} cards={cards} />}
      {dropping && <p className="mx-3.5 mt-2.5 mb-0 text-chat-caption text-accent-700 dark:text-accent-400">{t("chat.team.drop")}</p>}
      {error && <p role="alert" className="mx-3.5 mt-2.5 mb-0 text-chat-caption text-red-700 dark:text-red-400">{error}</p>}
      <ul aria-label={t("chat.team.title")} className="list-none m-0 p-2.5 flex flex-col gap-2 cc-scroll-hidden min-h-0 flex-1">
        {rows.map((row) => <MemberCard key={row.ref} row={row} teamId={team.id} />)}
      </ul>
      <div className="px-3.5 pb-1 flex items-center justify-end gap-2">
        {confirming && <span className="text-chat-caption text-gray-500 dark:text-white/45">{t("chat.team.dissolveConfirm")}</span>}
        <button type="button" onClick={() => { if (confirming) void dissolveTeam(team.id); setConfirming(!confirming); }}
          onBlur={() => setConfirming(false)}
          className={`h-7 px-2 rounded-md text-chat-caption hover:bg-gray-100 dark:hover:bg-white/10 ${confirming ? "text-red-700 dark:text-red-400 font-medium" : "text-gray-500 dark:text-white/45"}`}>
          {confirming ? t("chat.team.dissolveYes") : t("chat.team.dissolve")}
        </button>
      </div>
      <Footer />
    </div>
  );
}

function Footer() {
  return (
    <div className="mt-auto px-3.5 py-2.5 border-t border-gray-200 dark:border-white/[0.08] text-chat-caption leading-normal text-gray-500 dark:text-white/45">
      <Trans i18nKey="chat.team.footer" components={{ code: <span className="font-mono" /> }} />
    </div>
  );
}

function MemberCard({ row, teamId }: { row: RosterRow; teamId: string }) {
  const { t } = useTranslation();
  const roleLabel = useRoleLabel();
  const lead = row.role === "orchestrator";
  return (
    <li className="group rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-surface-raised px-3 py-2.5 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <AgentMono agentId={row.agentId} label={row.name} />
        <button type="button" onClick={() => openMember(row.ref)} className="flex-1 min-w-0 text-left">
          <div className="text-chat-note font-semibold text-gray-900 dark:text-white truncate">{row.name}</div>
          <div className="text-chat-caption text-gray-500 dark:text-white/45 truncate">{row.model ?? t("chat.team.modelDefault")}</div>
        </button>
        <span className="text-[11px] font-semibold px-1.5 py-px rounded-[5px] bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-white/60">
          {roleLabel(row.role)}
        </span>
        {row.subagent && (
          <span className="text-[11px] font-semibold px-1.5 py-px rounded-[5px] bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-white/60">
            {t("role.subagentTag")}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-chat-caption text-gray-500 dark:text-white/45">
        <StateDot state={row.state} />
        {row.policy && <span className="whitespace-nowrap">· {t(`chat.team.policy.${row.policy}`)}</span>}
        <span className="flex-1" />
        {!lead && (
          <button type="button" onClick={() => { void unlinkMember(teamId, row.ref); }}
            className="hidden group-hover:inline whitespace-nowrap text-[11px] text-gray-500 dark:text-white/45 hover:text-red-700 dark:hover:text-red-400">
            {t("chat.team.unlink")}
          </button>
        )}
        <span className="font-mono truncate min-w-0 max-w-full">{row.branch ?? (row.isThread ? t("chat.team.thread") : t("chat.team.tab"))}</span>
      </div>
    </li>
  );
}
