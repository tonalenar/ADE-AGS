import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Markdown } from "@/shared/ui/LazyMarkdown";

import {
  BotIcon, ChevronDownIcon, ChevronRightIcon, EyeIcon, FilePlusIcon, GlobeIcon, ListIcon, PenIcon, QuestionIcon, SearchIcon, ShieldIcon, TerminalIcon, WrenchIcon,
} from "../chatIcons";

import { useChatWidthClass } from "../chatLook";
import { PlanCard } from "../LiveActivity";
import { setRightPanel } from "../store";
import { AgentBubble, PersonBubble } from "./Bubbles";
import { parsePeerEnvelope, senderAgent } from "./peerEnvelope";
import { speakerHeaders } from "./speakers";
import type { PendingSend } from "./pending";
import { displayUserText } from "./userMessage";
import { isFresh } from "./streaming";
import { commandTitle } from "./toolTitle";
import { activityOf, joinParts, summarizeTools } from "./workSummary";
import { fileName, formatDuration, openTurnStart, timelineTurns, type BodyRow, type ChangedFile, type Turn } from "./timelineModel";
import type { TimelineItem, ToolKind } from "./types";
import { prefersReducedMotion, useRevealedText } from "./useRevealedText";

const TOOL_ICON: Record<ToolKind, (p: { className?: string }) => React.JSX.Element> = {
  read: EyeIcon, edit: PenIcon, write: FilePlusIcon, command: TerminalIcon, search: SearchIcon,
  web: GlobeIcon, task: BotIcon, question: QuestionIcon, todo: ListIcon, other: WrenchIcon,
};

/** Quanto do fim da lista conta como "estou lendo o fim": aí uma resposta nova rola sozinha. */
const STICK_PX = 120;

/** Como cada fala do agente aparece: aos poucos (chegou agora) e com o cursor (ainda chegando). */
interface RevealOf {
  animate: (item: TimelineItem) => boolean;
  live: (id: string) => boolean;
  /** A mensagem chegou depois de a conversa abrir: entra com um fade/slide curto (uma vez só). */
  entering: (id: string) => boolean;
  /** Quem fala nas falas do agente da conversa. */
  agent: { id: string; label: string };
  /** As falas que levam o logo e o nome de quem fala acima do texto (`speakers.ts`). */
  headers: ReadonlySet<string>;
}

const RevealContext = createContext<RevealOf>({ animate: () => false, live: () => false, entering: () => false, agent: { id: "", label: "" }, headers: new Set() });

/** O pedido que espera a pessoa, como a timeline o mostra. */
export interface ApprovalNote {
  title: string;
  detail?: string | null;
}

/**
 * A conversa no desenho do T3 Code: a mensagem da pessoa numa bolha à direita, as falas do agente em
 * markdown, as ferramentas em linhas curtas ("Leu", "Editou +3 −1", "Rodou"), o plano do turno em
 * aberto e o fecho do turno com a duração e os arquivos alterados. Alimentada por itens: os do
 * transcript (`ConversationView`, por `useConversationTimeline`) ou os que o agente manda pelo
 * protocolo (`StructuredConversationView`).
 */
