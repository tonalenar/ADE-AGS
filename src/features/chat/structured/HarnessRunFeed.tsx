import { formatClock, type TimeFormat } from "@/shared/timeFormat";
import { useDisplayPrefs } from "@/features/settings/displayPreferences";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";

import { selectConversation } from "@/features/chat/unified/selectionActions";
import { readAttemptEvents } from "@/features/runs/ipc";
import type {
  AgentEvent,
  HarnessExecutionEvent,
  HarnessExecutionNode,
  HarnessNodeResult,
  HarnessTreeChanged,
} from "@/features/runs/types";

import { BotIcon, ChevronRightIcon } from "../chatIcons";
import { chatThreadRequests, chatThreadStatus, type ThreadRow } from "./ipc";
import {
  buildTreeRows,
  consolidateEvents,
  dataState,
  defaultExpanded,
  eventPhases,
  finalState,
  treeKey,
  visibleRows,
  type EventPhase,
  type TreeRow,
} from "./harnessTreeModel";
import { threadKey } from "./model";
import { useStructured } from "./store";
import { useHarnessGraph } from "./useHarnessGraph";

const ACTIVE = new Set(["pending", "ready", "running"]);
/** O que o contrato §3.1 ainda não trata como fim, mais o `inProgress` nativo do turno. O resto é terminal. */
const TURN_OPEN = new Set(["inProgress", "pending", "running", "waiting", "ready"]);
/** Limite da entrega do filho, o mesmo que a projeção aplica (contrato §12.x). */
const RESULT_MAX_CHARS = 500;

interface ChildSnapshot {
  working: boolean;
  pending: number;
}

interface LineageChat {
  thread: ThreadRow;
  depth: number;
}

function descendants(rootId: string, threads: ThreadRow[]): LineageChat[] {
  const children = new Map<string, ThreadRow[]>();
  for (const thread of threads) {
    if (!thread.isSideChat || !thread.parentRef?.startsWith("thread:")) continue;
    const parentId = thread.parentRef.slice("thread:".length);
    children.set(parentId, [...(children.get(parentId) ?? []), thread]);
  }
  for (const rows of children.values()) rows.sort((a, b) => b.updatedAt - a.updatedAt);

  const result: LineageChat[] = [];
  const visit = (parentId: string, depth: number, path: Set<string>) => {
    for (const thread of children.get(parentId) ?? []) {
      if (path.has(thread.id)) continue;
      result.push({ thread, depth });
      const nextPath = new Set(path);
      nextPath.add(thread.id);
      visit(thread.id, depth + 1, nextPath);
    }
  };
  visit(rootId, 0, new Set([rootId]));
  return result;
}

/** Rótulo do estado. Conversa filha sem live store cai no estado de execução da projeção, não no `thread.state`. */
function graphStatusKey(node: HarnessExecutionNode, childStatus?: string): string {
  if (node.kind === "thread") {
    if (childStatus) return `chat.harness.childStatus.${childStatus}`;
    return node.executionStatus ? `chat.harness.status.${node.executionStatus}` : "chat.harness.childStatus.idle";
  }
  if (node.kind === "turn") return `chat.harness.turnStatus.${node.status}`;
  return `chat.harness.status.${node.executionStatus ?? node.status}`;
}

/** Filhos ainda vivos de um turno que já acabou. O ponto de status continua o do próprio turno. */
function turnActiveChildren(node: HarnessExecutionNode): number {
  if (node.kind !== "turn" || TURN_OPEN.has(node.status)) return 0;
  return Math.max(0, node.activeChildren ?? 0);
}

function nodeColor(node: HarnessExecutionNode, childStatus?: string): string {
  const status = childStatus ?? node.executionStatus ?? node.status;
  if (node.outcomeUnknown) return "bg-amber-500";
  if (status === "waiting" || status === "pending" || status === "ready") return "bg-amber-500";
  if (status === "interrupted") return "bg-amber-500";
  if (status === "working" || status === "running" || status === "inProgress") return "bg-emerald-500";
  if (status === "failed") return "bg-red-500";
  if (status === "done" || status === "completed" || status === "settled") return "bg-gray-400";
  return "bg-gray-300 dark:bg-white/25";
}

/** Hora curta de um evento ou nó. */
const clock = (ms: number, format: TimeFormat) => formatClock(ms, format, undefined);

