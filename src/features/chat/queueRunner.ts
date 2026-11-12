import { shouldFlushQueue } from "./activityModel";
import { sendToConversation } from "./chatActions";
import { useChatLive } from "./liveStore";
import { usePermissions } from "./permissions/permissionsStore";
import { dequeueMessage, enqueueMessage, useChatStore } from "./store";
import { isCompacting } from "./autocompact/model";
import { threadIdOf } from "./structured/model";
import { interruptThread, sendToThread, useStructured } from "./structured/store";
import type { MidTurn } from "./chatModel";

/**
 * A fila do composer (prancheta 13): ⌘⏎ com o agente trabalhando guarda a mensagem; quando o turno
 * acaba (protocolo: a fase volta a ociosa; TUI: o canal diz ociosa), sai a próxima, uma por turno.
 * Um pedido esperando a pessoa segura a fila.
 */

/** Manda a mensagem a uma conversa: a aba (TUI) ou a conversa por protocolo. */
function send(key: string, text: string): void {
  const threadId = threadIdOf(key);
  if (threadId) sendToThread(threadId, text);
  else sendToConversation(key, text);
}

function stateOf(key: string): { working: boolean; waiting: boolean; compacting?: boolean } {
  const threadId = threadIdOf(key);
  if (threadId) {
    const live = useStructured.getState().live[threadId];
    const waiting = (live?.requests.length ?? 0) > 0;
    // Compactando o contexto (autocompact) também é estar ocupado: a mensagem espera e sai quando o aviso fecha.
    return { working: live?.phase === "working" || isCompacting(live?.items ?? [], Date.now()), waiting, compacting: isCompacting(live?.items ?? [], Date.now()) };
  }
  const live = useChatLive.getState();
  const waiting = !!live.question[key] || key in live.awaiting || usePermissions.getState().tui.some((p) => p.tabId === key);
  return { working: live.phase[key] === "working", waiting };
}

/** ⌘⏎: com o agente trabalhando, para a fila; ocioso, sai agora. */
export function queueOrSend(key: string, text: string): void {
  const { working, waiting } = stateOf(key);
  if (working || waiting) enqueueMessage(key, text);
  else send(key, text);
}

/**
 * ⏎ com o agente trabalhando numa conversa por protocolo («enviar agora»). `steer` entrega já, no turno em andamento;
 * `interrupt` (o motor não aceita entrada no meio do turno) põe a mensagem na frente da fila e para o turno: ela sai
 * assim que o turno parar, como o próximo, na mesma sessão. Antes, no Cursor e no Antigravity ela esperava atrás de um
 * turno que podia não acabar, e o Parar a descartava. Devolve o que fez.
 */
export function sendNow(key: string, text: string, midTurn: MidTurn, deliver: () => void): "sent" | "interrupting" | "queued" {
  const threadId = threadIdOf(key);
  const { working, compacting } = stateOf(key);
  // Compactando o contexto: a compactação não é um turno que se guia nem se interrompe; a mensagem espera e sai depois.
  if (threadId && compacting) {
    enqueueMessage(key, text);
    return "queued";
  }
  if (!threadId || !working || midTurn === "steer") {
    deliver();
    return "sent";
  }
  enqueueMessage(key, text, true);
  interruptThread(threadId);
  return "interrupting";
}

let started = false;

/** Liga o despachante da fila (uma vez por janela). */
export function startQueueRunner(): void {
  if (started) return;
  started = true;
  const prev: Record<string, boolean> = {};
  const check = () => {
    const keys = new Set([
      ...Object.keys(useChatStore.getState().queues),
      ...Object.keys(useChatLive.getState().phase),
      ...Object.keys(useStructured.getState().live).map((id) => `thread:${id}`),
    ]);
    for (const key of keys) {
      const { working, waiting } = stateOf(key);
      const queued = useChatStore.getState().queues[key]?.length ?? 0;
      if (shouldFlushQueue(prev[key], working, waiting, queued)) {
        const text = dequeueMessage(key);
        if (text) send(key, text);
      }
      prev[key] = working;
    }
  };
  useChatLive.subscribe(check);
  useStructured.subscribe(check);
  usePermissions.subscribe(check);
}
