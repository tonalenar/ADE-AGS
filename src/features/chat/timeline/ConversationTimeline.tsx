import { applyToolCallVisibility } from "./toolCallVisibility";
import { useChatPrefs } from "../chatPrefs";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Markdown } from "@/shared/ui/LazyMarkdown";

import {
  BotIcon, BrainIcon, ChevronDownIcon, ChevronRightIcon, EyeIcon, FilePlusIcon, GlobeIcon, ListIcon, PenIcon, QuestionIcon, SearchIcon, ShieldIcon, TerminalIcon, WrenchIcon, XIcon,
} from "../chatIcons";

import { useChatWidthClass } from "../chatLook";
import { PlanCard } from "../LiveActivity";
import { McpAppFrame } from "../mcpApps/McpAppFrame";
import { appResourceOf, mcpAppServerOf } from "../mcpApps/mcpAppResource";
import { clearTimelineFind, setRightPanel, useChatStore } from "../store";
import { AgentBubble, PersonBubble } from "./Bubbles";
import { renderChatCodeBlock } from "./CodeBlockFrame";
import { parsePeerEnvelope, senderAgent } from "./peerEnvelope";
import { speakerHeaders } from "./speakers";
import type { PendingSend } from "./pending";
import { displayUserText } from "./userMessage";
import { isFresh } from "./streaming";
import { commandTitle } from "./toolTitle";
import { activityOf, joinParts, summarizeTools } from "./workSummary";
import { SelectionComment } from "../quotes/SelectionComment";
import { voicesByItem } from "./agentSwitch";
import { NoticeRow } from "./NoticeRow";
import { TurnEndNotice } from "./TurnEndNotice";
import { endOutcome, fileName, formatDuration, isUnknownOutcome, openTurnStart, thinkingTurnKey, timelineTurns, visibleTurnBody, type BodyRow, type ChangedFile, type Turn } from "./timelineModel";
import type { TimelineItem, ToolKind } from "./types";
import { prefersReducedMotion, useRevealedText } from "./useRevealedText";
import { searchTimelineItems } from "./searchUtils";

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
  /** Quem fala nas falas do agente da conversa (e, depois de trocar de agente, quem falou cada uma). */
  agent: { id: string; label: string };
  voiceOf: (itemId: string) => { id: string; label: string };
  /** As falas que levam o logo e o nome de quem fala acima do texto (`speakers.ts`). */
  headers: ReadonlySet<string>;
}

/** Responder a pergunta em aberto pelo cartão dela (só nas conversas por protocolo, com uma pergunta esperando). */
const AnswerContext = createContext<((choice: string) => void) | null>(null);

