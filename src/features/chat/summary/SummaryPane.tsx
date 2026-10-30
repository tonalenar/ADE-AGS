import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";

import { forgePulls } from "@/features/forge/ipc";
import { useRepoTarget } from "@/features/forge/useRepoTarget";
import { hasBrowserMcp } from "@/features/browser/tabMcp";
import { ScmPanel } from "@/features/scm/ScmPanel";
import { homeDir } from "@/shared/ipc/window";
import { AppDialog } from "@/shared/ui/AppDialog";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { Button } from "neogestify-ui-components";

import { formatTokens } from "../activityModel";
import type { ConversationCard } from "../chatModel";
import { BranchIcon, ChevronDownIcon, ChevronRightIcon, ComputerIcon, DiffIcon, FilePlusIcon, FolderIcon, MoreVerticalIcon, PenIcon, PullRequestIcon } from "../chatIcons";
import { addSurface } from "../store";
import { threadIdOf } from "../structured/model";
import { useStructured } from "../structured/store";
import { useConversationTimeline } from "../timeline/useConversationTimeline";
import type { TimelineItem } from "../timeline/types";
import { useTeamLive } from "../team/useTeamLive";
import { useWorkingDiff } from "../useWorkingDiff";
import { connectorsOf, contextOf, diffTotals, environmentOf, outputsFromItems, pickOutputs, pullTone, pullsOfBranch, type PullTone } from "./summaryModel";
import type { ForgeItem } from "@/features/forge/types";

const EMPTY_ITEMS: TimelineItem[] = [];

/** Os itens da conversa: da timeline da aba (TUI) ou dos eventos da conversa por protocolo. */
function useConversationItems(conversation: ConversationCard | null): TimelineItem[] {
  const tabId = conversation?.tabId ?? "";
  const thread = threadIdOf(tabId);
  const tui = useConversationTimeline(thread ? "" : tabId);
  const structured = useStructured((s) => (thread ? s.live[thread]?.items : undefined));
  return (thread ? structured : tui.timeline?.items) ?? EMPTY_ITEMS;
}

const TONE: Record<PullTone, string> = {
  open: "bg-emerald-500",
  draft: "bg-gray-400 dark:bg-white/35",
  merged: "bg-violet-500",
  closed: "bg-red-500",
};

/** Um cartão arredondado; recolhível quando `onToggle` vem. */
function Card({ title, right, open = true, onToggle, children }: {
  title: string; right?: React.ReactNode; open?: boolean; onToggle?: () => void; children?: React.ReactNode;
}) {
  const head = (
    <>
      <span className="text-chat-ui font-medium text-gray-900 dark:text-white">{title}</span>
      {onToggle && (open ? <ChevronDownIcon className="w-3 h-3 text-gray-500 dark:text-white/45" /> : <ChevronRightIcon className="w-3 h-3 text-gray-500 dark:text-white/45" />)}
      <span className="flex-1" />
      {right}
    </>
  );
  return (
    <section className="rounded-2xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-surface-raised">
      {onToggle ? (
        <button type="button" onClick={onToggle} aria-expanded={open} className="w-full flex items-center gap-2 min-h-11 px-4 text-left">{head}</button>
      ) : (
        <div className="flex items-center gap-2 min-h-11 px-4">{head}</div>
      )}
      {open && children && <div className="px-4 pb-3 flex flex-col gap-1">{children}</div>}
    </section>
  );
}

function Row({ icon, children, right, title }: { icon: React.ReactNode; children: React.ReactNode; right?: React.ReactNode; title?: string }) {
  return (
    <div className="flex items-center gap-2.5 min-h-8 text-chat-note text-gray-800 dark:text-white/85" title={title}>
      <span className="shrink-0 text-gray-500 dark:text-white/45">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {right}
    </div>
  );
}

/**
 * O Resumo do painel direito (a superfície padrão), em cartões como o painel de resumo do Claude desktop:
 * Ambiente, Contexto, Conectores, Saídas e Alterações. Só lê o que o ADE já sabe; o que não tem fonte
 * aparece como "não medido" (o contexto em %, a saúde dos conectores, os checks dos PRs).
 */
export function SummaryPane({ conversation, cwd, tabId }: { conversation: ConversationCard | null; cwd: string | null; tabId: string | null }) {
  const { t } = useTranslation();
  if (!conversation || !cwd) return <p className="p-4 text-chat-note text-gray-400 dark:text-white/40">{t("chat.summary.none")}</p>;
  return (
    <div className="flex-1 min-h-0 cc-scroll p-3.5 flex flex-col gap-3">
      <EnvironmentCard conversation={conversation} cwd={cwd} />
      <ContextCard conversation={conversation} />
      <ConnectorsCard conversation={conversation} />
      <OutputsCard conversation={conversation} cwd={cwd} />
      <ChangesCard conversation={conversation} cwd={cwd} tabId={tabId} />
    </div>
  );
}