export function TimelineView({ bottomInset = 0, items, loaded, missing = false, truncated = false, working, approval, approvalCard = null, live = false, streaming, agentLabel, agentId = "", pending = [], onOpenTerminal, after = null }: {
  /** O espaço no fim da lista para o composer que flutua por cima (`ChatFrame`); 0 = o fim de sempre. */
  bottomInset?: number;
  items: TimelineItem[];
  loaded: boolean;
  /** Ainda não há de onde ler (o transcript não existe): oferece o terminal. */
  missing?: boolean;
  truncated?: boolean;
  working: boolean;
  approval: ApprovalNote | null;
  /** O cartão do pedido de permissão (prancheta 14), no lugar da nota. */
  approvalCard?: React.ReactNode;
  /** A linha viva fica acima do composer (prancheta 13): aqui não se repete o "Trabalhando há…". */
  live?: boolean;
  /** Os itens cujo texto ainda está chegando (rascunhos do protocolo): aparecem aos poucos, com o cursor. */
  streaming?: ReadonlySet<string>;
  agentLabel: string;
  /** O agente da conversa (o logo ao lado das falas dele). */
  agentId?: string;
  /** As mensagens da pessoa enviadas e ainda sem eco (`pending.ts`): aparecem na hora, no fim do fio. */
  pending?: PendingSend[];
  /** Sem terminal (protocolo), as perguntas se respondem no composer. */
  onOpenTerminal?: () => void;
  /** Depois dos turnos, no fim do fio: as delegações e entregas do time (`team/TeamThreadFeed`). */
  after?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const turns = useMemo(() => timelineTurns(items), [items]);
  const width = useChatWidthClass();
  const startedAt = useMemo(() => openTurnStart(items), [items]);

  // O que já estava na conversa ao abrir aparece inteiro; só o que chega depois aparece aos poucos.
  const [mountedAt] = useState(() => Date.now());
  const baseline = useRef<Set<string> | null>(null);
  if (baseline.current === null && loaded) baseline.current = new Set(items.filter((i) => !streaming?.has(i.id)).map((i) => i.id));
  // Cada mensagem entra animada uma única vez (remontar ao mudar de lugar no turno não repete).
  const entered = useRef<Set<string>>(new Set());
  const headers = useMemo(() => speakerHeaders(items), [items]);
  const reveal = useMemo<RevealOf>(() => ({
    animate: (item) => !!streaming?.has(item.id) || (baseline.current !== null && isFresh(item, baseline.current, mountedAt)),
    live: (id) => working && !!streaming?.has(id),
    entering: (id) => {
      if (baseline.current === null || baseline.current.has(id) || entered.current.has(id)) return false;
      entered.current.add(id);
      return true;
    },
    agent: { id: agentId, label: agentLabel },
    headers,
  }), [streaming, mountedAt, working, agentId, agentLabel, headers]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTurns = useRef(0);
  const lastPending = useRef(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !stick.current) return;
    // Mensagem nova no fim: rola suave; texto que só cresce: acompanha sem animar.
    const grew = turns.length > lastTurns.current || pending.length > lastPending.current;
    lastTurns.current = turns.length;
    lastPending.current = pending.length;
    if (grew && loaded && !prefersReducedMotion() && typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  }, [turns.length, pending.length, working, items, loaded]);
  // O texto que aparece aos poucos cresce sem redesenhar a lista: a rolagem acompanha o tamanho,
  // se a pessoa estava no fim.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (stick.current) el.scrollTop = el.scrollHeight; });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 cc-scroll"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
      }}>
      <RevealContext.Provider value={reveal}>
      <div ref={contentRef} style={bottomInset > 0 ? { paddingBottom: bottomInset } : undefined}
        className={`${width} mx-auto px-4 sm:px-6 pt-4 ${bottomInset > 0 ? "" : "pb-6"} flex flex-col gap-4 text-chat-prose text-gray-900 dark:text-white`}>
        {truncated && (
          <p className="text-center text-chat-caption text-gray-400 dark:text-white/35">{t("chat.timeline.truncated")}</p>
        )}
        {!loaded && <p className="py-10 text-center text-chat-note text-gray-400 dark:text-white/40">{t("chat.timeline.loading")}</p>}
        {missing && onOpenTerminal && (
          <div className="py-10 flex flex-col items-center gap-3 text-center text-chat-note text-gray-400 dark:text-white/40">
            <p>{t("chat.timeline.waiting", { agent: agentLabel })}</p>
            <button type="button" onClick={onOpenTerminal}
              className="h-7 px-3 rounded-md border border-gray-200 dark:border-white/10 text-gray-700 dark:text-white/70 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
              {t("chat.timeline.openTerminal")}
            </button>
          </div>
        )}
        {loaded && !missing && turns.length === 0 && !working && (
          <p className="py-10 text-center text-chat-note text-gray-400 dark:text-white/40">{t("chat.timeline.empty", { agent: agentLabel })}</p>
        )}
        {turns.map((turn, i) => <TurnView key={turn.key} turn={turn} latest={i === turns.length - 1} onOpenTerminal={onOpenTerminal} />)}
        {pending.map((p) => { const shown = displayUserText(p.text); return shown ? <PersonBubble key={p.id} text={shown} sending /> : null; })}
        {approvalCard}
        {!approvalCard && approval && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2.5 min-h-[26px] text-chat-ui font-medium text-amber-700 dark:text-amber-400">
              <ShieldIcon className="w-4 h-4" />{t("chat.timeline.approval")}
            </div>
            <p className="m-0 ml-[26px] text-chat-note text-gray-600 dark:text-white/60">{approval.title}</p>
            {approval.detail && (
              <pre className="m-0 ml-[26px] px-2.5 py-2 rounded-lg font-mono text-chat-code whitespace-pre-wrap break-words
                bg-gray-50 dark:bg-white/[0.04] border border-gray-200 dark:border-white/[0.08] text-gray-900 dark:text-white">{approval.detail}</pre>
            )}
          </div>
        )}
        {working && !live && <WorkingLine since={startedAt} waiting={approval !== null} />}
        {after}
      </div>
      </RevealContext.Provider>
    </div>
  );
}

