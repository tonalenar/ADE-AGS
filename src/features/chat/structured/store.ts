import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";

import { setComposing, useChatStore } from "../store";
import {
  chatAccountSet, chatRequestAnswer, chatThreadAutoCompactOnReturn, chatThreadClearContext, chatThreadCompactContext, chatThreadCreate, chatThreadGoalAction, chatThreadGoalGet, chatThreadInterrupt, chatThreadItems, chatThreadProviderConfig, chatThreadRequests, chatThreadRetune, chatThreadSend, chatThreadSwitchAgent,
  chatThreadSettle, chatThreads, chatThreadStatus, type ThreadAccess, type ThreadRow,
} from "./ipc";
import type { ThreadGoal } from "./ipc";
import { createFrameBatcher } from "../timeline/streaming";
import { unsnoozeConversation } from "../shelf";
import { dispatchSkillMentions } from "../skillMentions";
import { useAgentSkillsStore } from "@/features/skills/agentSkillsStore";
import { applyDeltas, applyThreadEvent, applyThreadMeta, EMPTY_LIVE, isLocalAcpAgent, threadKey, type ThreadEvent, type ThreadLive } from "./model";
import { addLogFailure, dismissLogFailure, parseLogFailure, type LogFailure } from "./logFailureModel";

/** O sinal da janela quando uma gravação do log de execução falha de vez (ver `runs/execution_log.rs`). */
const LOG_FAILED_EVENT = "cc-harness-log-failed";

/**
 * As conversas por protocolo, ao vivo: a lista (do banco) e, por conversa aberta, a timeline, os
 * pedidos pendentes e se o agente está trabalhando. Tudo chega pelo evento `cc-chat-thread`; a
 * primeira leitura de cada conversa vem do banco.
 */
interface StructuredState {
  threads: ThreadRow[];
  live: Record<string, ThreadLive>;
  goals: Record<string, ThreadGoal | null>;
  goalNotices: Record<string, string | null>;
  /** As conversas cuja timeline já foi lida do banco. */
  hydrated: Record<string, boolean>;
  /** Falhas de gravação do log, por conversa, até a pessoa dispensá-las. Não entram no chat. */
  logFailures: Record<string, LogFailure[]>;
}

export const useStructured = create<StructuredState>(() => ({ threads: [], live: {}, goals: {}, goalNotices: {}, hydrated: {}, logFailures: {} }));

/** Um sinal de falha do log entra na conversa afetada, sem repetir o mesmo aviso. Sinal sem conversa é ignorado. */
export function recordLogFailure(raw: unknown): void {
  const failure = parseLogFailure(raw);
  if (!failure) return;
  useStructured.setState((s) => ({
    logFailures: { ...s.logFailures, [failure.threadId]: addLogFailure(s.logFailures[failure.threadId] ?? [], failure) },
  }));
}

/** A pessoa dispensou o aviso: sai da conversa. A falha continua no banco; só o aviso some desta janela. */
export function dismissThreadLogFailure(threadId: string, key: string): void {
  useStructured.setState((s) => ({
    logFailures: { ...s.logFailures, [threadId]: dismissLogFailure(s.logFailures[threadId] ?? [], key) },
  }));
}

const liveOf = (id: string) => useStructured.getState().live[id] ?? EMPTY_LIVE;

function patchLive(id: string, fn: (live: ThreadLive) => ThreadLive): void {
  useStructured.setState((s) => ({ live: { ...s.live, [id]: fn(s.live[id] ?? EMPTY_LIVE) } }));
}

function upsertThread(row: ThreadRow): void {
  useStructured.setState((s) => ({ threads: [row, ...s.threads.filter((t) => t.id !== row.id)] }));
}

export function reloadThreads(): Promise<void> {
  return chatThreads().then((threads) => useStructured.setState({ threads })).catch(() => undefined);
}

type DeltaEvent = Extract<ThreadEvent, { type: "delta" }>;

/** Agenda no próximo quadro (fora da janela, num tique curto). */
function nextFrame(run: () => void): () => void {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(run);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(run, 16);
  return () => clearTimeout(id);
}

/**
 * Os pedaços do texto chegam a cada token: juntá-los por quadro faz uma atualização do store (e um
 * redesenho) por quadro, não por token.
 */
const deltas = createFrameBatcher<DeltaEvent>(nextFrame, (batch) => {
  const byThread = new Map<string, DeltaEvent[]>();
  for (const d of batch) byThread.set(d.threadId, [...(byThread.get(d.threadId) ?? []), d]);
  useStructured.setState((s) => {
    const live = { ...s.live };
    for (const [id, list] of byThread) live[id] = applyDeltas(live[id] ?? EMPTY_LIVE, list);
    return { live };
  });
});

