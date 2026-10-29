import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Markdown } from "@/shared/ui/LazyMarkdown";

import {
  BotIcon, ChevronDownIcon, ChevronRightIcon, EyeIcon, FilePlusIcon, GlobeIcon, ListIcon, PenIcon, QuestionIcon, SearchIcon, ShieldIcon, TerminalIcon, WrenchIcon,
} from "../chatIcons";
import type { PermissionPrompt } from "@/features/canvas/terminalPrompts";

import { setRightPanel } from "../store";
import { fileName, formatDuration, openTurnStart, timelineTurns, type BodyRow, type ChangedFile, type Turn } from "./timelineModel";
import type { TimelineItem, ToolKind } from "./types";
import { useConversationTimeline } from "./useConversationTimeline";

const TOOL_ICON: Record<ToolKind, (p: { className?: string }) => React.JSX.Element> = {
  read: EyeIcon, edit: PenIcon, write: FilePlusIcon, command: TerminalIcon, search: SearchIcon,
  web: GlobeIcon, task: BotIcon, question: QuestionIcon, todo: ListIcon, other: WrenchIcon,
};

/** Quanto do fim da lista conta como "estou lendo o fim": aí uma resposta nova rola sozinha. */
const STICK_PX = 120;

/**
 * A conversa no desenho do T3 Code, lida do transcript do agente: a mensagem da pessoa numa bolha à
 * direita, as falas do agente em markdown, as ferramentas em linhas curtas ("Leu", "Editou +3 −1",
 * "Rodou") e o fecho do turno com a duração e os arquivos alterados.
 */
export function ConversationTimeline({ tabId, agentLabel, approval, onOpenTerminal }: {
  tabId: string;
  agentLabel: string;
  /** O pedido de permissão que a TUI está mostrando agora (lido da tela). */
  approval: PermissionPrompt | null;
  onOpenTerminal: () => void;
}) {
  const { t } = useTranslation();
  const { timeline, loaded, phase } = useConversationTimeline(tabId);
  const items = useMemo(() => timeline?.items ?? [], [timeline]);
  const turns = useMemo(() => timelineTurns(items), [items]);
  const working = phase === "working" || approval !== null;
  const startedAt = useMemo(() => openTurnStart(items), [items]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns.length, working, items]);

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 cc-scroll"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
      }}>
      <div className="max-w-[736px] mx-auto px-4 sm:px-6 pt-4 pb-6 flex flex-col gap-4 text-[14px] leading-relaxed text-gray-900 dark:text-white">
        {timeline?.truncated && (
          <p className="text-center text-[12px] text-gray-400 dark:text-white/35">{t("chat.timeline.truncated")}</p>
        )}
        {!loaded && <p className="py-10 text-center text-[13px] text-gray-400 dark:text-white/40">{t("chat.timeline.loading")}</p>}
        {loaded && !timeline && (
          <div className="py-10 flex flex-col items-center gap-3 text-center text-[13px] text-gray-400 dark:text-white/40">
            <p>{t("chat.timeline.waiting", { agent: agentLabel })}</p>
            <button type="button" onClick={onOpenTerminal}
              className="h-7 px-3 rounded-md border border-gray-200 dark:border-white/10 text-gray-700 dark:text-white/70 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
              {t("chat.timeline.openTerminal")}
            </button>
          </div>
        )}
        {loaded && timeline && turns.length === 0 && !working && (
          <p className="py-10 text-center text-[13px] text-gray-400 dark:text-white/40">{t("chat.timeline.empty", { agent: agentLabel })}</p>
        )}
        {turns.map((turn, i) => <TurnView key={turn.key} turn={turn} latest={i === turns.length - 1} onOpenTerminal={onOpenTerminal} />)}
        {approval && (
          <div className="flex flex-col gap-1.5 px-1">
            <div className="flex items-center gap-2.5 min-h-[26px] text-[14px] font-medium text-amber-700 dark:text-amber-400">
              <ShieldIcon className="w-4 h-4" />{t("chat.timeline.approval")}
            </div>
            <p className="m-0 ml-[26px] text-[13px] text-gray-600 dark:text-white/60">{approval.title}</p>
            {approval.detail && (
              <pre className="m-0 ml-[26px] px-2.5 py-2 rounded-lg font-mono text-[12px] whitespace-pre-wrap break-words
                bg-gray-50 dark:bg-white/[0.04] border border-gray-200 dark:border-white/[0.08] text-gray-900 dark:text-white">{approval.detail}</pre>
            )}
          </div>
        )}
        {working && <WorkingLine since={startedAt} waiting={approval !== null} />}
      </div>
    </div>
  );
}

