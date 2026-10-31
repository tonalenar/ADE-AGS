import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "neogestify-ui-components";

import { hasBrowserMcp } from "@/features/browser/tabMcp";
import { ScmPanel } from "@/features/scm/ScmPanel";
import { ConnectorsSection, ContextSection } from "@/features/sidePanel/AgentSections";
import { folderLabel, shortTokens } from "@/features/sidePanel/panelModel";
import { Row, Section } from "@/features/sidePanel/Section";
import { PR_STATE, usePulls } from "@/features/sidePanel/SessionPanel";
import { useTabsStore } from "@/features/tabs/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { useRepoInfo } from "@/features/workspaces/useRepoInfo";
import { homeDir } from "@/shared/ipc/window";
import { AppDialog } from "@/shared/ui/AppDialog";

import type { ConversationCard } from "../chatModel";
import { BranchIcon, ComputerIcon, DiffIcon, FilePlusIcon, MoreHorizontalIcon, PenIcon, PullRequestIcon } from "../chatIcons";
import { addSurface } from "../store";
import { threadIdOf } from "../structured/model";
import { useStructured } from "../structured/store";
import { chatTeamHandoff } from "../team/ipc";
import { deliveries, teamLedBy } from "../team/teamModel";
import { startTeams, useTeamStore } from "../team/teamStore";
import { useConversationTimeline } from "../timeline/useConversationTimeline";
import type { TimelineItem } from "../timeline/types";
import { useWorkingDiff } from "../useWorkingDiff";
import { LimitsCard } from "./LimitsCard";
import { connectorsOf, contextOf, diffTotals, filesFromHandoffs, memoryConnectorOf, outputsFromItems, pickOutputs, type OutputFile } from "./summaryModel";

const EMPTY_ITEMS: TimelineItem[] = [];

/** Os itens da conversa: da timeline da aba (TUI) ou dos eventos da conversa por protocolo. */
function useConversationItems(conversation: ConversationCard | null): TimelineItem[] {
  const tabId = conversation?.tabId ?? "";
  const thread = threadIdOf(tabId);
  const tui = useConversationTimeline(thread ? "" : tabId);
  const structured = useStructured((s) => (thread ? s.live[thread]?.items : undefined));
  return (thread ? structured : tui.timeline?.items) ?? EMPTY_ITEMS;
}

/**
 * O Resumo do painel direito, no formato do painel do Claude Code: cartões arredondados empilhados, cada
 * um com título e seta que abre e recolhe (o estado é lembrado, o mesmo das Abas): Ambiente, Contexto,
 * Limites de uso, Conectores, Saídas e Alterações. Os dados são os que o ADE já tem (git, forge, transcript, config dos
 * MCPs); o que não tem fonte fica de fora ou como "não medido", nunca inventado.
 */
export function SummaryPane({ conversation, cwd, tabId }: { conversation: ConversationCard | null; cwd: string | null; tabId: string | null }) {
  const { t } = useTranslation();
  // A aba da conversa (TUI): tem sessão e config, e os cartões de Contexto e Conectores leem o disco. A
  // conversa por protocolo não tem aba: esses dois cartões usam o que o app recebe dos eventos.
  const tab = useTabsStore((s) => s.tabs.find((x) => x.id === conversation?.tabId) ?? null);
  if (!conversation || !cwd) return <p className="p-4 text-chat-note text-gray-400 dark:text-white/40">{t("chat.summary.none")}</p>;
  return (
    <div className="flex-1 min-h-0 cc-scroll p-3 flex flex-col gap-3">
      <EnvironmentCard conversation={conversation} cwd={cwd} />
      {tab ? <ContextSection tab={tab} flat /> : <ThreadContextCard conversation={conversation} />}
      <LimitsCard conversation={conversation} />
      {tab ? <ConnectorsSection tab={tab} flat /> : <ThreadConnectorsCard conversation={conversation} />}
      <OutputsCard conversation={conversation} cwd={cwd} />
      <ChangesCard conversation={conversation} cwd={cwd} tabId={tabId} />
    </div>
  );
}