function TurnView({ turn, latest, onOpenTerminal }: { turn: Turn; latest: boolean; onOpenTerminal?: () => void }) {
  const { t } = useTranslation();
  // Os turnos antigos começam recolhidos; o último (ou o em aberto), aberto.
  const [open, setOpen] = useState(latest || turn.end === null);
  const foldable = turn.end !== null && turn.body.length > 0;
  return (
    <>
      {turn.user && <UserMessage item={turn.user} />}
      {turn.end === null && turn.plan && <PlanCard plan={turn.plan} />}
      {turn.end && (
        <button type="button" onClick={() => foldable && setOpen(!open)} aria-expanded={foldable ? open : undefined}
          className={`flex items-center gap-1.5 pb-2 border-b border-gray-200 dark:border-white/[0.08] text-left text-chat-ui text-gray-500 dark:text-white/45
            ${foldable ? "hover:text-gray-800 dark:hover:text-white/75" : "cursor-default"}`}>
          {turn.end.interrupted
            ? t("chat.timeline.interrupted")
            : turn.end.durationMs !== null
              ? t("chat.timeline.workedFor", { duration: formatDuration(turn.end.durationMs) })
              : t("chat.timeline.done")}
          {foldable && <ChevronDownIcon className={`w-3.5 h-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />}
        </button>
      )}
      {(open || turn.end === null) && turn.body.map((row, i) => (
        <BodyRowView key={row.key} row={row} onOpenTerminal={onOpenTerminal} active={turn.end === null && i === turn.body.length - 1} />
      ))}
      {turn.final && <AgentText item={turn.final} />}
      {turn.end && turn.end.files.length > 0 && <div><ChangedFilesCard files={turn.end.files} /></div>}
    </>
  );
}

/**
 * A "mensagem da pessoa" de um turno. Se ela é, na verdade, de outro agente (`ags peer tell/ask`
 * cai no terminal como mensagem do usuário), mostra só o corpo, no balão do remetente e com o logo
 * dele; o envelope de segurança continua indo ao modelo, só a tela o esconde (`peerEnvelope.ts`).
 */
function UserMessage({ item }: { item: TimelineItem }) {
  const reveal = useContext(RevealContext);
  const text = item.text ?? "";
  const peer = useMemo(() => parsePeerEnvelope(text), [text]);
  const [entering] = useState(() => !!peer && reveal.entering(item.id));
  if (!peer) return <PersonBubble text={text} />;
  return (
    <AgentBubble agentId="" command={senderAgent(peer.sender)} label={peer.sender} sender={peer.sender} header={reveal.headers.has(item.id)} entering={entering}>
      <Markdown content={peer.body} tone="chat" />
    </AgentBubble>
  );
}

/**
 * Uma fala do agente em markdown. A que chegou agora aparece palavra a palavra; enquanto o texto
 * ainda chega (ou ainda está aparecendo), um cursor discreto fica no fim (`cc-stream-caret`).
 */
function AgentText({ item }: { item: TimelineItem }) {
  const reveal = useContext(RevealContext);
  const { text, revealing } = useRevealedText(item.id, item.text ?? "", reveal.animate(item));
  const caret = revealing || reveal.live(item.id);
  const [entering] = useState(() => reveal.entering(item.id));
  return (
    <AgentBubble agentId={reveal.agent.id} label={reveal.agent.label} header={reveal.headers.has(item.id)} entering={entering} caret={caret}>
      <Markdown content={text} tone="chat" />
    </AgentBubble>
  );
}

/** `active`: a última linha do turno em aberto (o agente ainda está trabalhando nela). */
function BodyRowView({ row, onOpenTerminal, active = false }: { row: BodyRow; onOpenTerminal?: () => void; active?: boolean }) {
  const { t } = useTranslation();
  switch (row.type) {
    case "assistant":
      return <AgentText item={row.item} />;
    case "work":
      // Uma ferramenta só aparece como é; duas ou mais viram uma linha-resumo recolhida.
      return row.tools.length === 1
        ? <div className="flex flex-col"><ToolRow tool={row.tools[0]!} /></div>
        : <WorkGroup tools={row.tools} active={active} />;
    case "infra":
      return <InfraRow tools={row.tools} />;
    case "question":
      return (
        <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.03] p-3.5 flex flex-col gap-2.5">
          <div className="flex items-center gap-2 text-chat-note font-medium text-gray-700 dark:text-white/80">
            <QuestionIcon className="w-4 h-4" />{t("chat.timeline.question")}
          </div>
          <p className="m-0">{row.item.question?.text}</p>
          {(row.item.question?.options.length ?? 0) > 0 && (
            <ul className="m-0 p-0 list-none flex flex-wrap gap-1.5">
              {row.item.question!.options.map((o) => (
                <li key={o} className="px-2 py-0.5 rounded-md bg-white dark:bg-white/[0.06] border border-gray-200 dark:border-white/10 text-chat-note">{o}</li>
              ))}
            </ul>
          )}
          {onOpenTerminal && (
            <button type="button" onClick={onOpenTerminal}
              className="self-start h-7 px-3 rounded-md bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-chat-note font-medium">
              {t("chat.timeline.answerInTerminal")}
            </button>
          )}
        </div>
      );
  }
}

const VERB: Record<ToolKind, string> = {
  read: "chat.tool.read", edit: "chat.tool.edit", write: "chat.tool.write", command: "chat.tool.command", search: "chat.tool.search",
  web: "chat.tool.web", task: "chat.tool.task", question: "chat.tool.question", todo: "chat.tool.todo", other: "chat.tool.other",
};

/**
 * Ferramentas em sequência numa linha só, recolhida ("Leu 1 arquivo, rodou 13 comandos · 1 falhou"),
 * como o Claude Code. O chevron abre a lista (cada uma como sempre, uma linha). Com o turno rodando,
 * a linha mostra também, discreta, a atividade atual e o ponto pulsante. Quem abriu o grupo o mantém
 * aberto: o estado é do componente e a chave da linha não muda quando chegam itens novos.
 */
function WorkGroup({ tools, active }: { tools: TimelineItem[]; active: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => summarizeTools(tools), [tools]);
  const title = joinParts(summary.parts.map((p) => t(`chat.work.${p.kind}`, { count: p.count })));
  const activity = active ? activityOf(summary.last) : "";
  const Icon = TOOL_ICON[summary.parts[0]?.kind ?? "other"];
  return (
    <div className="flex flex-col">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} title={activity || title}
        className="flex min-w-0 items-center gap-2.5 min-h-[26px] text-left text-chat-ui text-gray-600 dark:text-white/60 hover:text-gray-900 dark:hover:text-white/85">
        <Icon className="w-4 h-4 shrink-0 text-gray-400 dark:text-white/40" />
        <span className="shrink-0 whitespace-nowrap">{title}</span>
        {summary.failed > 0 && <span className="shrink-0 whitespace-nowrap text-chat-caption text-red-600 dark:text-red-400">· {t("chat.work.failed", { count: summary.failed })}</span>}
        {activity && <span className="min-w-0 flex-1 truncate font-mono text-chat-code text-gray-400 dark:text-white/35">{activity}</span>}
        {!activity && <span className="flex-1" />}
        {active && <span aria-hidden="true" className="shrink-0 w-1.5 h-1.5 rounded-full bg-accent-500 animate-pulse" />}
        <ChevronRightIcon className={`w-3.5 h-3.5 shrink-0 text-gray-300 dark:text-white/25 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && <div className="ml-[26px] flex flex-col">{tools.map((tool) => <ToolRow key={tool.id} tool={tool} />)}</div>}
    </div>
  );
}

/** Os comandos `ags …` do time numa linha só, recolhida: bastidor, a conversa não os mostra um a um. */
function InfraRow({ tools }: { tools: TimelineItem[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex items-center gap-2.5 min-h-[26px] text-left text-chat-ui text-gray-500 dark:text-white/45 hover:text-gray-800 dark:hover:text-white/75">
        <TerminalIcon className="w-4 h-4 shrink-0 text-gray-400 dark:text-white/40" />
        <span>{t("chat.tool.infra", { count: tools.length })}</span>
        <ChevronRightIcon className={`w-3.5 h-3.5 shrink-0 text-gray-300 dark:text-white/25 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && <div className="ml-[26px] flex flex-col">{tools.map((tool) => <ToolRow key={tool.id} tool={tool} />)}</div>}
    </div>
  );
}

function ToolRow({ tool }: { tool: TimelineItem }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const kind = tool.tool ?? "other";
  const Icon = TOOL_ICON[kind];
  // O comando aparece sem o invólucro do shell e numa linha só (programa em destaque); o inteiro
  // fica no tooltip e no conteúdo expandido.
  const command = kind === "command" ? commandTitle(tool.label ?? "") : null;
  const target = command ? "" : kind === "todo" ? t("chat.tool.todoCount", { count: Number(tool.label ?? 0) }) : tool.path ? fileName(tool.path) : tool.label ?? "";
  const longCommand = !!command && (command.script || command.full.includes("\n") || command.full.length > 90);
  const canOpen = !!tool.output || longCommand;
  return (
    <div className="flex flex-col">
      <button type="button" onClick={() => canOpen && setOpen(!open)} aria-expanded={canOpen ? open : undefined}
        title={command?.full || tool.path || tool.label}
        className={`group flex items-center gap-2.5 min-h-[26px] text-left text-chat-ui text-gray-600 dark:text-white/60 ${canOpen ? "cursor-pointer hover:text-gray-900 dark:hover:text-white/85" : "cursor-default"}`}>
        <Icon className={`w-4 h-4 shrink-0 ${tool.status === "error" || tool.status === "denied" ? "text-red-500 dark:text-red-400" : "text-gray-400 dark:text-white/40"}`} />
        <span className="shrink-0">{t(VERB[kind])}</span>
        {command && (
          <span className="min-w-0 flex-1 truncate whitespace-nowrap font-mono text-chat-code text-gray-500 dark:text-white/50">
            <span className="font-medium text-gray-800 dark:text-white/85">{command.program}</span>
            {command.rest && <> {command.rest}</>}
            {command.script && <span className="text-gray-400 dark:text-white/35"> · {t("chat.tool.script")}</span>}
          </span>
        )}
        {target && <span className={`min-w-0 truncate ${tool.path ? "font-mono text-chat-code" : ""} text-gray-800 dark:text-white/80`}>{target}</span>}
        {(tool.added ?? 0) + (tool.removed ?? 0) > 0 && (
          <span className="shrink-0 font-mono text-chat-code">
            <span className="text-emerald-600 dark:text-emerald-400">+{tool.added ?? 0}</span>{" "}
            <span className="text-red-600 dark:text-red-400">−{tool.removed ?? 0}</span>
          </span>
        )}
        {tool.status === "running" && <span aria-label={t("chat.tool.running")} className="shrink-0 w-1.5 h-1.5 rounded-full bg-accent-500 animate-pulse" />}
        {tool.status === "error" && <span className="shrink-0 text-chat-caption text-red-600 dark:text-red-400">{t("chat.tool.failed")}</span>}
        {tool.status === "denied" && <span className="shrink-0 text-chat-caption text-red-600 dark:text-red-400">{t("chat.tool.denied")}</span>}
        {canOpen && <ChevronRightIcon className={`w-3.5 h-3.5 shrink-0 text-gray-300 dark:text-white/25 transition-transform ${open ? "rotate-90" : ""}`} />}
      </button>
      {open && command && longCommand && (
        <pre className="m-0 ml-[26px] mt-1 max-h-48 overflow-auto rounded-lg px-3 py-2 font-mono text-chat-code leading-snug whitespace-pre-wrap break-words
          bg-gray-50 dark:bg-white/[0.04] border border-gray-200 dark:border-white/[0.08] text-gray-800 dark:text-white/80">
          {command.full}
        </pre>
      )}
      {open && tool.output && (
        <pre className="m-0 ml-[26px] mt-1 mb-2 max-h-72 overflow-auto rounded-lg px-3 py-2 font-mono text-chat-code leading-snug whitespace-pre-wrap break-words
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
      <div className="flex items-center gap-2 h-9 pl-3 pr-2 text-chat-note">
        <span className="font-medium">{t("chat.timeline.changedFiles", { count: files.length })}</span>
        <span className="font-mono text-chat-code">
          <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>{" "}
          <span className="text-red-600 dark:text-red-400">−{removed}</span>
        </span>
        <span className="flex-1" />
        <button type="button" onClick={() => setRightPanel("diff")}
          className="flex items-center gap-1.5 h-6 px-2 rounded-md text-chat-caption font-medium text-gray-600 dark:text-white/60 hover:bg-gray-200/60 dark:hover:bg-white/10">
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
    <div className="flex items-center gap-2 text-chat-ui text-gray-500 dark:text-white/45">
      <span className="w-2 h-2 rounded-full bg-accent-500 animate-pulse" />
      {waiting ? t("chat.timeline.waitingApproval") : since !== null ? t("chat.timeline.workingFor", { duration: formatDuration(now - since) }) : t("chat.timeline.working")}
    </div>
  );
}
