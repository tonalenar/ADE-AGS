import { stallMessage, type PageStallFacts } from "./pageErrors";
import type { AppMessage, PageCommand, PageOp, PageReply } from "./protocol";
import { windowSince } from "./windowBeat";

/** O que o navegador sabe da carga, para explicar uma falta de resposta (ver `pageErrors.ts`). */
export interface LoadState { loadCount: number; ready: boolean; navigatingForMs: number | null }

/** Las órdenes que pueden hacer navegar a la página: si el documento cambia antes de que
 *  contesten, es que funcionaron. */
const MAY_NAVIGATE = new Set<PageOp>(["click", "press", "type", "select"]);

interface Pending {
  op: PageOp;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Las órdenes en vuelo hacia el runtime de una página, cada una esperando su respuesta.
 *
 * `postMessage` no tiene respuesta: se manda con un id y se espera un `page:reply` con el
 * mismo. Si la página no contesta —navegó a otro sitio, se colgó, el runtime no se
 * inyectó— el tope corta en vez de dejar al agente esperando para siempre.
 */
export class PageChannel {
  private pending = new Map<string, Pending>();

  constructor(
    /** A página do iframe (`postMessage`), ou um transporte próprio (`post`: o Chrome real, pelo CDP). */
    private readonly target: () => { window: Window | null; origin: string } | { post: (message: AppMessage) => void } | null,
    private readonly loadState: () => LoadState = () => ({ loadCount: 1, ready: true, navigatingForMs: null }),
  ) {}

  run(command: PageCommand, timeoutMs = 10_000): Promise<unknown> {
    const target = this.target();
    if (!target || ("window" in target && !target.window)) return Promise.reject(new Error("Não há nenhuma página carregada no navegador."));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const window = windowSince(startedAt);
        const facts: PageStallFacts = {
          timeoutMs,
          hidden: window.hiddenMs > 0 || (typeof document !== "undefined" && document.hidden),
          lagMaxMs: window.lagMaxMs,
          ...this.loadState(),
        };
        reject(new Error(stallMessage(facts)));
      }, timeoutMs);
      this.pending.set(id, { op: command.op, resolve, reject, timer });
      const message = { source: "ade-ags", type: "page:run", id, command } satisfies AppMessage;
      if ("post" in target) target.post(message);
      else target.window!.postMessage(message, target.origin);
    });
  }

  reply(reply: PageReply): void {
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(reply.id);
    if (reply.ok) pending.resolve(reply.result);
    else pending.reject(new Error(reply.error));
  }

  /** Cargó otro documento: lo que esperaba respuesta del anterior no la va a tener. */
  documentChanged(url: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (MAY_NAVIGATE.has(pending.op)) pending.resolve({ navigated: true, url });
      else pending.reject(new Error("La página cambió mientras se leía; volvé a intentarlo."));
    }
  }

  dispose(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Se cerró la tab del navegador."));
    }
    this.pending.clear();
  }
}