let started = false;

/** Liga a escuta (uma vez por janela) e lê a lista. */
export function startStructured(): void {
  if (started) return;
  started = true;
  void reloadThreads();
  void listen<unknown>(LOG_FAILED_EVENT, (e) => recordLogFailure(e.payload));
  void listen<ThreadEvent | { type: "created"; threadId: string; thread: ThreadRow }>("cc-chat-thread", (e) => {
    const event = e.payload;
    if (event.type === "delta") {
      deltas.push(event);
      return;
    }
    // O que vem depois dos pedaços (o item completo, o fim do turno) os vê aplicados, na ordem.
    deltas.flushNow();
    // Criada fora da tela (pela CLI `ags chat new`).
    if (event.type === "created") {
      upsertThread(event.thread);
      return;
    }
    if (event.type === "thread") {
      useStructured.setState((s) => ({ threads: s.threads.map((t) => (t.id === event.threadId ? applyThreadMeta(t, event) : t)) }));
      return;
    }
    if (event.type === "goal") {
      useStructured.setState((s) => ({ goals: { ...s.goals, [event.threadId]: event.goal } }));
      return;
    }
    // Pedidos e falhas são pontos de atenção: tiram o fio do adiamento sem acordar turnos normais.
    if (event.type === "request" || event.type === "error") unsnoozeConversation(threadKey(event.threadId));
    patchLive(event.threadId, (live) => applyThreadEvent(live, event));
    if (event.type === "item") {
      useStructured.setState((s) => ({ threads: s.threads.map((t) => (t.id === event.threadId ? { ...t, updatedAt: Date.now() } : t)) }));
    }
  });
}

/** Lê do banco a timeline e os pendentes de uma conversa (uma vez). */
export function hydrateThread(id: string): void {
  if (useStructured.getState().hydrated[id]) return;
  useStructured.setState((s) => ({ hydrated: { ...s.hydrated, [id]: true } }));
  void Promise.all([chatThreadItems(id), chatThreadRequests(id), chatThreadStatus(id), chatThreadGoalGet(id), chatThreadProviderConfig(id)])
    .then(([items, requests, status, goal, providerConfig]) => {
      patchLive(id, (live) => ({
        ...live,
        // O que chegou por evento enquanto lia fica (é mais novo).
        items: [...items.filter((i) => !live.items.some((x) => x.id === i.id)), ...live.items],
        requests: requests.length > 0 ? requests : live.requests,
        phase: status.working ? "working" : live.phase,
        providerConfig: providerConfig ?? live.providerConfig,
      }));
      useStructured.setState((s) => ({ goals: { ...s.goals, [id]: Object.prototype.hasOwnProperty.call(s.goals, id) ? s.goals[id]! : goal } }));
    })
    .catch(() => useStructured.setState((s) => ({ hydrated: { ...s.hydrated, [id]: false } })));
}

/** Mostra uma conversa por protocolo. */
export function openThread(id: string): void {
  useChatStore.setState({ thread: id });
  setComposing(false);
}

export interface NewThread {
  agentId: string;
  cwd: string;
  workspaceId?: string | null;
  title: string;
  model: string | null;
  effort: string | null;
  access: ThreadAccess;
  accountId: string | null;
  parentRef?: string | null;
}

/** Cria a conversa, mostra e manda a primeira mensagem. */
export async function startThread(input: NewThread, text: string, images?: string[], background = false): Promise<string> {
  const id = await createThread(input);
  if (!background) openThread(id);
  sendToThread(id, text, undefined, undefined, images);
  return id;
}

/** Cria a conversa por protocolo sem abri-la nem mandar nada (o time é montado antes de a tela trocar). */
export async function createThread(input: NewThread): Promise<string> {
  const row = await chatThreadCreate(input);
  upsertThread(row);
  useStructured.setState((s) => ({ hydrated: { ...s.hydrated, [row.id]: true } }));
  return row.id;
}

/** Manda uma mensagem (começa um turno, ou entra no que está em andamento). */
export function sendToThread(id: string, text: string, onError?: (message: string) => void, onSent?: () => void, images?: string[]): void {
  if (text.trim() || images?.length) unsnoozeConversation(threadKey(id));
  patchLive(id, (live) => ({ ...live, phase: "working", error: null }));
  const send = (outgoing: string) => {
    // `onSent` só depois de o backend aceitar a mensagem; `onError` só se ele a recusar.
    chatThreadSend(id, outgoing, images).then(() => onSent?.(), (e) => {
      onError?.(String(e));
      patchLive(id, (live) => ({ ...live, phase: "idle", error: String(e) }));
    });
  };
  const row = useStructured.getState().threads.find((thread) => thread.id === id);
  // Claude e Cursor precisam receber `/nome`; no composer os dois usam a menção portátil `$nome`.
  if ((row?.agentId === "claude-code" || row?.agentId === "cursor") && text.includes("$")) {
    void useAgentSkillsStore.getState().load(row.cwd, row.agentId, id)
      .catch(() => [])
      .then((skills) => send(dispatchSkillMentions(row.agentId, text, skills.map((skill) => skill.name))));
    return;
  }
  send(text);
}