function EnvironmentCard({ conversation, cwd }: { conversation: ConversationCard; cwd: string }) {
  const { t } = useTranslation();
  const [home, setHome] = useState<string | null>(null);
  useEffect(() => { homeDir().then(setHome).catch(() => setHome(null)); }, []);
  const cwds = useMemo(() => [cwd], [cwd]);
  const repo = useRepoInfo(cwds).get(cwd) ?? null;
  const folder = folderLabel(cwd, home);
  const branch = repo?.branch ?? conversation.branch?.trim() ?? null;
  const worktree = repo?.isWorktree ?? conversation.isWorktree;
  return (
    <Section id="env" title={t("sidePanel.env.title")} flat>
      <Row icon={<ComputerIcon className="w-4 h-4" />}>{worktree ? t("chat.summary.worktree") : t("chat.summary.computer")}</Row>
      <Row icon={<FolderGlyph />} title={cwd}>
        {folder.name} <span className="text-gray-400 dark:text-white/35">· {folder.parent}</span>
      </Row>
      {branch && <Row icon={<BranchIcon className="w-4 h-4" />}>{branch}</Row>}
      <Row icon={<span className="w-4 text-center text-[10px] font-semibold">AI</span>}>
        {conversation.agentLabel}
      </Row>
    </Section>
  );
}

function FolderGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden="true">
      <path d="M20 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2Z" />
    </svg>
  );
}

/** Conversa por protocolo: sem aba, o contexto é o que o agente informa (tokens); nunca uma porcentagem inventada. */
function ThreadContextCard({ conversation }: { conversation: ConversationCard }) {
  const { t, i18n } = useTranslation();
  const items = useConversationItems(conversation);
  const tokens = useMemo(() => items.reduce((n, i) => (i.kind === "usage" && typeof i.tokens === "number" ? n + i.tokens : n), 0), [items]);
  const ctx = contextOf(tokens > 0 ? tokens : null);
  return (
    <Section id="context" title={t("sidePanel.context.title")} defaultOpen={false} flat
      aside={<span className="text-[11px] text-gray-500 dark:text-white/45 tabular-nums">{ctx.measured ? t("chat.summary.contextTokens", { tokens: shortTokens(ctx.tokens ?? 0, i18n.language) }) : t("chat.summary.notMeasured")}</span>}>
      <Row><span className="text-gray-500 dark:text-white/45">{t("chat.summary.contextHint")}</span></Row>
    </Section>
  );
}

function ThreadConnectorsCard({ conversation }: { conversation: ConversationCard }) {
  const { t } = useTranslation();
  const list = connectorsOf(hasBrowserMcp(conversation.agentId));
  // O que o backend gravou ao abrir o processo da conversa; a tela não adivinha.
  const thread = threadIdOf(conversation.tabId);
  const memory = memoryConnectorOf(useStructured((s) => (thread ? s.threads.find((x) => x.id === thread)?.memory : null)));
  const on = list.filter((c) => c.on).length + (memory.on ? 1 : 0);
  const memoryText = memory.on ? t("chat.summary.memory.on")
    : memory.pending ? t("chat.summary.memory.pending")
    : t("chat.summary.memory.off", { reason: t(`chat.summary.memory.reason.${memory.reason}`, { defaultValue: memory.reason }) });
  return (
    <Section id="connectors" title={t("sidePanel.connectors.title")} defaultOpen={false} flat
      aside={<span className="text-[11px] text-gray-500 dark:text-white/45 tabular-nums">{on > 0 ? t("chat.summary.connectorsOn", { count: on }) : t("chat.summary.connectorsNone")}</span>}>
      {list.map((c) => (
        <Row key={c.id} icon={<span aria-hidden="true" className={`block w-1.5 h-1.5 rounded-full ${c.on ? "bg-emerald-500" : "bg-gray-300 dark:bg-white/25"}`} />}
          trailing={<span className="shrink-0 text-[10.5px] text-gray-400 dark:text-white/35">{c.on ? t("chat.summary.connectorOn") : t("chat.summary.connectorOff")}</span>}>
          {t(`chat.summary.connector.${c.id}`)}
        </Row>
      ))}
      <Row icon={<span aria-hidden="true" className={`block w-1.5 h-1.5 rounded-full ${memory.on ? "bg-emerald-500" : "bg-gray-300 dark:bg-white/25"}`} />}>
        <span data-testid="ai-memory-connector">{memoryText}</span>
      </Row>
      <Row><span className="text-gray-500 dark:text-white/45">{t("chat.summary.connectorsHint")}</span></Row>
    </Section>
  );
}

