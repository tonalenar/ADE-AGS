/**
 * Carrega o runtime REAL da página (`page/runtime.ts`) num DOM de teste (happy-dom) e fala com ele pelo mesmo canal que a
 * app usa: `postMessage` `page:run` → `page:reply`. É o que deixa testar o comportamento do runtime (guarda, espera,
 * marca de patrocinado…) sem subir o app. Usa-se com `// @vitest-environment happy-dom`.
 */
import { vi } from "vitest";

import type { PageCommand, PageMessage } from "../protocol";

export interface Harness {
  /** Manda uma ordem e espera a resposta (`ok: false` vira uma exceção, como no app). */
  run: (command: PageCommand) => Promise<unknown>;
  /** Tudo que a página mandou à app. */
  sent: PageMessage[];
}

/** Os ouvintes que o runtime anterior deixou na `window`: cada carga do teste os tira antes de pôr o seu. */
let leftovers: [string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined][] = [];

export async function loadRuntime(html: string, options: { fetch?: typeof fetch } = {}): Promise<Harness> {
  document.documentElement.innerHTML = `<head><title>Teste</title></head><body>${html}</body>`;
  delete (window as { __agsPage?: boolean }).__agsPage;
  const sent: PageMessage[] = [];
  const fakeParent = {
    postMessage: (message: PageMessage) => { sent.push(message); },
  };
  Object.defineProperty(window, "parent", { value: fakeParent, configurable: true });
  (globalThis as { __ags_target?: string }).__ags_target = undefined;
  // Sem rede de verdade: o XHR síncrono do frasco de cookies e o fetch não saem do teste.
  const w = window as unknown as Record<string, unknown>;
  for (const name of ['alert', 'confirm', 'prompt']) if (typeof w[name] !== 'function') w[name] = () => undefined;
  // O `fetch` que o runtime embrulha: por omissão nunca responde (e nunca chega a uma porta de verdade).
  window.fetch = options.fetch ?? (() => new Promise<Response>(() => undefined));
  XMLHttpRequest.prototype.open = function () { /* nada */ } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.send = function () { /* nada */ } as typeof XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.setRequestHeader = function () { /* nada */ };
  // Sem layout (happy-dom não calcula): toda caixa mede 100×20 e nada tapa nada.
  const box = { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20, x: 0, y: 0, toJSON: () => ({}) };
  Element.prototype.getBoundingClientRect = () => box as DOMRect;
  Element.prototype.scrollIntoView = () => undefined;
  document.elementFromPoint = () => null;
  for (const [type, fn, opts] of leftovers) window.removeEventListener(type, fn, opts);
  leftovers = [];
  const nativeAdd = window.addEventListener.bind(window);
  window.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
    leftovers.push([type, fn, opts]);
    nativeAdd(type, fn, opts);
  }) as typeof window.addEventListener;
  vi.resetModules();
  await import("../page/runtime");
  window.addEventListener = nativeAdd as typeof window.addEventListener;
  // O primeiro `hello` ensina à página o origem da app.
  window.dispatchEvent(new MessageEvent("message", { data: { source: "ade-ags", type: "hello" }, source: fakeParent as unknown as Window, origin: "http://app.test" }));
  let seq = 0;
  const run = (command: PageCommand): Promise<unknown> => new Promise((resolve, reject) => {
    const id = `t${++seq}`;
    const before = sent.length;
    const poll = () => {
      for (let i = before; i < sent.length; i++) {
        const m = sent[i];
        if (m.type === "page:reply" && m.payload.id === id) {
          if (m.payload.ok) resolve(m.payload.result); else reject(new Error(m.payload.error));
          return;
        }
      }
      setTimeout(poll, 5);
    };
    window.dispatchEvent(new MessageEvent("message", {
      data: { source: "ade-ags", type: "page:run", id, command }, source: fakeParent as unknown as Window, origin: "http://app.test",
    }));
    poll();
  });
  return { run, sent };
}
