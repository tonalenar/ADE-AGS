import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";

import { setComposing, useChatStore } from "../store";
import { fastModeForThread } from "../fastMode";
import {
  chatAccountSet, chatRequestAnswer, chatSideChatFork, chatThreadAutoCompactOnReturn, chatThreadClearContext, chatThreadCompactContext, chatThreadCreate, chatThreadGoalAction, chatThreadGoalGet, chatThreadInterrupt, chatThreadItems, chatThreadProviderConfig, chatThreadRequests, chatThreadRetune, chatThreadSend, chatThreadSwitchAgent,
  chatThreadSettle, chatThreads, chatThreadStatus, type RequestRow, type SideChatForkOutcome, type ThreadAccess, type ThreadRow,
} from "./ipc";
import type { ThreadGoal } from "./ipc";
import { createFrameBatcher } from "../timeline/streaming";
import { unsnoozeConversation } from "../shelf";
import { dispatchSkillMentions } from "../skillMentions";
import { useAgentSkillsStore } from "@/features/skills/agentSkillsStore";
import { applyDeltas, applyThreadEvent, applyThreadMeta, EMPTY_LIVE, forgetGoneAnswerErrors, isLocalAcpAgent, threadKey, type ThreadEvent, type ThreadLive } from "./model";
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
  /** A última falha de leitura de cada conversa, quando as tentativas se esgotaram (a timeline mostra e oferece tentar de novo). */
  hydrateErrors: Record<string, string>;
  /** Falhas de gravação do log, por conversa, até a pessoa dispensá-las. Não entram no chat. */
  logFailures: Record<string, LogFailure[]>;
  /** Avisos de falha de resposta, por id de pedido. Ficam fora de `live.requests`: uma releitura do fio não os apaga. */
  answerErrors: Record<string, string>;
  /** Contador local monotônico para ordenar pedidos recebidos por evento, independente do relógio do servidor. */
  arrivalSeq: number;
  /** Última chegada local de cada pedido, por conversa e id do pedido. */
  requestArrivalSeq: Record<string, Record<string, number>>;
}

export const useStructured = create<StructuredState>(() => ({ threads: [], live: {}, goals: {}, goalNotices: {}, hydrated: {}, hydrateErrors: {}, logFailures: {}, answerErrors: {}, arrivalSeq: 0, requestArrivalSeq: {} }));

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
  useStructured.setState((s) => {
    const before = s.live[id] ?? EMPTY_LIVE;
    const after = fn(before);
    // Quando um pedido sai da caixa (respondido, ou fechado pelo agente), o seu aviso sai junto.
    return {
      live: { ...s.live, [id]: after },
      answerErrors: forgetGoneAnswerErrors(before, after, s.answerErrors),
      requestArrivalSeq: forgetGoneRequestArrivals(id, after, s.requestArrivalSeq),
    };
  });
}

/** Remove os marcos locais de pedidos que já saíram da caixa da conversa. */
function forgetGoneRequestArrivals(threadId: string, live: ThreadLive, arrivals: Record<string, Record<string, number>>): Record<string, Record<string, number>> {
  const byRequest = arrivals[threadId];
  if (!byRequest) return arrivals;
  const pending = new Set(live.requests.map((request) => request.id));
  const gone = Object.keys(byRequest).filter((id) => !pending.has(id));
  if (gone.length === 0) return arrivals;
  const nextByRequest = { ...byRequest };
  for (const id of gone) delete nextByRequest[id];
  const next = { ...arrivals };
  if (Object.keys(nextByRequest).length === 0) delete next[threadId];
  else next[threadId] = nextByRequest;
  return next;
}

/** Um pedido que entra pelo evento recebe ordem local; o carimbo do servidor não participa da concorrência. */
export function recordThreadRequest(threadId: string, request: RequestRow): void {
  useStructured.setState((s) => {
    const before = s.live[threadId] ?? EMPTY_LIVE;
    const after = applyThreadEvent(before, { type: "request", threadId, request });
    const arrivalSeq = s.arrivalSeq + 1;
    const arrivals = {
      ...s.requestArrivalSeq,
      [threadId]: { ...(s.requestArrivalSeq[threadId] ?? {}), [request.id]: arrivalSeq },
    };
    return {
      arrivalSeq,
      live: { ...s.live, [threadId]: after },
      answerErrors: forgetGoneAnswerErrors(before, after, s.answerErrors),
      requestArrivalSeq: forgetGoneRequestArrivals(threadId, after, arrivals),
    };
  });
}

function upsertThread(row: ThreadRow): void {
  useStructured.setState((s) => ({ threads: [row, ...s.threads.filter((t) => t.id !== row.id)] }));
}

export function reloadThreads(): Promise<void> {
  return chatThreads().then((threads) => useStructured.setState({ threads })).catch(() => undefined);
}