function TurnView({ turn, latest, onOpenTerminal }: { turn: Turn; latest: boolean; onOpenTerminal: () => void }) {
  const { t } = useTranslation();
  // Os turnos antigos começam recolhidos; o último (ou o em aberto), aberto.
  const [open, setOpen] = useState(latest || turn.end === null);
  const foldable = turn.end !== null && turn.body.length > 0;
  return (
    <>
      {turn.user && (
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-2xl p-3 bg-gray-200/60 dark:bg-white/[0.08] whitespace-pre-wrap break-words">{turn.user.text}</div>
        </div>
      )}
      {turn.end && (
        <button type="button" onClick={() => foldable && setOpen(!open)} aria-expanded={foldable ? open : undefined}
          className={`flex items-center gap-1.5 px-1 pb-2 border-b border-gray-200 dark:border-white/[0.08] text-left text-[14px] text-gray-500 dark:text-white/45
            ${foldable ? "hover:text-gray-800 dark:hover:text-white/75" : "cursor-default"}`}>
          {turn.end.interrupted
            ? t("chat.timeline.interrupted")
            : turn.end.durationMs !== null
              ? t("chat.timeline.workedFor", { duration: formatDuration(turn.end.durationMs) })
              : t("chat.timeline.done")}
          {foldable && <ChevronDownIcon className={`w-3.5 h-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />}
        </button>
      )}
      {(open || turn.end === null) && turn.body.map((row) => <BodyRowView key={row.key} row={row} onOpenTerminal={onOpenTerminal} />)}
      {turn.final && <div className="px-1 text-[14px] break-words"><Markdown content={turn.final.text ?? ""} /></div>}
      {turn.end && turn.end.files.length > 0 && <div className="px-1"><ChangedFilesCard files={turn.end.files} /></div>}
    </>
  );
}

function BodyRowView({ row, onOpenTerminal }: { row: BodyRow; onOpenTerminal: () => void }) {
  const { t } = useTranslation();
  switch (row.type) {
    case "assistant":
      return <div className="px-1 text-[14px] break-words"><Markdown content={row.item.text ?? ""} /></div>;
    case "work":
      return (
        <div className="flex flex-col px-1">
          {row.tools.map((tool) => <ToolRow key={tool.id} tool={tool} />)}
        </div>
      );
    case "question":
      return (
        <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.03] p-3.5 flex flex-col gap-2.5">
          <div className="flex items-center gap-2 text-[13px] font-medium text-gray-700 dark:text-white/80">
            <QuestionIcon className="w-4 h-4" />{t("chat.timeline.question")}
          </div>
          <p className="m-0">{row.item.question?.text}</p>
          {(row.item.question?.options.length ?? 0) > 0 && (
            <ul className="m-0 p-0 list-none flex flex-wrap gap-1.5">
              {row.item.question!.options.map((o) => (
                <li key={o} className="px-2 py-0.5 rounded-md bg-white dark:bg-white/[0.06] border border-gray-200 dark:border-white/10 text-[12.5px]">{o}</li>
              ))}
            </ul>
          )}
          <button type="button" onClick={onOpenTerminal}
            className="self-start h-7 px-3 rounded-md bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-[12.5px] font-medium">
            {t("chat.timeline.answerInTerminal")}
          </button>
        </div>
      );
  }
}

const VERB: Record<ToolKind, string> = {
  read: "chat.tool.read", edit: "chat.tool.edit", write: "chat.tool.write", command: "chat.tool.command", search: "chat.tool.search",
  web: "chat.tool.web", task: "chat.tool.task", question: "chat.tool.question", todo: "chat.tool.todo", other: "chat.tool.other",
};

function ToolRow({ tool }: { tool: TimelineItem }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const kind = tool.tool ?? "other";
  const Icon = TOOL_ICON[kind];
  const target = kind === "todo" ? t("chat.tool.todoCount", { count: Number(tool.label ?? 0) }) : tool.path ? fileName(tool.path) : tool.label ?? "";
  const canOpen = !!tool.output;
  return (
    <div className="flex flex-col">
      <button type="button" onClick={() => canOpen && setOpen(!open)} aria-expanded={canOpen ? open : undefined}
        title={tool.path ?? tool.label}
        className={`group flex items-center gap-2.5 min-h-[26px] text-left text-[13.5px] text-gray-600 dark:text-white/60 ${canOpen ? "cursor-pointer hover:text-gray-900 dark:hover:text-white/85" : "cursor-default"}`}>
        <Icon className={`w-4 h-4 shrink-0 ${tool.status === "error" || tool.status === "denied" ? "text-red-500 dark:text-red-400" : "text-gray-400 dark:text-white/40"}`} />
        <span className="shrink-0">{t(VERB[kind])}</span>
        {target && <span className={`min-w-0 truncate ${kind === "command" || tool.path ? "font-mono text-[12.5px]" : ""} text-gray-800 dark:text-white/80`}>{target}</span>}
        {(tool.added ?? 0) + (tool.removed ?? 0) > 0 && (
          <span className="shrink-0 font-mono text-[12px]">
            <span className="text-emerald-600 dark:text-emerald-400">+{tool.added ?? 0}</span>{" "}
            <span className="text-red-600 dark:text-red-400">−{tool.removed ?? 0}</span>
          </span>
        )}
        {tool.status === "running" && <span aria-label={t("chat.tool.running")} className="shrink-0 w-1.5 h-1.5 rounded-full bg-accent-500 animate-pulse" />}
        {tool.status === "error" && <span className="shrink-0 text-[12px] text-red-600 dark:text-red-400">{t("chat.tool.failed")}</span>}
        {tool.status === "denied" && <span className="shrink-0 text-[12px] text-red-600 dark:text-red-400">{t("chat.tool.denied")}</span>}
        {canOpen && <ChevronRightIcon className={`w-3.5 h-3.5 shrink-0 text-gray-300 dark:text-white/25 transition-transform ${open ? "rotate-90" : ""}`} />}
      </button>
      {open && tool.output && (
        <pre className="m-0 ml-[26px] mt-1 mb-2 max-h-72 overflow-auto rounded-lg px-3 py-2 font-mono text-[12px] leading-snug whitespace-pre-wrap break-words
          bg-gray-50 dark:bg-white/[0.04] border border-gray-200 dark:border-white/[0.08] text-gray-700 dark:text-white/70">
          {tool.output}
        </pre>
      )}
    </div>
  );
}

function ChangedFilesCard({ files }: { files: ChangedFile[] }) {
  const { t } = useTranslation();
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return (
    <div className="rounded-lg border border-gray-200 dark:border-white/[0.08] bg-gray-50 dark:bg-white/[0.03] overflow-hidden">
      <div className="flex items-center gap-2 h-9 pl-3 pr-2 text-[13px]">
        <span className="font-medium">{t("chat.timeline.changedFiles", { count: files.length })}</span>
        <span className="font-mono text-[12px]">
          <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>{" "}
          <span className="text-red-600 dark:text-red-400">−{removed}</span>
        </span>
        <span className="flex-1" />
        <button type="button" onClick={() => setRightPanel("diff")}
          className="flex items-center gap-1.5 h-6 px-2 rounded-md text-[12px] font-medium text-gray-600 dark:text-white/60 hover:bg-gray-200/60 dark:hover:bg-white/10">
          <FilePlusIcon className="w-3.5 h-3.5" />{t("chat.timeline.openDiff")}
        </button>
      </div>
      <ul className="m-0 px-3 pb-2.5 list-none flex flex-col gap-0.5 font-mono text-[11.5px] text-gray-600 dark:text-white/60">
        {files.map((f) => (
          <li key={f.path} title={f.path} className="flex items-center gap-2 min-w-0">
            <span className="truncate">{f.path}</span>
            <span className="shrink-0 text-emerald-600 dark:text-emerald-400">+{f.added}</span>
            <span className="shrink-0 text-red-600 dark:text-red-400">−{f.removed}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Trabalhando há 12s", contando a partir da última mensagem da pessoa. */
function WorkingLine({ since, waiting }: { since: number | null; waiting: boolean }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="flex items-center gap-2 px-1 text-[13.5px] text-gray-500 dark:text-white/45">
      <span className="w-2 h-2 rounded-full bg-accent-500 animate-pulse" />
      {waiting ? t("chat.timeline.waitingApproval") : since !== null ? t("chat.timeline.workingFor", { duration: formatDuration(now - since) }) : t("chat.timeline.working")}
    </div>
  );
}