export function interruptThread(id: string): void {
  chatThreadInterrupt(id).catch((e) => patchLive(id, (live) => ({ ...live, error: String(e) })));
}

export async function compactThread(id: string, instructions?: string): Promise<string | null> {
  try {
    await chatThreadCompactContext(id, instructions);
    return null;
  } catch (error) {
    patchLive(id, (live) => ({ ...live, error: String(error) }));
    return String(error);
  }
}

/** Executa o modo opt-in de compactação ao reabrir uma conversa Claude. */
export function autoCompactThreadOnReturn(id: string): void {
  void chatThreadAutoCompactOnReturn(id).catch((error) => {
    patchLive(id, (live) => ({ ...live, error: String(error) }));
  });
}

export async function clearThreadContext(id: string): Promise<string | null> {
  try {
    await chatThreadClearContext(id);
    useStructured.setState((s) => ({ goals: { ...s.goals, [id]: null }, goalNotices: { ...s.goalNotices, [id]: null } }));
    return null;
  } catch (error) {
    patchLive(id, (live) => ({ ...live, error: String(error) }));
    return String(error);
  }
}

export async function runThreadGoalAction(id: string, action: "show" | "set" | "pause" | "resume" | "clear", objective?: string): Promise<string | null> {
  try {
    const goal = await chatThreadGoalAction(id, action, objective);
    useStructured.setState((s) => ({ goals: { ...s.goals, [id]: goal }, goalNotices: { ...s.goalNotices, [id]: action === "show" && !goal ? "none" : null } }));
    return null;
  } catch (error) {
    patchLive(id, (live) => ({ ...live, error: String(error) }));
    return String(error);
  }
}

export function answerRequest(threadId: string, requestId: string, choice: string): void {
  unsnoozeConversation(threadKey(threadId));
  // Some da tela na hora; se o backend recusar (o agente fechou), o erro aparece.
  patchLive(threadId, (live) => ({ ...live, requests: live.requests.filter((r) => r.id !== requestId) }));
  chatRequestAnswer(requestId, choice).catch((e) => patchLive(threadId, (live) => ({ ...live, error: String(e) })));
}

export async function retuneThread(id: string, model: string | null, effort: string | null, access: ThreadAccess): Promise<boolean> {
  try {
    const previous = useStructured.getState().threads.find((thread) => thread.id === id);
    const updated = await chatThreadRetune(id, model, effort, access);
    upsertThread(updated);
    // Opções de raciocínio ACP podem depender do modelo. Descarte o snapshot anterior até
    // a sessão seguinte anunciar a configuração correspondente ao modelo novo.
    if (previous && isLocalAcpAgent(previous.agentId) && previous.model !== updated.model) {
      patchLive(id, (live) => ({ ...live, providerConfig: null }));
    }
    return true;
  } catch (e) {
    patchLive(id, (live) => ({ ...live, error: String(e) }));
    return false;
  }
}

/**
 * Troca o agente da conversa (só entre turnos). Devolve o erro em texto para quem pediu mostrar; a conversa e o
 * aviso «agora com …» chegam pelos eventos.
 */
export async function switchThreadAgent(id: string, agentId: string, model: string | null, effort: string | null, access: ThreadAccess): Promise<string | null> {
  try {
    upsertThread(await chatThreadSwitchAgent(id, agentId, model, effort, access, null));
    patchLive(id, (live) => ({ ...live, providerConfig: null, providerCommands: [] }));
    return null;
  } catch (e) {
    return String(e);
  }
}

/** A pessoa escolheu outra conta para a conversa. Devolve o erro (o menu o mostra) ou `null`. */
export async function switchThreadAccount(id: string, accountId: string | null): Promise<string | null> {
  try {
    await chatAccountSet(id, accountId);
    await reloadThreads();
    return null;
  } catch (e) {
    return String(e);
  }
}

/** Conclui (o agente fecha; reabrir retoma a mesma thread) ou reabre. */
export function settleThread(id: string, settled: boolean): void {
  useStructured.setState((s) => ({ threads: s.threads.map((t) => (t.id === id ? { ...t, state: settled ? "settled" : "active" } : t)) }));
  if (settled && useChatStore.getState().thread === id) useChatStore.setState({ thread: null });
  chatThreadSettle(id, settled).catch(() => void reloadThreads());
}

export { liveOf };