function EnvironmentCard({ conversation, cwd }: { conversation: ConversationCard; cwd: string }) {
  const { t } = useTranslation();
  const [home, setHome] = useState<string | null>(null);
  useEffect(() => { homeDir().then(setHome).catch(() => undefined); }, []);
  const live = useTeamLive();
  const env = useMemo(() => environmentOf({ cwd, branch: conversation.branch, isWorktree: conversation.isWorktree }, home), [cwd, conversation.branch, conversation.isWorktree, home]);
  const model = live.modelOf(conversation.tabId);
  return (
    <Card title={t("chat.summary.environment")}>
      <Row icon={<ComputerIcon className="w-4 h-4" />}>{env.place === "worktree" ? t("chat.summary.worktree") : t("chat.summary.computer")}</Row>
      <Row icon={<FolderIcon className="w-4 h-4" />} title={cwd}>
        {env.folder}<span className="text-gray-500 dark:text-white/45"> · {env.parent}</span>
      </Row>
      {env.branch && <Row icon={<BranchIcon className="w-4 h-4" />}>{env.branch}</Row>}
      <Row icon={<span className="w-4 text-center text-[11px] font-semibold">AI</span>}>
        {conversation.agentLabel}{model && <span className="text-gray-500 dark:text-white/45"> · {model}</span>}
      </Row>
    </Card>
  );
}

function ContextCard({ conversation }: { conversation: ConversationCard }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const items = useConversationItems(conversation);
  const tokens = useMemo(() => items.reduce((n, i) => (i.kind === "usage" && typeof i.tokens === "number" ? n + i.tokens : n), 0), [items]);
  const ctx = contextOf(tokens > 0 ? tokens : null);
  return (
    <Card title={t("chat.summary.context")} open={open} onToggle={() => setOpen(!open)}
      right={<span className="text-chat-note text-gray-500 dark:text-white/45">{ctx.measured ? t("chat.summary.contextTokens", { tokens: formatTokens(ctx.tokens ?? 0, i18n.language) }) : t("chat.summary.notMeasured")}</span>}>
      <p className="m-0 text-chat-caption leading-relaxed text-gray-500 dark:text-white/45">{t("chat.summary.contextHint")}</p>
    </Card>
  );
}

function ConnectorsCard({ conversation }: { conversation: ConversationCard }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const list = connectorsOf(hasBrowserMcp(conversation.agentId));
  const on = list.filter((c) => c.on).length;
  return (
    <Card title={t("chat.summary.connectors")} open={open} onToggle={() => setOpen(!open)}
      right={<span className="text-chat-note text-gray-500 dark:text-white/45">{on > 0 ? t("chat.summary.connectorsOn", { count: on }) : t("chat.summary.connectorsNone")}</span>}>
      {list.map((c) => (
        <Row key={c.id} icon={<span aria-hidden="true" className={`block w-2 h-2 rounded-full ${c.on ? "bg-emerald-500" : "bg-gray-300 dark:bg-white/25"}`} />}
          right={<span className="text-chat-caption text-gray-500 dark:text-white/45">{c.on ? t("chat.summary.connectorOn") : t("chat.summary.connectorOff")}</span>}>
          {t(`chat.summary.connector.${c.id}`)}
        </Row>
      ))}
      <p className="m-0 mt-1 text-chat-caption leading-relaxed text-gray-500 dark:text-white/45">{t("chat.summary.connectorsHint")}</p>
    </Card>
  );
}