/** Os arquivos que o time entregou (Handoff v1), para o orquestrador: só informam, são da pasta de cada integrante. */
function useTeamFiles(conversation: ConversationCard): OutputFile[] {
  useEffect(() => startTeams(), []);
  const team = useTeamStore((s) => teamLedBy(s.teams, conversation.tabId));
  const feed = useTeamStore((s) => (team ? s.feeds[team.id] : undefined));
  const [handoffs, setHandoffs] = useState<{ from: string; files: string[] }[]>([]);
  useEffect(() => {
    if (!team || !feed) { setHandoffs([]); return; }
    let alive = true;
    const latest = deliveries(feed).filter((d) => d.handoff !== null).slice(-6);
    void Promise.all(latest.map((d) => chatTeamHandoff(team.id, d.handoff!)
      .then((h) => ({ from: d.memberName, files: (h.handoff.changed_files ?? []).map((f) => f.path) }))
      .catch(() => null)))
      .then((list) => { if (alive) setHandoffs(list.filter((x): x is { from: string; files: string[] } => x !== null)); });
    return () => { alive = false; };
  }, [team?.id, feed]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => filesFromHandoffs(handoffs), [handoffs]);
}

function OutputsCard({ conversation, cwd }: { conversation: ConversationCard; cwd: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const items = useConversationItems(conversation);
  const own = useMemo(() => outputsFromItems(items), [items]);
  const delivered = useTeamFiles(conversation);
  const outputs = useMemo(() => [...own, ...delivered.filter((d) => !own.some((o) => o.path === d.path))], [own, delivered]);
  const { shown, hidden } = pickOutputs(outputs, expanded);
  // Abre o arquivo no painel de Arquivos (o mesmo editor das Abas).
  const open = (path: string) => { addSurface("files"); useViewTabsStore.getState().openFile(cwd, path); };
  return (
    <Section id="outputs" title={t("chat.summary.outputs")} flat>
      {outputs.length === 0 && <Row><span className="text-gray-500 dark:text-white/45">{t("chat.summary.outputsEmpty")}</span></Row>}
      {shown.map((file) => (
        <Row key={file.path} title={file.path} onClick={file.by ? undefined : () => open(file.path)}
          icon={file.created ? <FilePlusIcon className="w-4 h-4" /> : <PenIcon className="w-4 h-4" />}
          trailing={file.by ? <span className="shrink-0 text-[11.5px] text-gray-400 dark:text-white/35">{file.by}</span> : undefined}>
          {file.name}
        </Row>
      ))}
      {(hidden > 0 || (expanded && outputs.length > 4)) && (
        <button type="button" onClick={() => setExpanded(!expanded)} className="self-start mt-1 px-1.5 text-[12.5px] text-gray-500 dark:text-white/45 hover:text-gray-900 dark:hover:text-white">
          {expanded ? t("chat.summary.showLess") : t("chat.summary.showMore")}
        </button>
      )}
    </Section>
  );
}

function ChangesCard({ conversation, cwd, tabId }: { conversation: ConversationCard; cwd: string; tabId: string | null }) {
  const { t } = useTranslation();
  const { state } = useWorkingDiff(cwd, tabId);
  const total = useMemo(() => diffTotals(state.files), [state.files]);
  const cwds = useMemo(() => [cwd], [cwd]);
  const repo = useRepoInfo(cwds).get(cwd) ?? null;
  const branch = repo?.branch ?? conversation.branch?.trim() ?? null;
  const { pulls, stats } = usePulls(repo?.root ? cwd : null, branch);
  const repoName = folderLabel(repo?.root ?? cwd, null).name;
  const [committing, setCommitting] = useState(false);
  return (
    <Section id="changes" title={t("chat.summary.changes")} flat>
      {state.loaded && !state.repo ? (
        <Row><span className="text-gray-500 dark:text-white/45">{t("chat.panel.noRepo")}</span></Row>
      ) : (
        <div className="flex items-center gap-2.5 min-h-9">
          <span className="shrink-0 text-gray-400 dark:text-white/40"><DiffIcon className="w-4 h-4" /></span>
          <span className="font-mono text-[12.5px]">
            <span className="text-emerald-700 dark:text-emerald-400">+{total.added}</span>{" "}<span className="text-red-700 dark:text-red-400">−{total.removed}</span>
          </span>
          <span className="flex-1" />
          {/* Só abre o fluxo de commit do ADE (a mensagem se edita lá); nunca commita sozinho. */}
          <button type="button" disabled={total.files === 0} onClick={() => setCommitting(true)}
            className="min-w-0 truncate h-8 px-3 rounded-lg bg-gray-100 dark:bg-white/[0.07] text-[12.5px] text-gray-900 dark:text-white disabled:opacity-40 hover:bg-gray-200 dark:hover:bg-white/10">
            {t("chat.summary.commit")}
          </button>
        </div>
      )}
      {pulls && pulls.length > 0 && (
        <ul className="m-0 mt-1 p-0 list-none flex flex-col">
          {pulls.map((pull) => (
            <li key={pull.number} className="flex items-start gap-2.5 py-1.5">
              <span className={`mt-0.5 shrink-0 ${PR_STATE[pull.state] ?? ""}`}><PullRequestIcon className="w-4 h-4" /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-gray-900 dark:text-white" title={pull.title}>{pull.title}</span>
                <span className="block truncate text-[12px] text-gray-500 dark:text-white/45 tabular-nums">
                  {repoName} #{pull.number}
                  {stats[pull.number] && (
                    <>{" "}<span className="text-emerald-600 dark:text-emerald-400">+{stats[pull.number]!.add}</span>{" "}<span className="text-rose-600 dark:text-rose-400">−{stats[pull.number]!.del}</span></>
                  )}
                </span>
              </span>
              <button type="button" onClick={() => { openUrl(pull.webUrl).catch(console.error); }} aria-label={t("chat.summary.pullOpen")} title={t("chat.summary.pullOpen")}
                className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/10">
                <MoreHorizontalIcon className="w-4 h-4" />
              </button>
              <span aria-label={t(`chat.summary.pull.${pull.state === "open" && pull.draft ? "draft" : pull.state}`)} title={t(`chat.summary.pull.${pull.state === "open" && pull.draft ? "draft" : pull.state}`)}
                className={`mt-2 shrink-0 w-1.5 h-1.5 rounded-full ${pull.state === "open" ? (pull.draft ? "bg-gray-400" : "bg-emerald-500") : pull.state === "merged" ? "bg-violet-500" : "bg-red-500"}`} />
            </li>
          ))}
        </ul>
      )}
      {committing && (
        <AppDialog title={t("chat.summary.commit")} size="md" onClose={() => setCommitting(false)} closeOnEsc
          footer={<Button variant="outline" onClick={() => setCommitting(false)}>{t("btn.close")}</Button>}>
          <div className="h-[60vh] min-h-0 flex flex-col"><ScmPanel cwd={cwd} /></div>
        </AppDialog>
      )}
    </Section>
  );
}