const RevealContext = createContext<RevealOf>({ animate: () => false, live: () => false, entering: () => false, agent: { id: "", label: "" }, voiceOf: () => ({ id: "", label: "" }), headers: new Set() });

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
export function TimelineView({ bottomInset = 0, items, loaded, missing = false, truncated = false, working, approval, approvalCard = null, live = false, streaming, agentLabel, agentId = "", pending = [], onOpenTerminal, onResend, onAnswer, quoteKey, after = null, threadId, conversationKey, searchTargetId = null, searchTargetToken = null, onSearchTargetApplied }: {
  /** A conversa por protocolo (os avisos do pool de contas pedem a resposta dela). */
  threadId?: string;
  /** Identidade local usada para abrir a busca apenas na timeline visível. */
  conversationKey?: string;
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
  /** Há uma pergunta do agente em aberto: as opções do cartão dela viram botões que respondem por aqui. */
  onAnswer?: (choice: string) => void;
  /** A conversa de que se pode citar um trecho («Comentar»); sem ela, não há botão. */
  quoteKey?: string;
  /** Reenvia uma mensagem que saiu da fila do agente sem ser enviada (o aviso «não enviada»). Sem ele, sem o botão. */
  onResend?: (text: string) => void;
  /** Depois dos turnos, no fim do fio: as delegações e entregas do time (`team/TeamThreadFeed`). */
  after?: React.ReactNode;
  /** Resultado da busca que deve ser levado à vista e realçado uma vez. */
  searchTargetId?: string | null;
  searchTargetToken?: number | null;
  onSearchTargetApplied?: (token: number) => void;
}) {
  const { t } = useTranslation();
  // "Chamadas de ferramenta no chat" (Configurações → Chat): o fold mostra só o que o modo deixa.
  const toolVisibility = useChatPrefs().toolCallVisibility;
  const allTurns = useMemo(() => timelineTurns(items), [items]);
  const turns = useMemo(() => applyToolCallVisibility(allTurns, toolVisibility), [allTurns, toolVisibility]);
  // O «Pensando…» com brilho: só enquanto o agente trabalha, sem pedido de aprovação esperando (aí ninguém está pensando).
  const thinkingKey = working && approval === null && !approvalCard ? thinkingTurnKey(allTurns) : null;
  const width = useChatWidthClass();
  const startedAt = useMemo(() => openTurnStart(items), [items]);

  // O que já estava na conversa ao abrir aparece inteiro; só o que chega depois aparece aos poucos.
  const [mountedAt] = useState(() => Date.now());
  const baseline = useRef<Set<string> | null>(null);
  if (baseline.current === null && loaded) baseline.current = new Set(items.filter((i) => !streaming?.has(i.id)).map((i) => i.id));
  // Cada mensagem entra animada uma única vez (remontar ao mudar de lugar no turno não repete).
  const entered = useRef<Set<string>>(new Set());
  const headers = useMemo(() => speakerHeaders(items), [items]);
  const voices = useMemo(() => voicesByItem(items), [items]);
  const reveal = useMemo<RevealOf>(() => ({
    animate: (item) => !!streaming?.has(item.id) || (baseline.current !== null && isFresh(item, baseline.current, mountedAt)),
    live: (id) => working && !!streaming?.has(id),
    entering: (id) => {
      if (baseline.current === null || baseline.current.has(id) || entered.current.has(id)) return false;
      entered.current.add(id);
      return true;
    },
    agent: { id: agentId, label: agentLabel },
    voiceOf: (itemId) => voices.get(itemId) ?? { id: agentId, label: agentLabel },
    headers,
  }), [streaming, mountedAt, working, agentId, agentLabel, headers, voices]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const appliedSearchTokenRef = useRef<number | null>(null);
  const [appliedSearchToken, setAppliedSearchToken] = useState<number | null>(null);
  const findRequest = useChatStore((s) => s.timelineFind);
  const findSession = findRequest?.conversationKey === conversationKey ? findRequest : null;
  const findToken = findSession?.token ?? null;
  const [findQuery, setFindQuery] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const previousConversationKey = useRef(conversationKey);
  const findMatches = useMemo(
    () => findQuery.trim() ? searchTimelineItems(items, findQuery, items.length) : [],
    [items, findQuery],
  );
  const activeFindIndex = findMatches.length > 0 ? Math.min(findIndex, findMatches.length - 1) : 0;
  const activeFindId = findMatches[activeFindIndex]?.id ?? null;
  const highlightId = activeFindId ?? searchTargetId;
  // A pessoa está no fim e quer seguir o que chega. Só a rolagem dela muda isso (ver `onScroll`).
  const stick = useRef(true);
  // A rolagem suave que esta tela mandou ainda não foi interrompida pela pessoa (ver `onScroll`).
  const following = useRef(false);
  const lastTop = useRef(0);
  const lastTurns = useRef(0);
  const lastPending = useRef(0);
  useEffect(() => {
    if (findToken !== null) findInputRef.current?.focus();
  }, [findToken]);
  useEffect(() => {
    if (findToken === null) return;
    return () => clearTimelineFind(findToken);
  }, [findToken]);
  useEffect(() => {
    if (previousConversationKey.current === conversationKey) return;
    previousConversationKey.current = conversationKey;
    setFindQuery("");
    setFindIndex(0);
  }, [conversationKey]);
  useEffect(() => { setFindIndex(0); }, [findQuery]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Conta o que já foi visto mesmo quando a pessoa está lendo lá em cima: ao voltar ao fim, só o que chegou depois é novo.
    const grew = turns.length > lastTurns.current || pending.length > lastPending.current;
    lastTurns.current = turns.length;
    lastPending.current = pending.length;
    if (!stick.current) return;
    // Mensagem nova no fim: rola suave; texto que só cresce: acompanha sem animar.
    if (grew && loaded && !prefersReducedMotion() && typeof el.scrollTo === "function") {
      following.current = true;
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      following.current = false;
      el.scrollTop = el.scrollHeight;
    }
  }, [turns.length, pending.length, working, items, loaded]);
  // O texto que aparece aos poucos cresce sem redesenhar a lista: a rolagem acompanha o tamanho,
  // se a pessoa estava no fim.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!stick.current) return;
      following.current = false;
      el.scrollTop = el.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!searchTargetId || !loaded || searchTargetToken === null || searchTargetToken === undefined) return;
    if (appliedSearchTokenRef.current === searchTargetToken) return;
    const frame = window.requestAnimationFrame(() => {
      const target = contentRef.current?.querySelector<HTMLElement>(`[data-chat-item-id="${CSS.escape(searchTargetId)}"]`);
      if (!target) return;
      appliedSearchTokenRef.current = searchTargetToken;
      setAppliedSearchToken(searchTargetToken);
      stick.current = false;
      following.current = false;
      target.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [searchTargetId, searchTargetToken, loaded, turns, onSearchTargetApplied]);

  useEffect(() => {
    if (!searchTargetId || searchTargetToken === null || searchTargetToken === undefined || appliedSearchToken !== searchTargetToken) return;
    const timer = window.setTimeout(() => onSearchTargetApplied?.(searchTargetToken), 1800);
    return () => window.clearTimeout(timer);
  }, [searchTargetId, searchTargetToken, appliedSearchToken, onSearchTargetApplied]);

  useEffect(() => {
    if (findToken === null || !activeFindId || !loaded) return;
    const frame = window.requestAnimationFrame(() => {
      const target = contentRef.current?.querySelector<HTMLElement>(`[data-chat-item-id="${CSS.escape(activeFindId)}"]`);
      if (!target) return;
      stick.current = false;
      following.current = false;
      target.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [findToken, activeFindId, loaded, turns]);

  const stepFind = (delta: -1 | 1) => {
    if (findMatches.length === 0) return;
    setFindIndex((current) => (Math.min(current, findMatches.length - 1) + delta + findMatches.length) % findMatches.length);
  };
  const closeFind = () => {
    if (findSession) clearTimelineFind(findSession.token);
    setFindQuery("");
    setFindIndex(0);
  };

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 cc-scroll-hidden"
      onScroll={(e) => {
        const el = e.currentTarget;
        const top = el.scrollTop;
        const moved = top - lastTop.current;
        lastTop.current = top;
        // Enquanto a rolagem suave da própria tela desce, os eventos dela não decidem nada: com um texto alto chegando,
        // a distância do fim passa de STICK_PX no meio da animação (e ao chegar), e o fio deixava de seguir o que chega.
        if (following.current && moved >= 0) return;
        // Rolar para cima (a pessoa lendo) solta o fio; voltar ao fim, de novo.
        following.current = false;
        stick.current = el.scrollHeight - top - el.clientHeight < STICK_PX;
      }}>
      <RevealContext.Provider value={reveal}>
      <AnswerContext.Provider value={onAnswer ?? null}>
      <div ref={contentRef} style={bottomInset > 0 ? { paddingBottom: bottomInset } : undefined}
        className={`${width} mx-auto px-4 sm:px-6 pt-4 ${bottomInset > 0 ? "" : "pb-6"} flex flex-col gap-4 text-chat-prose text-gray-900 dark:text-white`}>
        {findSession && (
          <div className="sticky top-2 z-20 mx-auto flex w-full max-w-[560px] items-center gap-1.5 rounded-xl border border-gray-200 dark:border-white/10 bg-white/95 dark:bg-surface-raised/95 p-1.5 shadow-lg backdrop-blur">
            <SearchIcon className="ml-1 w-4 h-4 shrink-0 text-gray-400 dark:text-white/40" />
            <input ref={findInputRef} type="search" value={findQuery} onChange={(event) => setFindQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeFind(); }
                else if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); stepFind(event.shiftKey ? -1 : 1); }
              }}
              aria-label={t("chat.find.label")} placeholder={t("chat.find.placeholder")}
              className="min-w-0 flex-1 bg-transparent px-1 py-1 text-chat-ui text-gray-900 dark:text-white outline-none placeholder:text-gray-400 dark:placeholder:text-white/35" />
            <span aria-live="polite" className="min-w-[4.5rem] text-center text-chat-caption text-gray-500 dark:text-white/45">
              {!findQuery.trim() ? "" : !loaded ? t("chat.find.loading") : findMatches.length === 0 ? t("chat.find.noResults") : t("chat.find.position", { current: activeFindIndex + 1, total: findMatches.length })}
            </span>
            <button type="button" onClick={() => stepFind(-1)} disabled={!findMatches.length} aria-label={t("chat.find.previous")} title={t("chat.find.previous")}
              className="flex h-7 w-7 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 disabled:opacity-35 dark:text-white/55 dark:hover:bg-white/10">
              <ChevronDownIcon className="h-4 w-4 rotate-180" />
            </button>
            <button type="button" onClick={() => stepFind(1)} disabled={!findMatches.length} aria-label={t("chat.find.next")} title={t("chat.find.next")}
              className="flex h-7 w-7 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 disabled:opacity-35 dark:text-white/55 dark:hover:bg-white/10">
              <ChevronDownIcon className="h-4 w-4" />
            </button>
            <button type="button" onClick={closeFind} aria-label={t("chat.find.close")} title={t("chat.find.close")}
              className="flex h-7 w-7 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 dark:text-white/55 dark:hover:bg-white/10">
              <XIcon className="h-4 w-4" />
            </button>
          </div>
        )}
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
        {turns.map((turn, i) => turn.notice
          ? <NoticeRow key={turn.key} item={turn.notice} onResend={onResend} threadId={threadId} />
          : <TurnView key={turn.key} turn={turn} thinking={turn.key === thinkingKey} latest={i === turns.length - 1} onOpenTerminal={onOpenTerminal} searchTargetId={highlightId} composerTarget={quoteKey} quietWhenEmpty={toolVisibility === "zen"} />)}
        {pending.map((p) => { const shown = displayUserText(p.text); return shown ? <PersonBubble key={p.id} text={shown} sending queued={working} composerTarget={quoteKey} /> : null; })}
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
      </AnswerContext.Provider>
      </RevealContext.Provider>
      {quoteKey && <SelectionComment container={() => scrollRef.current} quoteKey={quoteKey} />}
    </div>
  );
}