function OutputsCard({ conversation, cwd }: { conversation: ConversationCard; cwd: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const items = useConversationItems(conversation);
  const outputs = useMemo(() => outputsFromItems(items), [items]);
  const { shown, hidden } = pickOutputs(outputs, expanded);
  // Abre o arquivo no painel de Arquivos (o mesmo editor das Abas).
  const open = (path: string) => { addSurface("files"); useViewTabsStore.getState().openFile(cwd, path); };
  return (
    <Card title={t("chat.summary.outputs")}>
      {outputs.length === 0 && <p className="m-0 py-1 text-chat-caption text-gray-500 dark:text-white/45">{t("chat.summary.outputsEmpty")}</p>}
      {shown.map((file) => (
        <button key={file.path} type="button" onClick={() => open(file.path)} title={file.path}
          className="flex items-center gap-2.5 min-h-8 rounded-md text-left text-chat-note text-gray-800 dark:text-white/85 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
          <span className="shrink-0 text-gray-500 dark:text-white/45">{file.created ? <FilePlusIcon className="w-4 h-4" /> : <PenIcon className="w-4 h-4" />}</span>
          <span className="min-w-0 flex-1 truncate">{file.name}</span>
        </button>
      ))}
      {(hidden > 0 || expanded) && outputs.length > 4 && (
        <button type="button" onClick={() => setExpanded(!expanded)} className="self-start mt-1 text-chat-note text-gray-500 dark:text-white/45 hover:text-gray-900 dark:hover:text-white">
          {expanded ? t("chat.summary.showLess") : t("chat.summary.showMore")}
        </button>
      )}
    </Card>
  );
}

function ChangesCard({ conversation, cwd, tabId }: { conversation: ConversationCard; cwd: string; tabId: string | null }) {
  const { t } = useTranslation();
  const { state } = useWorkingDiff(cwd, tabId);
  const total = useMemo(() => diffTotals(state.files), [state.files]);
  const [committing, setCommitting] = useState(false);
  return (
    <Card title={t("chat.summary.changes")}>
      {state.loaded && !state.repo ? (
        <p className="m-0 py-1 text-chat-caption text-gray-500 dark:text-white/45">{t("chat.panel.noRepo")}</p>
      ) : (
        <div className="flex items-center gap-2.5 min-h-9">
          <span className="shrink-0 text-gray-500 dark:text-white/45"><DiffIcon className="w-4 h-4" /></span>
          <span className="font-mono text-chat-note">
            <span className="text-emerald-700 dark:text-emerald-400">+{total.added}</span>{" "}<span className="text-red-700 dark:text-red-400">−{total.removed}</span>
          </span>
          <span className="flex-1" />
          {/* Só abre o fluxo de commit do ADE (a mensagem se edita lá); nunca commita sozinho. */}
          <button type="button" disabled={total.files === 0} onClick={() => setCommitting(true)}
            className="h-8 px-3 rounded-lg bg-gray-100 dark:bg-white/[0.07] text-chat-note text-gray-900 dark:text-white disabled:opacity-40 hover:bg-gray-200 dark:hover:bg-white/10">
            {t("chat.summary.commit")}
          </button>
        </div>
      )}
      <PullsList cwd={cwd} branch={conversation.branch?.trim() || null} />
      {committing && (
        <AppDialog title={t("chat.summary.commit")} size="md" onClose={() => setCommitting(false)} closeOnEsc
          footer={<Button variant="outline" onClick={() => setCommitting(false)}>{t("btn.close")}</Button>}>
          <div className="h-[60vh] min-h-0 flex flex-col"><ScmPanel cwd={cwd} /></div>
        </AppDialog>
      )}
    </Card>
  );
}

/** Os PRs abertos desta branch, pela integração de GitHub/GitLab do ADE. Sem remoto ou conta, o cartão fica sem lista. */
function PullsList({ cwd, branch }: { cwd: string; branch: string | null }) {
  const { t } = useTranslation();
  const { target } = useRepoTarget(cwd);
  const [pulls, setPulls] = useState<ForgeItem[]>([]);
  useEffect(() => {
    if (!target || !branch) { setPulls([]); return; }
    let alive = true;
    forgePulls(cwd, "open").then((list) => { if (alive) setPulls(pullsOfBranch(list, branch)); }).catch(() => { if (alive) setPulls([]); });
    return () => { alive = false; };
  }, [cwd, branch, target]);
  if (!target || pulls.length === 0) return null;
  return (
    <ul className="m-0 mt-1 p-0 list-none flex flex-col">
      {pulls.map((pull) => (
        <li key={pull.number} className="flex items-start gap-2.5 py-1.5">
          <span className="mt-0.5 shrink-0 text-gray-500 dark:text-white/45"><PullRequestIcon className="w-4 h-4" /></span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-chat-note text-gray-900 dark:text-white" title={pull.title}>{pull.title}</span>
            <span className="block truncate text-chat-caption text-gray-500 dark:text-white/45">{target.path.split("/").pop()} #{pull.number}</span>
          </span>
          <span aria-label={t(`chat.summary.pull.${pullTone(pull)}`)} title={t(`chat.summary.pull.${pullTone(pull)}`)} className={`mt-1.5 shrink-0 w-2 h-2 rounded-full ${TONE[pullTone(pull)]}`} />
          <button type="button" onClick={() => { openUrl(pull.webUrl).catch(console.error); }} aria-label={t("chat.summary.pullOpen")} title={t("chat.summary.pullOpen")}
            className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-gray-500 dark:text-white/45 hover:bg-gray-100 dark:hover:bg-white/10">
            <MoreVerticalIcon className="w-4 h-4" />
          </button>
        </li>
      ))}
    </ul>
  );
}
