import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";

import { selectConversation } from "@/features/chat/unified/selectionActions";
import { listHarnessExecutionGraph, readAttemptEvents } from "@/features/runs/ipc";
import type {
  AgentEvent,
  HarnessExecutionEvent,
  HarnessExecutionGraph,
  HarnessExecutionNode,
  HarnessNodeResult,
} from "@/features/runs/types";

import { BotIcon, ChevronRightIcon } from "../chatIcons";
import { chatThreadRequests, chatThreadStatus, type ThreadRow } from "./ipc";
import { threadKey } from "./model";
import { useStructured } from "./store";

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
  if (status === "waiting" || status === "pending" || status === "ready") return "bg-amber-500";
  if (status === "interrupted") return "bg-amber-500";
  if (status === "working" || status === "running" || status === "inProgress") return "bg-emerald-500";
  if (status === "failed") return "bg-red-500";
  if (status === "done" || status === "completed" || status === "settled") return "bg-gray-400";
  return "bg-gray-300 dark:bg-white/25";
}

/** Árvore comum do harness: threads, turnos estruturados e tarefas headless da Frota. */
export function HarnessRunFeed({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [graph, setGraph] = useState<HarnessExecutionGraph | null>(null);
  const [childSnapshots, setChildSnapshots] = useState<Record<string, ChildSnapshot>>({});
  const [open, setOpen] = useState(false);
  const [expandedAttemptId, setExpandedAttemptId] = useState<string | null>(null);
  const [attemptEvents, setAttemptEvents] = useState<Record<string, AgentEvent[]>>({});
  const [loadingAttempts, setLoadingAttempts] = useState<Record<string, boolean>>({});
  const threads = useStructured((state) => state.threads);
  const live = useStructured((state) => state.live);
  const lineageChats = useMemo(() => descendants(threadId, threads), [threadId, threads]);
  const lineageKey = lineageChats.map(({ thread }) => thread.id).sort().join("|");
  const graphNodes = graph?.nodes ?? [];
  const graphEvents = graph?.events ?? [];
  const taskIds = useMemo(() => new Set(
    graphNodes.filter((node) => node.kind === "fleetTask").map((node) => node.id.replace(/^task:/, "")),
  ), [graphNodes]);
  const knownThreadIds = useMemo(() => new Set([
    threadId,
    ...graphNodes.filter((node) => node.kind === "thread").flatMap((node) => node.threadId ? [node.threadId] : []),
    ...lineageChats.map(({ thread }) => thread.id),
  ]), [graphNodes, lineageChats, threadId]);
  const knownThreadIdsRef = useRef(knownThreadIds);
  const taskIdsRef = useRef(taskIds);
  const refreshRef = useRef(0);
  knownThreadIdsRef.current = knownThreadIds;
  taskIdsRef.current = taskIds;

  const toggleAttempt = (id: string) => {
    if (expandedAttemptId === id) {
      setExpandedAttemptId(null);
      return;
    }
    setExpandedAttemptId(id);
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

  useEffect(() => {
    let alive = true;
    let refreshTimer: number | undefined;
    setGraph(null);
    ++refreshRef.current;
    const refresh = () => {
      refreshTimer = undefined;
      const request = ++refreshRef.current;
      void listHarnessExecutionGraph(threadId).then((next) => {
        if (alive && request === refreshRef.current) setGraph(next);
      }).catch(() => undefined);
    };
    const load = () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(refresh, 50);
    };
    const unlisten = [
      listen<string>("cc-task-changed", (event) => {
        if (taskIdsRef.current.has(event.payload)) load();
      }),
      listen<string>("cc-thread-run-changed", (event) => {
        if (knownThreadIdsRef.current.has(event.payload)) load();
      }),
      listen<{ threadId?: string }>("cc-chat-thread", (event) => {
        if (event.payload.threadId && knownThreadIdsRef.current.has(event.payload.threadId)) load();
      }),
      listen<string>("cc-harness-event", (event) => {
        if (knownThreadIdsRef.current.has(event.payload)) load();
      }),
    ];
    load();
    return () => {
      alive = false;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      unlisten.forEach((pending) => pending.then((off) => off()).catch(() => undefined));
    };
  }, [lineageKey, threadId]);

  useEffect(() => {
    const childIds = new Set(lineageChats.map(({ thread }) => thread.id));
    if (childIds.size === 0) {
      setChildSnapshots({});
      return;
    }
    let alive = true;
    const refresh = (id: string) => {
      void Promise.all([chatThreadStatus(id), chatThreadRequests(id)]).then(([status, requests]) => {
        if (alive) setChildSnapshots((current) => ({
          ...current,
          [id]: { working: status.working, pending: requests.length },
        }));
      }).catch(() => undefined);
    };
    childIds.forEach(refresh);
    const unlisten = listen<{ threadId?: string }>("cc-chat-thread", (event) => {
      const id = event.payload.threadId;
      if (id && childIds.has(id)) refresh(id);
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
  const visibleNodes = useMemo(() => {
    const children = new Map<string, HarnessExecutionNode[]>();
    const byId = new Map(graphNodes.map((node) => [node.id, node]));
    for (const node of graphNodes) {
      if (!node.parentId) continue;
      children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
    }
    const ordered: HarnessExecutionNode[] = [];
    const visited = new Set<string>();
    const visit = (node: HarnessExecutionNode) => {
      if (visited.has(node.id)) return;
      visited.add(node.id);
      ordered.push(node);
      for (const child of children.get(node.id) ?? []) visit(child);
    };
    for (const node of graphNodes) {
      if (!node.parentId || !byId.has(node.parentId)) visit(node);
    }
    for (const node of graphNodes) visit(node);
    return ordered.filter((node) => !(node.kind === "thread" && node.threadId === threadId));
  }, [graphNodes, threadId]);
  const eventGroups = useMemo(() => {
    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    const byParent = new Map<string, HarnessExecutionEvent[]>();
    const unattached: HarnessExecutionEvent[] = [];
    for (const event of graphEvents) {
      if (!event.parentNodeId || !visibleIds.has(event.parentNodeId)) {
        unattached.push(event);
        continue;
      }
      byParent.set(event.parentNodeId, [...(byParent.get(event.parentNodeId) ?? []), event]);
    }
    return { byParent, unattached };
  }, [graphEvents, visibleNodes]);
  if (visibleNodes.length === 0 && childCount === 0) return null;

  /** A entrega do filho, num bloco à parte e marcado: é fala de agente, nunca instrução. */
  const renderResult = (result: HarnessNodeResult, depth: number) => (
    <section
      aria-label={t("chat.harness.resultLabel")}
      data-untrusted="true"
      className="mb-1 rounded border border-dashed border-gray-300 bg-gray-50 px-2 py-1 dark:border-white/15 dark:bg-white/[0.03]"
      style={{ marginLeft: `${Math.min(depth, 5) * 12 + 12}px` }}
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

  const renderNode = (node: HarnessExecutionNode) => {
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
    const statusKey = graphStatusKey(node, childStatus);
    const statusLabel = t(statusKey, { defaultValue: childStatus ?? node.executionStatus ?? node.status });
    const activeChildren = turnActiveChildren(node);
    const blockedChildren = node.blockedChildren ?? 0;
    // O bloqueio que a projeção conhece (pergunta ou aprovação, com o tipo); a conversa viva, sem tipo, diz só "aguardando você".
    const blockedLabel = node.blocked
      ? t(`chat.harness.blocked.${node.blocked.kind}`)
      : pending > 0 ? t("chat.harness.childStatus.waiting") : null;
    const label = node.kind === "turn"
      ? `${t("chat.harness.turnTitle")} · ${new Date(node.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
      : node.kind === "fleetAttempt"
        ? t("chat.harness.attemptTitle", { count: node.attempt ?? 1 })
      : node.kind === "fleetTask" ? node.planKey || node.title : node.title;
    const origin = node.origin;
    const rowClass = "flex min-w-0 items-center gap-2 min-h-[24px] text-chat-note";
    const content = (
      <>
        <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${nodeColor(node, childStatus)}`} />
        <span className="min-w-0 flex-1 truncate text-gray-800 dark:text-white/85" title={node.title}>{label}</span>
        {node.childType && <span className="shrink-0 text-gray-400 dark:text-white/40">{t(`chat.harness.childType.${node.childType}`)}</span>}
        {node.agentId && <span className="shrink-0 max-w-[8rem] truncate text-gray-400 dark:text-white/35">{node.agentId}{node.model ? ` · ${node.model}` : ""}</span>}
        <span className="shrink-0 text-gray-500 dark:text-white/45">{statusLabel}</span>
        {origin && <span className="shrink-0 text-gray-400 dark:text-white/35">{t(`chat.harness.origin.${origin.createdBy}`)}</span>}
        {blockedLabel && <span className="shrink-0 font-medium text-amber-700 dark:text-amber-400">{blockedLabel}</span>}
        {activeChildren > 0 && <span className="shrink-0 text-gray-500 dark:text-white/45">{t("chat.harness.activeChildren", { count: activeChildren })}</span>}
        {blockedChildren > 0 && <span className="shrink-0 font-medium text-amber-700 dark:text-amber-400">{t("chat.harness.blockedChildren", { count: blockedChildren })}</span>}
        {pending > 0 && <span className="shrink-0 text-amber-600 dark:text-amber-400">{pending}</span>}
      </>
    );
    const style = { marginLeft: `${Math.min(node.depth, 5) * 12}px` };
    const blockedRow = blockedLabel ? " bg-amber-50 dark:bg-amber-500/10" : "";
    if (node.kind === "fleetAttempt") {
      const expanded = expandedAttemptId === node.id;
      return (
        <button key={node.id} type="button" onClick={() => toggleAttempt(node.id)} aria-expanded={expanded}
          className={`${rowClass} w-full text-left hover:bg-gray-100 dark:hover:bg-white/[0.06] rounded px-1 -mx-1`} style={style}>
          {content}
          <ChevronRightIcon className={`w-3 h-3 shrink-0 text-gray-400 transition-transform ${expanded ? "rotate-90" : ""}`} />
        </button>
      );
    }
    // A conversa filha abre pela linha (a mesma ação de antes, agora também sem a conversa viva na store).
    // A tarefa da Frota só é um alvo quando está bloqueada: a aprovação se responde na tela da Frota.
    const openConversation = node.kind === "thread" && node.threadId ? node.threadId : null;
    const openFleet = node.kind === "fleetTask" && node.blocked;
    if (openConversation || openFleet) {
      const ariaLabel = blockedLabel ? t("chat.harness.blockedAria", { title: label, state: blockedLabel }) : undefined;
      return (
        <button key={node.id} type="button" aria-label={ariaLabel}
          onClick={() => (openConversation ? selectConversation(threadKey(openConversation)) : navigate("/fleet"))}
          className={`${rowClass} w-full text-left hover:bg-gray-100 dark:hover:bg-white/[0.06] rounded px-1 -mx-1${blockedRow}`} style={style}>
          {content}
        </button>
      );
    }
    return (
      <div key={node.id} className={`${rowClass} rounded px-1 -mx-1${blockedRow}`} style={style}>{content}</div>
    );
  };

  const renderEvent = (event: HarnessExecutionEvent, depth = 0) => {
    const payload = event.payload;
    const status = typeof payload.status === "string"
      ? t(`chat.harness.status.${payload.status}`, { defaultValue: payload.status })
      : undefined;
    const detail = [payload.label, payload.title, payload.name, status]
      .find((value): value is string => typeof value === "string" && value.length > 0);
    return (
      <div key={event.nodeId} style={{ marginLeft: `${Math.min(depth, 5) * 12}px` }} className="flex min-w-0 items-baseline gap-2 border-b border-gray-200 py-1 last:border-0 dark:border-white/[0.06]">
        <span className="w-12 shrink-0 text-right text-[10px] text-gray-400">
          {new Date(event.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
        <span className="shrink-0 text-chat-note text-gray-500 dark:text-white/50">
          {t(`chat.harness.semantic.${event.kind}`, { defaultValue: event.kind })}
        </span>
        {detail && <span className="min-w-0 truncate text-chat-note text-gray-700 dark:text-white/70" title={detail}>{detail}</span>}
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
        {visibleNodes.map((node) => {
          const expanded = node.kind === "fleetAttempt" && expandedAttemptId === node.id;
          const events = attemptEvents[node.id] ?? [];
          return (
            <Fragment key={node.id}>
              {renderNode(node)}
              {node.result && renderResult(node.result, node.depth)}
              {(eventGroups.byParent.get(node.id) ?? []).map((event) => renderEvent(event, node.depth + 1))}
              {expanded && <div className="ml-[24px] max-h-56 overflow-auto rounded bg-gray-50 px-2 py-1 dark:bg-white/[0.035]">
                {loadingAttempts[node.id] ? <div className="text-chat-note text-gray-400">{t("chat.harness.eventsLoading")}</div>
                  : events.length === 0 ? <div className="text-chat-note text-gray-400">{t("chat.harness.eventsEmpty")}</div>
                    : events.map((event, index) => {
                      const kind = event.kind === "text" ? "output" : event.kind;
                      const detail = event.kind === "text" ? event.text
                        : event.kind === "tool" ? event.label
                          : event.kind === "started" ? t("chat.harness.eventStarted")
                            : event.outcome.error || event.outcome.result || t("chat.harness.eventFinished");
                      return <div key={`${node.id}:${index}`} className="flex gap-2 border-b border-gray-200 py-1 last:border-0 dark:border-white/[0.06]">
                        <span className="shrink-0 text-gray-400">{t(`chat.harness.event.${kind}`)}</span>
                        <span className="min-w-0 whitespace-pre-wrap break-words text-gray-600 dark:text-white/60">{detail}</span>
                      </div>;
                    })}
              </div>}
            </Fragment>
          );
        })}
        {eventGroups.unattached.length > 0 && <section className="mt-2 border-t border-gray-200 pt-2 dark:border-white/[0.07]">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-gray-400 dark:text-white/40">
            {t("chat.harness.activityCount", { count: eventGroups.unattached.length })}
          </div>
          <div className="max-h-48 overflow-auto">{eventGroups.unattached.map((event) => renderEvent(event))}</div>
        </section>}
      </div>}
    </section>
  );
}
