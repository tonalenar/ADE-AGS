import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Os campos que todo evento `cc-chat-thread` tem; o resto depende de `type`. */
export interface ThreadEventBase {
  type: string;
  threadId?: string;
}

interface Subscriber {
  handler: (event: never) => void;
  deltas: boolean;
}

const subscribers = new Set<Subscriber>();
let unlisten: UnlistenFn | null = null;
let starting: Promise<void> | null = null;

function dispatch(event: ThreadEventBase) {
  const isDelta = event.type === "delta";
  for (const sub of [...subscribers]) {
    if (isDelta && !sub.deltas) continue;
    try {
      (sub.handler as (e: ThreadEventBase) => void)(event);
    } catch (error) {
      console.error("[chat] consumidor de cc-chat-thread falhou", error);
    }
  }
}

function start() {
  if (unlisten || starting) return;
  starting = listen<ThreadEventBase>("cc-chat-thread", (e) => dispatch(e.payload))
    .then((off) => {
      starting = null;
      if (subscribers.size === 0) off();
      else unlisten = off;
    })
    .catch(() => { starting = null; });
}

/**
 * Escuta `cc-chat-thread` por um listener só, dividido entre os consumidores. Os deltas de texto (um por
 * pedaço de token) só chegam a quem pede `deltas: true`; os outros nunca os veem. Devolve a função que
 * encerra; o último a sair solta o listener do Tauri.
 */
export function onThreadEvent<T extends ThreadEventBase>(handler: (event: T) => void, options: { deltas?: boolean } = {}): () => void {
  const sub: Subscriber = { handler: handler as (event: never) => void, deltas: options.deltas === true };
  subscribers.add(sub);
  start();
  return () => {
    subscribers.delete(sub);
    if (subscribers.size === 0 && unlisten) {
      unlisten();
      unlisten = null;
    }
  };
}