function TurnView({ turn, thinking = false, latest, onOpenTerminal, searchTargetId, composerTarget, quietWhenEmpty = false }: { turn: Turn; /** O modelo ainda está pensando neste turno: o «Pensando…» com brilho vai depois das linhas. */ thinking?: boolean; latest: boolean; onOpenTerminal?: () => void; searchTargetId?: string | null; composerTarget?: string; quietWhenEmpty?: boolean }) {
  const { t } = useTranslation();
  // Os turnos antigos começam recolhidos; o último (ou o em aberto), aberto. O raciocínio de turno encerrado só volta
  // quando a pessoa abre o log pelo cabeçalho (`full`), como no T3.
  const containsSearchTarget = !!searchTargetId && (turn.user?.id === searchTargetId || turn.final?.id === searchTargetId || turn.planItemId === searchTargetId || turn.body.some((row) => (row.type === "assistant" || row.type === "reasoning") && row.item.id === searchTargetId));
  const [open, setOpen] = useState(latest || turn.end === null || containsSearchTarget);
  const [full, setFull] = useState(containsSearchTarget);
  useEffect(() => { if (containsSearchTarget) { setOpen(true); setFull(true); } }, [containsSearchTarget]);
  const foldable = turn.end !== null && turn.body.length > 0;
  // No zen, um turno cujas ferramentas foram todas ocultas e que acabou bem não mostra o cabeçalho "Trabalhou por …".
  const quiet = quietWhenEmpty && turn.body.length === 0 && turn.end !== null && !turn.end.superseded && endOutcome(turn.end) === "done";
  return (
    <>
      {turn.user && <UserMessage item={turn.user} searchHit={turn.user.id === searchTargetId} composerTarget={composerTarget} />}
      {turn.plan && (turn.end === null || turn.planItemId === searchTargetId) &&
        <PlanCard plan={turn.plan} itemId={turn.planItemId ?? undefined} searchHit={turn.planItemId === searchTargetId} />}
      {turn.end && !quiet && (
        <button type="button" onClick={() => { if (!foldable) return; setOpen(!open); setFull(!open); }} aria-expanded={foldable ? open : undefined}
          className={`flex items-center gap-1.5 pb-2 border-b border-gray-200 dark:border-white/[0.08] text-left text-chat-ui text-gray-500 dark:text-white/45
            ${foldable ? "hover:text-gray-800 dark:hover:text-white/75" : "cursor-default"}`}>
          {turn.end.superseded
            ? t("chat.timeline.continued")
            : endOutcome(turn.end) === "error"
            ? t("chat.timeline.notDone")
            : endOutcome(turn.end) === "interrupted"
            ? t("chat.timeline.interruptedByYou")
            : turn.end.durationMs !== null
              ? t("chat.timeline.workedFor", { duration: formatDuration(turn.end.durationMs) })
              : t("chat.timeline.done")}
          {foldable && <ChevronDownIcon className={`w-3.5 h-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />}
        </button>
      )}
      {visibleTurnBody(turn, open, full).map((row) => (
        <BodyRowView key={row.key} row={row} onOpenTerminal={onOpenTerminal} active={turn.end === null && row.key === turn.body[turn.body.length - 1]?.key} searchTargetId={searchTargetId} />
      ))}
      {thinking && <ThinkingRow />}
      {turn.final && <AgentText item={turn.final} searchHit={turn.final.id === searchTargetId} />}
      {turn.end && <TurnEndNotice end={turn.end} />}
      {turn.end && turn.end.files.length > 0 && <div><ChangedFilesCard files={turn.end.files} /></div>}
    </>
  );
}

/**
 * A "mensagem da pessoa" de um turno. Se ela é, na verdade, de outro agente (`ags peer tell/ask`
 * cai no terminal como mensagem do usuário), mostra só o corpo, no balão do remetente e com o logo
 * dele; o envelope de segurança continua indo ao modelo, só a tela o esconde (`peerEnvelope.ts`).
 */
function UserMessage({ item, searchHit = false, composerTarget }: { item: TimelineItem; searchHit?: boolean; composerTarget?: string }) {
  const reveal = useContext(RevealContext);
  const text = item.text ?? "";
  const peer = useMemo(() => parsePeerEnvelope(text), [text]);
  const [entering] = useState(() => !!peer && reveal.entering(item.id));
  if (!peer) return <PersonBubble text={text} at={item.at} itemId={item.id} searchHit={searchHit} composerTarget={composerTarget} />;
  return (
    <AgentBubble agentId="" command={senderAgent(peer.sender)} label={peer.sender} sender={peer.sender} receipt={peer.id} header={reveal.headers.has(item.id)} entering={entering} at={item.at} copyText={peer.body} itemId={item.id} searchHit={searchHit}>
      <Markdown content={peer.body} tone="chat" renderCodeBlock={renderChatCodeBlock} />
    </AgentBubble>
  );
}

/**
 * Uma fala do agente em markdown. A que chegou agora aparece palavra a palavra; enquanto o texto
 * ainda chega (ou ainda está aparecendo), um cursor discreto fica no fim (`cc-stream-caret`).
 */
function AgentText({ item, searchHit = false }: { item: TimelineItem; searchHit?: boolean }) {
  const reveal = useContext(RevealContext);
  const { text, revealing } = useRevealedText(item.id, item.text ?? "", reveal.animate(item));
  const caret = revealing || reveal.live(item.id);
  const [entering] = useState(() => reveal.entering(item.id));
  return (
    <AgentBubble agentId={reveal.voiceOf(item.id).id} label={reveal.voiceOf(item.id).label} header={reveal.headers.has(item.id)} entering={entering} caret={caret} at={item.at} copyText={item.text ?? ""} itemId={item.id} searchHit={searchHit}>
      <Markdown content={text} tone="chat" renderCodeBlock={renderChatCodeBlock} />
    </AgentBubble>
  );
}

/** `active`: a última linha do turno em aberto (o agente ainda está trabalhando nela). */
function BodyRowView({ row, onOpenTerminal, active = false, searchTargetId }: { row: BodyRow; onOpenTerminal?: () => void; active?: boolean; searchTargetId?: string | null }) {
  const { t } = useTranslation();
  const answer = useContext(AnswerContext);
  switch (row.type) {
    case "assistant":
      return <AgentText item={row.item} searchHit={row.item.id === searchTargetId} />;
    case "reasoning":
      return <ReasoningRow item={row.item} />;
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
                <li key={o}>
                  {/* A pergunta em aberto (a última linha do turno em andamento) responde ao clique; as já respondidas ficam só como registro. */}
                  {active && answer ? (
                    <button type="button" onClick={() => answer(o)}
                      className="px-2.5 py-1 rounded-md bg-white dark:bg-white/[0.06] border border-gray-200 dark:border-white/10 text-chat-note text-gray-900 dark:text-white hover:bg-gray-100 dark:hover:bg-white/[0.12] focus-visible:ring-2 focus-visible:ring-accent-500/50">
                      {o}
                    </button>
                  ) : (
                    <span className="block px-2.5 py-1 rounded-md bg-white dark:bg-white/[0.06] border border-gray-200 dark:border-white/10 text-chat-note text-gray-500 dark:text-white/55">{o}</span>
                  )}
                </li>
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

/** O resumo do raciocínio sem a marcação do markdown (os títulos em `**…**` do Codex) e numa linha só. */
function flatThought(text: string): string {
  return text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

/** Acima disso (ou com mais de um parágrafo) o resumo abre e fecha ao clicar; antes, cabe inteiro nas linhas. */
const THOUGHT_CLAMP_CHARS = 240;

/**
 * O resumo do pensamento do agente, em cinza, com o ícone de cérebro (como o T3 Code). Recolhido mostra até 3 linhas;
 * o clique abre o texto inteiro, em markdown. Chega aos poucos enquanto o agente pensa (o rascunho cresce no lugar).
 */
function ReasoningRow({ item }: { item: TimelineItem }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const text = (item.text ?? "").trim();
  const flat = flatThought(text);
  const expandable = flat.length > THOUGHT_CLAMP_CHARS || /\n\s*\n/.test(text);
  const body = (
    <>
      <BrainIcon className="mt-[3px] w-4 h-4 shrink-0 text-gray-400 dark:text-white/40" />
      {open
        ? <div className="min-w-0 flex-1 text-chat-ui text-gray-500 dark:text-white/50"><Markdown content={text} tone="chat" renderCodeBlock={renderChatCodeBlock} /></div>
        : <span className="min-w-0 flex-1 line-clamp-4 text-left text-chat-ui text-gray-500 dark:text-white/50">{flat}</span>}
      {expandable && <ChevronRightIcon className={`mt-[3px] w-3.5 h-3.5 shrink-0 text-gray-300 dark:text-white/25 transition-transform ${open ? "rotate-90" : ""}`} />}
    </>
  );
  return (
    <div data-reasoning data-chat-item-id={item.id} role="note" aria-label={t("chat.timeline.reasoning")} className="flex flex-col">
      {expandable
        ? <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-start gap-2.5 min-h-[26px] w-full text-left hover:text-gray-700 dark:hover:text-white/70">{body}</button>
        : <div className="flex items-start gap-2.5 min-h-[26px]">{body}</div>}
    </div>
  );
}

/** «Pensando…» com o brilho passando, enquanto o modelo ainda pensa (o `cc-shimmer` para com `prefers-reduced-motion`). */
function ThinkingRow() {
  const { t } = useTranslation();
  return (
    <div data-thinking className="flex items-center gap-2.5 min-h-[26px] text-chat-ui">
      <BrainIcon className="w-4 h-4 shrink-0 text-gray-400 dark:text-white/40" />
      <span className="cc-shimmer">{t("chat.live.thinking")}</span>
    </div>
  );
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
        className="flex min-w-0 items-center gap-2.5 min-h-[26px] whitespace-nowrap text-left text-chat-ui text-gray-600 dark:text-white/60 hover:text-gray-900 dark:hover:text-white/85">
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
        className="flex min-w-0 items-center gap-2.5 min-h-[26px] whitespace-nowrap text-left text-chat-ui text-gray-500 dark:text-white/45 hover:text-gray-800 dark:hover:text-white/75">
        <TerminalIcon className="w-4 h-4 shrink-0 text-gray-400 dark:text-white/40" />
        <span>{t("chat.tool.infra", { count: tools.length })}</span>
        <ChevronRightIcon className={`w-3.5 h-3.5 shrink-0 text-gray-300 dark:text-white/25 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && <div className="ml-[26px] flex flex-col">{tools.map((tool) => <ToolRow key={tool.id} tool={tool} />)}</div>}
    </div>
  );
}

export function ToolRow({ tool }: { tool: TimelineItem }) {
  const { t } = useTranslation();
  const unknownOutcome = isUnknownOutcome(tool);
  const [open, setOpen] = useState(false);
  const kind = tool.tool ?? "other";
  const Icon = TOOL_ICON[kind];
  // O comando aparece sem o invólucro do shell e numa linha só (programa em destaque); o inteiro
  // fica no tooltip e no conteúdo expandido.
  const command = kind === "command" ? commandTitle(tool.label ?? "") : null;
  const target = command ? "" : kind === "todo" ? t("chat.tool.todoCount", { count: Number(tool.label ?? 0) }) : tool.path ? fileName(tool.path) : tool.label ?? "";
  const longCommand = !!command && (command.script || command.full.includes("\n") || command.full.length > 90);
  const app = useMemo(() => appResourceOf(tool), [tool.appResource, tool.output]);
  const canOpen = (!!tool.output && !app) || longCommand || unknownOutcome;
  return (
    <div className="flex flex-col">
      <button type="button" onClick={() => canOpen && setOpen(!open)} aria-expanded={canOpen ? open : undefined}
        title={command?.full || tool.path || tool.label}
        className={`group flex min-w-0 items-center gap-2.5 min-h-[26px] whitespace-nowrap text-left text-chat-ui text-gray-600 dark:text-white/60 ${canOpen ? "cursor-pointer hover:text-gray-900 dark:hover:text-white/85" : "cursor-default"}`}>
        <Icon className={`w-4 h-4 shrink-0 ${
          unknownOutcome
            ? "text-amber-500 dark:text-amber-400"
            : tool.status === "error" || tool.status === "denied"
            ? "text-red-500 dark:text-red-400"
            : "text-gray-400 dark:text-white/40"
        }`} />
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
        {unknownOutcome ? (
          <span role="status" aria-label={t("chat.tool.outcomeUnknown")} className="shrink-0 text-chat-caption text-amber-600 dark:text-amber-400 font-medium">
            {t("chat.tool.outcomeUnknown")}
          </span>
        ) : (
          <>
            {tool.status === "error" && <span className="shrink-0 text-chat-caption text-red-600 dark:text-red-400">{t("chat.tool.failed")}</span>}
            {tool.status === "denied" && <span className="shrink-0 text-chat-caption text-red-600 dark:text-red-400">{t("chat.tool.denied")}</span>}
          </>
        )}
        {canOpen && <ChevronRightIcon className={`w-3.5 h-3.5 shrink-0 text-gray-300 dark:text-white/25 transition-transform ${open ? "rotate-90" : ""}`} />}
      </button>
      {open && command && longCommand && (
        <pre className="m-0 ml-[26px] mt-1 max-h-48 overflow-auto cc-no-bar rounded-lg px-3 py-2 font-mono text-chat-code leading-snug whitespace-pre-wrap break-words
          bg-gray-50 dark:bg-white/[0.04] border border-gray-200 dark:border-white/[0.08] text-gray-800 dark:text-white/80">
          {command.full}
        </pre>
      )}
      {open && unknownOutcome && (
        <div role="status" aria-label={t("chat.tool.outcomeUnknown")}
          className="m-0 ml-[26px] mt-1 mb-2 rounded-lg px-3 py-2 text-chat-note leading-snug
          bg-amber-500/10 border border-amber-500/20 text-amber-900 dark:text-amber-200">
          <p className="m-0 font-medium">{t("chat.tool.outcomeUnknown")}</p>
          <p className="m-0 mt-0.5 text-gray-700 dark:text-white/70">
            {t("chat.tool.outcomeUnknownHelp")}
          </p>
        </div>
      )}
      {app && (
        <div className="ml-[26px] mt-1 mb-2 overflow-hidden rounded-lg border border-gray-200 dark:border-white/[0.08]">
          <McpAppFrame html={app.html} server={mcpAppServerOf(tool.name, app.uri)} />
        </div>
      )}
      {open && tool.output && !app && (
        <pre className="m-0 ml-[26px] mt-1 mb-2 max-h-72 overflow-auto cc-no-bar rounded-lg px-3 py-2 font-mono text-chat-code leading-snug whitespace-pre-wrap break-words
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