/** Remove do estado local uma conversa lateral excluída no backend e os avisos dos seus pedidos. */
export function removeDeletedSideChat(id: string): void {
  useStructured.setState((state) => ({
    threads: state.threads.filter((row) => row.id !== id),
    live: Object.fromEntries(Object.entries(state.live).filter(([threadId]) => threadId !== id)),
    hydrated: Object.fromEntries(Object.entries(state.hydrated).filter(([threadId]) => threadId !== id)),
    hydrateErrors: withoutKey(state.hydrateErrors, id),
    answerErrors: forgetGoneAnswerErrors(state.live[id] ?? EMPTY_LIVE, EMPTY_LIVE, state.answerErrors),
    requestArrivalSeq: Object.fromEntries(Object.entries(state.requestArrivalSeq).filter(([threadId]) => threadId !== id)),
  }));
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
    if (event.type === "request") {
      recordThreadRequest(event.threadId, event.request);
      return;
    }
    patchLive(event.threadId, (live) => applyThreadEvent(live, event));
    if (event.type === "item") {
      useStructured.setState((s) => ({ threads: s.threads.map((t) => (t.id === event.threadId ? { ...t, updatedAt: Date.now() } : t)) }));
    }
  });
}

/** Quantas vezes a leitura de uma conversa por protocolo é tentada antes de desistir. */
const HYDRATE_ATTEMPTS = 3;

function readThread(id: string) {
  return Promise.all([chatThreadItems(id), chatThreadRequests(id), chatThreadStatus(id), chatThreadGoalGet(id), chatThreadProviderConfig(id)]);
}

/** Pausa entre as tentativas de leitura: cresce a cada falha, para não martelar o banco que acabou de falhar. */
const HYDRATE_RETRY_MS = 300;

/**
 * Lê a conversa do banco. Tenta algumas vezes, com uma pausa crescente; se todas falharem, a conversa não fica
 * «carregando» para sempre: a falha vai para `hydrateErrors`, a timeline mostra o erro e oferece tentar de novo
 * (`retryThreadHydration`).
 */
export function hydrateThread(id: string): Promise<void> {
  if (useStructured.getState().hydrated[id]) return Promise.resolve();
  useStructured.setState((s) => ({ hydrated: { ...s.hydrated, [id]: true } }));
  const readSeq = useStructured.getState().arrivalSeq;
  return (async () => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < HYDRATE_ATTEMPTS; attempt++) {
      try {
        const [items, requests, status, goal, providerConfig] = await readThread(id);
        const requestArrivals = useStructured.getState().requestArrivalSeq[id] ?? {};
        patchLive(id, (live) => ({
          ...live,
          // O que chegou por evento enquanto lia fica (é mais novo).
          items: [...items.filter((i) => !live.items.some((x) => x.id === i.id)), ...live.items],
          // Uma caixa vazia confirma a resolução dos pedidos anteriores à leitura; eventos recebidos depois prevalecem.
          requests: requests.length > 0 ? requests : live.requests.filter((request) => (requestArrivals[request.id] ?? 0) > readSeq),
          phase: status.working ? "working" : live.phase,
          providerConfig: providerConfig ?? live.providerConfig,
        }));
        useStructured.setState((s) => ({
          goals: { ...s.goals, [id]: Object.prototype.hasOwnProperty.call(s.goals, id) ? s.goals[id]! : goal },
          hydrateErrors: withoutKey(s.hydrateErrors, id),
        }));
        return;
      } catch (error) {
        lastError = error;
        if (attempt < HYDRATE_ATTEMPTS - 1) await new Promise<void>((resolve) => setTimeout(resolve, HYDRATE_RETRY_MS * (attempt + 1)));
      }
    }
    useStructured.setState((s) => ({
      hydrated: { ...s.hydrated, [id]: false },
      hydrateErrors: { ...s.hydrateErrors, [id]: String(lastError) },
    }));
  })();
}