/** Árvore comum do harness: threads, turnos estruturados e tarefas headless da Frota. */
export function HarnessRunFeed({ threadId }: { threadId: string }) {
  const timeFormat = useDisplayPrefs().timeFormat;
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [childSnapshots, setChildSnapshots] = useState<Record<string, ChildSnapshot>>({});
  const [open, setOpen] = useState(false);
  /** O que a pessoa abriu ou fechou. Nó fora daqui segue o padrão (`defaultExpanded`). */
  const [toggles, setToggles] = useState<Record<string, boolean>>({});
  const [focusId, setFocusId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [activityOpen, setActivityOpen] = useState(false);
  const [attemptEvents, setAttemptEvents] = useState<Record<string, AgentEvent[]>>({});
  const [loadingAttempts, setLoadingAttempts] = useState<Record<string, boolean>>({});
  const treeRef = useRef<HTMLDivElement | null>(null);
  const threads = useStructured((state) => state.threads);
  const live = useStructured((state) => state.live);
  const lineageChats = useMemo(() => descendants(threadId, threads), [threadId, threads]);
  const lineageKey = lineageChats.map(({ thread }) => thread.id).sort().join("|");

  // O escopo do que importa ao painel muda com a árvore; o hook lê pela referência, sem reassinar os avisos.
  const scopeRef = useRef<{ threadIds: Set<string>; taskIds: Set<string> }>({ threadIds: new Set([threadId]), taskIds: new Set() });
  const graph = useHarnessGraph(threadId, () => scopeRef.current);
  const graphNodes = useMemo(() => graph?.nodes ?? [], [graph]);
  const graphEvents = useMemo(() => graph?.events ?? [], [graph]);
  scopeRef.current = {
    threadIds: new Set([
      threadId,
      ...graphNodes.filter((node) => node.kind === "thread").flatMap((node) => (node.threadId ? [node.threadId] : [])),
      ...lineageChats.map(({ thread }) => thread.id),
    ]),
    taskIds: new Set(graphNodes.filter((node) => node.kind === "fleetTask").map((node) => node.id.replace(/^task:/, ""))),
  };

  const toggleAttempt = (id: string) => {
    if (attemptEvents[id] || loadingAttempts[id]) return;
    setLoadingAttempts((current) => ({ ...current, [id]: true }));
    void readAttemptEvents(id.replace(/^attempt:/, "")).then((events) => {
      setAttemptEvents((current) => ({ ...current, [id]: events }));
    }).catch(() => {
      setAttemptEvents((current) => ({ ...current, [id]: [] }));
    }).finally(() => {
      setLoadingAttempts((current) => ({ ...current, [id]: false }));
    });
  };

  // Status vivo das conversas filhas que a store ainda não acompanha. Muda com o aviso de evento persistido
  // (com cursor), nunca com cada trecho de texto que chega.
  useEffect(() => {
    const childIds = new Set(lineageChats.map(({ thread }) => thread.id));
    if (childIds.size === 0) {
      setChildSnapshots({});
      return;
    }
    let alive = true;
    const cursors = new Map<string, number>();
    const refresh = (id: string) => {
      void Promise.all([chatThreadStatus(id), chatThreadRequests(id)]).then(([status, requests]) => {
        if (alive) setChildSnapshots((current) => ({
          ...current,
          [id]: { working: status.working, pending: requests.length },
        }));
      }).catch(() => undefined);
    };
    childIds.forEach(refresh);
    const unlisten = listen<HarnessTreeChanged>("cc-harness-event", (event) => {
      const change = event.payload;
      if (!change || typeof change.threadId !== "string" || !childIds.has(change.threadId)) return;
      if (typeof change.cursor === "number") {
        if ((cursors.get(change.threadId) ?? -1) >= change.cursor) return;
        cursors.set(change.threadId, change.cursor);
      }
      if (useStructured.getState().live[change.threadId]) return;
      refresh(change.threadId);
    });
    return () => {
      alive = false;
      unlisten.then((off) => off()).catch(() => undefined);
    };
  }, [lineageKey]);

  const tasks = graphNodes.filter((node) => node.kind === "fleetTask");
  const childCount = lineageChats.length;
  const activeCount = tasks.filter((node) => ACTIVE.has(node.status)).length
    + lineageChats.filter(({ thread }) => live[thread.id]?.phase === "working" || childSnapshots[thread.id]?.working).length;
  // Quem espera a pessoa, uma vez por nó: a conversa viva (store) e a projeção podem apontar o mesmo filho.
  const attentionCount = useMemo(() => new Set<string>([
    ...lineageChats.filter(({ thread }) => Math.max(
      childSnapshots[thread.id]?.pending ?? 0,
      live[thread.id]?.requests.filter((request) => request.state === "pending").length ?? 0,
    ) > 0).map(({ thread }) => `thread:${thread.id}`),
    ...graphNodes.filter((node) => node.blocked).map((node) => node.id),
  ]).size, [childSnapshots, graphNodes, lineageChats, live]);

  const rows = useMemo(() => buildTreeRows(graphNodes, threadId), [graphNodes, threadId]);
  const expandedOf = (row: TreeRow) => toggles[row.node.id] ?? defaultExpanded(row.node);
  const visible = visibleRows(rows, expandedOf);
  const activeId = focusId && visible.some((row) => row.node.id === focusId) ? focusId : visible[0]?.node.id;
  const nodeById = useMemo(() => new Map(graphNodes.map((node) => [node.id, node])), [graphNodes]);
  const phases = useMemo(() => eventPhases(graphEvents), [graphEvents]);
  const eventGroups = useMemo(() => {
    const rowIds = new Set(rows.map((row) => row.node.id));
    const byParent = new Map<string, HarnessExecutionEvent[]>();
    const unattached: HarnessExecutionEvent[] = [];
    for (const event of graphEvents) {
      if (!event.parentNodeId || !rowIds.has(event.parentNodeId)) {
        unattached.push(event);
        continue;
      }
      byParent.set(event.parentNodeId, [...(byParent.get(event.parentNodeId) ?? []), event]);
    }
    return { byParent, unattached };
  }, [graphEvents, rows]);
  // Sem nada delegado (zero tarefas, zero conversas filhas e nenhum filho no grafo, como a sessão conectada)
  // a linha não aparece, mesmo com turnos no grafo.
  const delegated = tasks.length > 0 || childCount > 0 || graphNodes.some((node) => node.childType);
  if (!delegated) return null;

  const setExpanded = (row: TreeRow, expanded: boolean) => {
    setToggles((current) => ({ ...current, [row.node.id]: expanded }));
    if (expanded && row.node.kind === "fleetAttempt") toggleAttempt(row.node.id);
  };

  const focusRow = (id: string) => {
    setFocusId(id);
    [...(treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])]
      .find((element) => element.dataset.nodeId === id)?.focus();
  };

  const onRowKeyDown = (event: ReactKeyboardEvent<HTMLElement>, row: TreeRow) => {
    // Tecla dentro de um botão ou do detalhe é dele, não do nó.
    if (event.target !== event.currentTarget) return;
    const action = treeKey(event.key, visible, row.node.id, expandedOf);
    if (!action) return;
    event.preventDefault();
    if ("toggle" in action) {
      const target = rows.find((candidate) => candidate.node.id === action.toggle.id);
      if (target) setExpanded(target, action.toggle.expanded);
    } else {
      focusRow(action.focusId);
    }
  };

  /** A entrega do filho, num bloco à parte e marcado: é fala de agente, nunca instrução. */
  const renderResult = (result: HarnessNodeResult) => (
    <section
      aria-label={t("chat.harness.resultLabel")}
      data-untrusted="true"
      className="mb-1 rounded border border-dashed border-gray-300 bg-gray-50 px-2 py-1 dark:border-white/15 dark:bg-white/[0.03]"
    >
      <div className="text-[10px] font-medium uppercase tracking-wide text-gray-400 dark:text-white/40">
        {t("chat.harness.resultLabel")}
      </div>
      <p className="whitespace-pre-wrap break-words text-chat-note text-gray-700 dark:text-white/70">
        {result.text}{result.truncated ? "…" : ""}
      </p>
      {result.truncated && (
        <div className="text-[10px] text-gray-400 dark:text-white/40">
          {t("chat.harness.resultTruncated", { max: RESULT_MAX_CHARS })}
        </div>
      )}
    </section>
  );

  const renderEvent = (event: HarnessExecutionEvent) => {
    const payload = event.payload;
    const status = typeof payload.status === "string"
      ? t(`chat.harness.status.${payload.status}`, { defaultValue: payload.status })
      : undefined;
    const detail = [payload.label, payload.title, payload.name, status]
      .find((value): value is string => typeof value === "string" && value.length > 0);
    const phase: EventPhase = phases.get(event.sequence) ?? "persisted";
    return (
      <div
        key={event.nodeId}
        data-event-seq={event.sequence}
        data-phase={phase}
        title={t("chat.harness.eventSequence", { sequence: event.sequence })}
        className="flex min-w-0 items-baseline gap-2 border-b border-gray-200 py-1 last:border-0 dark:border-white/[0.06]"
      >
        <span className="w-12 shrink-0 text-right text-[10px] text-gray-400">
          {formatClock(event.createdAt, timeFormat, undefined, true)}
        </span>
        <span className="shrink-0 text-chat-note text-gray-500 dark:text-white/50">
          {t(`chat.harness.semantic.${event.kind}`, { defaultValue: event.kind })}
        </span>
        {detail && <span className="min-w-0 truncate text-chat-note text-gray-700 dark:text-white/70" title={detail}>{detail}</span>}
        <span className={`ml-auto shrink-0 text-[10px] ${phase === "inProgress" ? "text-emerald-600 dark:text-emerald-400" : "text-gray-400 dark:text-white/35"}`}>
          {t(`chat.harness.eventPhase.${phase}`)}
        </span>
      </div>
    );
  };

  /** Os eventos de um nó: marcos sozinhos e a rotina num resumo; o texto de cada um só sob pedido. */
  const renderEvents = (key: string, events: HarnessExecutionEvent[]) => {
    if (events.length === 0) return null;
    const all = showAll[key] === true;
    return (
      <div className="mt-1">
        {all
          ? events.map((event) => renderEvent(event))
          : consolidateEvents(events).map((entry) => entry.type === "milestone"
            ? renderEvent(entry.event)
            : (
              <div key={`digest:${entry.fromSequence}`} data-digest={entry.count} className="flex min-w-0 items-baseline gap-2 border-b border-gray-200 py-1 text-chat-note text-gray-500 last:border-0 dark:border-white/[0.06] dark:text-white/50">
                <span className="w-12 shrink-0" />
                <span>{t("chat.harness.digest", { count: entry.count })}</span>
                <span className="text-gray-400 dark:text-white/35">{t("chat.harness.digestBreakdown", { tools: entry.tools, messages: entry.messages })}</span>
              </div>
            ))}
        <button
          type="button"
          onClick={() => setShowAll((current) => ({ ...current, [key]: !all }))}
          className="mt-1 text-[10px] text-gray-500 underline-offset-2 hover:underline dark:text-white/45"
        >
          {all ? t("chat.harness.showSummary") : t("chat.harness.showAllEvents")}
        </button>
      </div>
    );
  };

  const renderAttemptLog = (id: string) => (
    <div className="mt-1 max-h-56 overflow-auto rounded bg-gray-50 px-2 py-1 dark:bg-white/[0.035]">
      {loadingAttempts[id] ? <div className="text-chat-note text-gray-400">{t("chat.harness.eventsLoading")}</div>
        : (attemptEvents[id] ?? []).length === 0 ? <div className="text-chat-note text-gray-400">{t("chat.harness.eventsEmpty")}</div>
          : (attemptEvents[id] ?? []).map((event, index) => {
            const kind = event.kind === "text" ? "output" : event.kind;
            const detail = event.kind === "text" ? event.text
              : event.kind === "tool" ? event.label
                : event.kind === "started" ? t("chat.harness.eventStarted")
                  : event.outcome.error || event.outcome.result || t("chat.harness.eventFinished");
            return <div key={`${id}:${index}`} className="flex gap-2 border-b border-gray-200 py-1 last:border-0 dark:border-white/[0.06]">
              <span className="shrink-0 text-gray-400">{t(`chat.harness.event.${kind}`)}</span>
              <span className="min-w-0 whitespace-pre-wrap break-words text-gray-600 dark:text-white/60">{detail}</span>
            </div>;
          })}
    </div>
  );

  /** O detalhe só existe no DOM com o nó aberto: o resumo da árvore não carrega texto de evento. */
  const renderDetail = (node: HarnessExecutionNode, finalLabel: string | null) => {
    const events = eventGroups.byParent.get(node.id) ?? [];
    return (
      <div
        data-detail={node.id}
        className="mb-1 flex flex-col gap-1 border-l border-gray-200 pl-2 text-chat-note text-gray-600 dark:border-white/10 dark:text-white/60"
        style={{ marginLeft: `${Math.min(node.depth, 5) * 12 + 18}px` }}
      >
        {finalLabel !== null
          ? <div className="font-medium text-gray-700 dark:text-white/75">{t("chat.harness.detail.finalState", { state: finalLabel })}</div>
          : <div>{t("chat.harness.detail.running", { time: clock(node.startedAt ?? node.createdAt, timeFormat) })}</div>}
        {node.interruptionReason && <div>{t("chat.harness.detail.interruption", { reason: node.interruptionReason })}</div>}
        {node.outcomeUnknown && <div className="text-amber-700 dark:text-amber-400">{t("chat.harness.detail.unknownHint")}</div>}
        {node.result && renderResult(node.result)}
        {node.kind === "fleetAttempt" && renderAttemptLog(node.id)}
        {renderEvents(node.id, events)}
        {events.length === 0 && node.kind !== "fleetAttempt" && !node.result && !node.interruptionReason && (
          <div className="text-gray-400 dark:text-white/40">{t("chat.harness.detail.empty")}</div>
        )}
      </div>
    );
  };

  const renderRow = (row: TreeRow) => {
    const { node } = row;
    const child = node.kind === "thread"
      ? lineageChats.find(({ thread }) => thread.id === node.threadId)?.thread
      : undefined;
    const pending = child ? Math.max(
      childSnapshots[child.id]?.pending ?? 0,
      live[child.id]?.requests.filter((request) => request.state === "pending").length ?? 0,
    ) : 0;
    const working = child && (live[child.id]?.phase === "working" || childSnapshots[child.id]?.working === true);
    const failed = child && Boolean(live[child.id]?.error);
    const childStatus = child
      ? pending > 0 ? "waiting" : working ? "working" : child.state === "settled" ? "settled" : failed ? "failed" : "idle"
      : undefined;
    const statusLabel = t(graphStatusKey(node, childStatus), { defaultValue: childStatus ?? node.executionStatus ?? node.status });
    const activeChildren = turnActiveChildren(node);
    const blockedChildren = node.blockedChildren ?? 0;
    // O bloqueio que a projeção conhece (pergunta ou aprovação, com o tipo); a conversa viva, sem tipo, diz só "aguardando você".
    const blockedLabel = node.blocked
      ? t(`chat.harness.blocked.${node.blocked.kind}`)
      : pending > 0 ? t("chat.harness.childStatus.waiting") : null;
    const label = node.kind === "turn"
      ? `${t("chat.harness.turnTitle")} · ${clock(node.createdAt, timeFormat)}`
      : node.kind === "fleetAttempt"
        ? t("chat.harness.attemptTitle", { count: node.attempt ?? 1 })
        : node.kind === "fleetTask" ? node.planKey || node.title : node.title;
    const attempts = row.childIds.filter((id) => nodeById.get(id)?.kind === "fleetAttempt").length;
    const origin = node.origin;
    const expanded = expandedOf(row);
    const state = dataState(node, childStatus);
    const final = finalState(node, childStatus);
    const finalLabel = final === "unknown" ? t("chat.harness.outcomeUnknown") : final ? t(`chat.harness.status.${final}`, { defaultValue: final }) : null;
    // A conversa filha abre por um botão próprio; a tarefa da Frota só é um alvo quando bloqueada (a aprovação se responde na tela da Frota).
    const openConversation = node.kind === "thread" && node.threadId ? node.threadId : null;
    const openFleet = node.kind === "fleetTask" && node.blocked;
    const blockedRow = blockedLabel ? " bg-amber-50 dark:bg-amber-500/10" : "";
    return (
      <div
        key={node.id}
        role="treeitem"
        aria-level={row.level}
        aria-expanded={expanded}
        data-node-id={node.id}
        data-state={state}
        tabIndex={node.id === activeId ? 0 : -1}
        onFocus={(event) => { if (event.target === event.currentTarget) setFocusId(node.id); }}
        onKeyDown={(event) => onRowKeyDown(event, row)}
        className="rounded outline-none focus-visible:ring-1 focus-visible:ring-accent-500"
      >
        <div
          onClick={() => setExpanded(row, !expanded)}
          className={`flex min-w-0 cursor-pointer items-center gap-2 min-h-[24px] rounded px-1 -mx-1 text-chat-note hover:bg-gray-100 dark:hover:bg-white/[0.06]${blockedRow}`}
          style={{ marginLeft: `${Math.min(node.depth, 5) * 12}px` }}
        >
          <ChevronRightIcon aria-hidden="true" className={`w-3 h-3 shrink-0 text-gray-400 transition-transform ${expanded ? "rotate-90" : ""}`} />
          <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${nodeColor(node, childStatus)}`} />
          <span className="min-w-0 flex-1 truncate text-gray-800 dark:text-white/85" title={node.title}>{label}</span>
          {node.childType && <span className="shrink-0 text-gray-400 dark:text-white/40">{t(`chat.harness.childType.${node.childType}`)}</span>}
          {node.agentId && <span className="shrink-0 max-w-[8rem] truncate text-gray-400 dark:text-white/35">{node.agentId}{node.model ? ` · ${node.model}` : ""}</span>}
          <span className="shrink-0 text-gray-500 dark:text-white/45">{statusLabel}</span>
          {node.outcomeUnknown && <span className="shrink-0 font-medium text-amber-700 dark:text-amber-400">{t("chat.harness.outcomeUnknown")}</span>}
          {attempts > 0 && <span className="shrink-0 text-gray-500 dark:text-white/45">{t("chat.harness.attemptsCount", { count: attempts })}</span>}
          {origin && <span className="shrink-0 text-gray-400 dark:text-white/35">{t(`chat.harness.origin.${origin.createdBy}`)}</span>}
          {activeChildren > 0 && <span className="shrink-0 text-gray-500 dark:text-white/45">{t("chat.harness.activeChildren", { count: activeChildren })}</span>}
          {blockedChildren > 0 && <span className="shrink-0 font-medium text-amber-700 dark:text-amber-400">{t("chat.harness.blockedChildren", { count: blockedChildren })}</span>}
          {pending > 0 && <span className="shrink-0 text-amber-600 dark:text-amber-400">{pending}</span>}
          {(openConversation || openFleet) && (
            <button
              type="button"
              aria-label={blockedLabel
                ? t("chat.harness.blockedAria", { title: label, state: blockedLabel })
                : t(openConversation ? "chat.harness.openConversationAria" : "chat.harness.openFleetAria", { title: label })}
              onClick={(event) => {
                event.stopPropagation();
                if (openConversation) selectConversation(threadKey(openConversation));
                else navigate("/fleet");
              }}
              className={`shrink-0 rounded px-1 ${blockedLabel ? "font-medium text-amber-700 dark:text-amber-400" : "text-gray-500 dark:text-white/45"} hover:bg-gray-200 dark:hover:bg-white/10`}
            >
              {blockedLabel ?? t("chat.harness.open")}
            </button>
          )}
          {!(openConversation || openFleet) && blockedLabel && <span className="shrink-0 font-medium text-amber-700 dark:text-amber-400">{blockedLabel}</span>}
        </div>
        {expanded && renderDetail(node, finalLabel)}
      </div>
    );
  };

  return (
    <section aria-label={t("chat.harness.lineage")} className="flex flex-col text-chat-prose">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}
        className="flex items-center gap-2.5 min-h-[26px] text-left text-chat-ui text-gray-500 dark:text-white/45 hover:text-gray-800 dark:hover:text-white/75">
        <BotIcon className="w-4 h-4 shrink-0 text-gray-400 dark:text-white/40" />
        <span className="min-w-0 truncate">{t("chat.harness.lineage")} · {t("chat.harness.taskCount", { count: tasks.length })} · {t("chat.harness.childCount", { count: childCount })}</span>
        {activeCount > 0 && <span className="shrink-0 text-emerald-600 dark:text-emerald-400">● {t("chat.harness.activeCount", { count: activeCount })}</span>}
        {attentionCount > 0 && <span className="shrink-0 text-amber-600 dark:text-amber-400">{t("chat.harness.attentionCount", { count: attentionCount })}</span>}
        <ChevronRightIcon className={`w-3.5 h-3.5 shrink-0 text-gray-300 dark:text-white/25 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && <div className="ml-[26px] mt-1 flex flex-col gap-1">
        <div ref={treeRef} role="tree" aria-label={t("chat.harness.tree")} className="flex flex-col gap-1">
          {visible.map((row) => renderRow(row))}
        </div>
        {eventGroups.unattached.length > 0 && <section className="mt-2 border-t border-gray-200 pt-2 dark:border-white/[0.07]">
          <button type="button" aria-expanded={activityOpen} onClick={() => setActivityOpen((value) => !value)}
            className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-gray-400 dark:text-white/40">
            <ChevronRightIcon aria-hidden="true" className={`w-3 h-3 transition-transform ${activityOpen ? "rotate-90" : ""}`} />
            {t("chat.harness.activity")} · {t("chat.harness.activityCount", { count: eventGroups.unattached.length })}
          </button>
          {activityOpen && <div className="max-h-48 overflow-auto">{renderEvents("activity", eventGroups.unattached)}</div>}
        </section>}
      </div>}
    </section>
  );
}