/** Tenta de novo a leitura de uma conversa cuja timeline falhou (o botão «Tentar de novo»). */
export function retryThreadHydration(id: string): void {
  useStructured.setState((s) => ({ hydrated: { ...s.hydrated, [id]: false }, hydrateErrors: withoutKey(s.hydrateErrors, id) }));
  void hydrateThread(id);
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
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

/**
 * Cria a conversa e manda a primeira mensagem. A conversa só abre depois de o backend aceitar a mensagem: se ele recusar,
 * devolve `null` (a conversa vazia fica na lista, sem apagar nada) e quem chamou mantém o texto na caixa.
 */
export async function startThread(input: NewThread, text: string, images?: string[], background = false, fastMode?: boolean, onError?: (message: string) => void): Promise<string | null> {
  const { id } = await createFirstThread(input);
  const accepted = await sendToThread(id, text, onError, undefined, images, fastMode);
  if (!accepted) return null;
  firstMessageAccepted(input);
  if (!background) openThread(id);
  return id;
}

/** A conversa criada para a primeira mensagem, por entrada (a chave é o próprio pedido de criação), ainda sem mensagem aceita. */
const unacceptedFirstThreads = new Map<string, string>();

/**
 * Cria a conversa da primeira mensagem. Se a tentativa anterior com a mesma entrada não teve a mensagem aceita, a mesma
 * conversa é reaproveitada: uma recusa não deixa uma conversa vazia a mais a cada tentativa. `reused` diz qual foi o caso.
 */
export async function createFirstThread(input: NewThread): Promise<{ id: string; reused: boolean }> {
  const key = JSON.stringify(input);
  const reusedId = unacceptedFirstThreads.get(key);
  if (reusedId) return { id: reusedId, reused: true };
  const id = await createThread(input);
  unacceptedFirstThreads.set(key, id);
  return { id, reused: false };
}

/** A primeira mensagem foi aceita: a conversa deixa de ser reaproveitada por essa entrada. */
export function firstMessageAccepted(input: NewThread): void {
  unacceptedFirstThreads.delete(JSON.stringify(input));
}

/** Cria a conversa por protocolo sem abri-la nem mandar nada (o time é montado antes de a tela trocar). */
export async function createThread(input: NewThread): Promise<string> {
  const row = await chatThreadCreate(input);
  upsertThread(row);
  useStructured.setState((s) => ({ hydrated: { ...s.hydrated, [row.id]: true } }));
  return row.id;
}

/**
 * Faz a pergunta lateral `id` nascer como cópia da conversa de origem (fork nativo do agente, num ponto estável) antes
 * da primeira mensagem. Sem fork (motor sem suporte, origem em terminal, falha), devolve `excerpt` e o motivo: quem
 * chama manda o recorte do histórico. Nunca lança: uma falha do comando é o recorte com o motivo `failed`.
 */
export async function forkSideChat(id: string): Promise<SideChatForkOutcome> {
  const outcome = await chatSideChatFork(id).catch((): SideChatForkOutcome => ({ mode: "excerpt", reason: "failed" }));
  useStructured.setState((s) => ({
    threads: s.threads.map((row) => row.id === id ? { ...row, forkMode: outcome.mode, forkReason: outcome.reason } : row),
  }));
  return outcome;
}

/**
 * Manda uma mensagem (começa um turno, ou entra no que está em andamento). Resolve `true` só quando o backend aceita;
 * `false` quando recusa (o erro vai para `onError` e para o aviso da conversa). Quem precisa saber se a mensagem saiu
 * espera este resultado antes de limpar a caixa.
 */
export function sendToThread(id: string, text: string, onError?: (message: string) => void, onSent?: () => void, images?: string[], fastMode?: boolean): Promise<boolean> {
  const row = useStructured.getState().threads.find((thread) => thread.id === id);
  const effectiveFastMode = fastMode ?? (row ? fastModeForThread(row) : false);
  if (text.trim() || images?.length) unsnoozeConversation(threadKey(id));
  patchLive(id, (live) => ({ ...live, phase: "working", error: null }));
  const send = (outgoing: string): Promise<boolean> =>
    // `onSent` só depois de o backend aceitar a mensagem; `onError` só se ele a recusar.
    chatThreadSend(id, outgoing, images, effectiveFastMode).then(() => {
      onSent?.();
      return true;
    }, (e) => {
      onError?.(String(e));
      patchLive(id, (live) => ({ ...live, phase: "idle", error: String(e) }));
      return false;
    });
  // Claude e Cursor precisam receber `/nome`; no composer os dois usam a menção portátil `$nome`.
  if ((row?.agentId === "claude-code" || row?.agentId === "cursor") && text.includes("$")) {
    return useAgentSkillsStore.getState().load(row.cwd, row.agentId, id)
      .catch(() => [])
      .then((skills) => send(dispatchSkillMentions(row.agentId, text, skills.map((skill) => skill.name))));
  }
  return send(text);
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

/**
 * Responde um pedido do protocolo. O pedido só sai da tela depois de o backend confirmar. Falha (erro, ou `false` do
 * backend, que é "o pedido já não está aberto") não é sucesso: o pedido fica na conversa e o aviso vai ao mapa
 * `answerErrors`, que sobrevive a uma releitura do fio. Devolve `true` quando o backend confirmou.
 */
/** Pedidos com a resposta a caminho do backend: uma segunda resposta ao mesmo pedido, enquanto isso, não sai. */
const answersInFlight = new Set<string>();

/** Uma falha de resposta: o pedido fica na conversa, e o aviso vai ao mapa `answerErrors`, fora de `requests`. */
function failAnswer(requestId: string): void {
  useStructured.setState((s) => ({ answerErrors: { ...s.answerErrors, [requestId]: "chat.permission.answerFailed" } }));
}

export async function answerRequest(threadId: string, requestId: string, choice: string): Promise<boolean> {
  if (answersInFlight.has(requestId)) return false;
  answersInFlight.add(requestId);
  try {
    unsnoozeConversation(threadKey(threadId));
    let confirmed: boolean;
    try {
      confirmed = await chatRequestAnswer(requestId, choice);
    } catch (e) {
      patchLive(threadId, (live) => ({ ...live, error: String(e) }));
      failAnswer(requestId);
      return false;
    }
    if (confirmed !== true) {
      failAnswer(requestId);
      return false;
    }
    // Confirmada: o pedido sai da lista, e `patchLive` tira o aviso junto (ver `forgetGoneAnswerErrors`).
    patchLive(threadId, (live) => ({ ...live, requests: live.requests.filter((r) => r.id !== requestId) }));
    return true;
  } finally {
    answersInFlight.delete(requestId);
  }
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
