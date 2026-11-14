// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve([]) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));

import { requestTimelineFollow } from "../store";
import { TimelineView } from "../timeline/ConversationTimeline";
import type { PendingSend } from "../timeline/pending";
import type { TimelineItem } from "../timeline/types";

// O happy-dom não faz layout. Aqui a lista tem uma altura (`content`) e uma janela visível (`VIEW`); o `scrollTop`
// fica limitado ao que sobra para rolar, e cada escrita nele dispara o evento de rolagem, como no navegador.
// O scroll suave é uma fila de passos que o próprio teste avança (sem timer): cada passo anda um pedaço e pode
// fazer a lista crescer, como o texto que chega no meio da animação.
const VIEW = 400;
const SCROLLER = "cc-scroll-hidden";
let content = 0;
let view = VIEW;
let measuredVirtualRows = false;
let working = false;
let streaming = new Set<string>();
let onStep: (() => void) | null = null;
let steps: Array<() => void> = [];
let resizeObservers: Array<{ callback: () => void; targets: Map<Element, number> }> = [];
const tops = new WeakMap<Element, number>();
const isScroller = (el: Element) => el.classList.contains(SCROLLER);
const virtualHeight = () => measuredVirtualRows
  ? (() => {
    const turns = host.querySelector<HTMLElement>("[data-chat-turns-host]");
    if (!turns) return 0;
    const rows = [...turns.querySelectorAll<HTMLElement>("[data-virtual-turn]")].reduce((sum, row) => sum + (row.getBoundingClientRect().height || 0), 0);
    const spacers = [...turns.querySelectorAll<HTMLElement>("[data-chat-virtual-spacer]")].reduce((sum, spacer) => sum + (Number.parseFloat(spacer.style.height) || 0), 0);
    return rows + spacers + Math.max(0, turns.children.length - 1) * 16;
  })()
  : 0;
const maxTop = () => Math.max(0, content + virtualHeight() + 40 - view);
const scroller = () => host.querySelector(`.${SCROLLER}`) as HTMLElement;

function installLayout(): void {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get() { return isScroller(this) ? content + virtualHeight() + 40 : 0; } });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return isScroller(this) ? view : 0; } });
  let smoothSeq = 0;
  let stepping = false;
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() { return isScroller(this) ? (tops.get(this) ?? 0) : 0; },
    set(value: number) {
      if (!isScroller(this)) return;
      if (!stepping) smoothSeq += 1;
      tops.set(this, Math.min(Math.max(0, value), maxTop()));
      this.dispatchEvent(new Event("scroll"));
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, options?: ScrollToOptions) {
      if (!isScroller(this) || typeof options?.top !== "number") return;
      const seq = ++smoothSeq;
      const target = Math.min(Math.max(0, options.top), maxTop());
      const step = () => {
        if (seq !== smoothSeq) return;
        const delta = target - this.scrollTop;
        stepping = true;
        if (Math.abs(delta) < 1) { this.scrollTop = target; stepping = false; return; }
        this.scrollTop += Math.sign(delta) * Math.min(Math.abs(delta), 100);
        stepping = false;
        onStep?.();
        if (seq === smoothSeq) steps.push(step);
      };
      steps.push(step);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      const top = this.hasAttribute("data-chat-turns-host") ? 16 - scroller().scrollTop : 0;
      const height = isScroller(this) ? view : measuredVirtualRows && this.hasAttribute("data-virtual-turn")
        ? 80 + Math.ceil((this.textContent?.length ?? 0) / 48) * 20
        : this === host.querySelector("[data-chat-turns-host]")?.parentElement ? content + virtualHeight() + 40 : 800;
      return { left: 0, right: 800, top, bottom: top + height, width: 800, height, x: 0, y: top, toJSON: () => ({}) };
    },
  });
  globalThis.ResizeObserver = class {
    private observer = { callback: () => {}, targets: new Map<Element, number>() };
    constructor(cb: () => void) { this.observer.callback = cb; resizeObservers.push(this.observer); }
    observe(target: Element) { this.observer.targets.set(target, target.getBoundingClientRect().height); }
    unobserve() { /* nada */ }
    disconnect() { resizeObservers = resizeObservers.filter((observer) => observer !== this.observer); }
  } as never;
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  installLayout();
  content = 0; view = VIEW; measuredVirtualRows = false; working = false; streaming = new Set(); onStep = null; steps = []; resizeObservers = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

const msg = (kind: "user" | "assistant", id: string, text: string): TimelineItem => ({ kind, id, text });
const history: TimelineItem[] = Array.from({ length: 10 }, (_, i) => [msg("user", `u${i}`, `Pergunta ${i}`), msg("assistant", `a${i}`, `Resposta ${i}`)]).flat();
// A pessoa pede algo (abre um turno) e o agente responde com uma fala comprida: é o caso que rola suave até o fim.
const ask = msg("user", "u-nova", "Pode continuar?");
const reply = msg("assistant", "a-nova", "Uma resposta comprida, do tipo que ocupa a tela toda do agente.");
const longHistory: TimelineItem[] = Array.from({ length: 120 }, (_, i) => [
  msg("user", `virtual-u-${i}`, `Pergunta ${i}`),
  msg("assistant", `virtual-a-${i}`, `Resposta ${i}`),
  { kind: "turnEnd" as const, id: `virtual-e-${i}`, durationMs: 1200 },
]).flat();

const render = (items: TimelineItem[], pending: PendingSend[] = [], conversationKey?: string) => act(async () => {
  root.render(<TimelineView items={items} pending={pending} conversationKey={conversationKey} streaming={streaming} loaded working={working} approval={null} live agentLabel="Claude Code" agentId="claude-code" />);
});
/** Roda a animação suave até o fim (cada passo pode fazer o texto crescer, como no navegador). */
const runAnimation = () => act(async () => {
  for (let guard = 0; steps.length > 0 && guard < 500; guard++) steps.shift()!();
});
/** Chega mais texto: a lista cresce e o observador de tamanho avisa. */
const grow = (px: number) => act(async () => {
  content += px;
  notifyResize();
});
const notifyResize = () => {
  let notified = 0;
  for (const observer of resizeObservers) {
    let changed = false;
    for (const [target, previous] of observer.targets) {
      const height = target.getBoundingClientRect().height;
      if (Math.abs(height - previous) >= 1) {
        observer.targets.set(target, height);
        changed = true;
      }
    }
    if (changed) { notified += 1; observer.callback(); }
  }
  return notified;
};

describe("a conversa segue o fim enquanto a pessoa está nele", () => {
  it("monta só a janela visível da timeline longa e troca a janela com a rolagem", async () => {
    content = 30_000;
    await render(longHistory);

    const mounted = () => host.querySelectorAll("[data-virtual-turn]");
    expect(mounted().length).toBe(12);
    act(() => { scroller().scrollTop = 0; });
    expect(mounted().length).toBe(6);
    expect(mounted()[0]?.getAttribute("data-virtual-turn")).toBe("virtual-u-0");
    expect(host.querySelector('[data-chat-virtual-spacer="bottom"]')).not.toBeNull();
  });

  it("acompanha novas respostas no fim virtualizado e preserva a posição quando a pessoa lê acima", async () => {
    content = 30_000;
    await render(longHistory);
    await runAnimation();
    expect(scroller().scrollTop).toBe(maxTop());

    act(() => { scroller().scrollTop = 500; });
    content += 580;
    await render([...longHistory, ask, reply]);
    await runAnimation();
    expect(scroller().scrollTop).toBe(500);

    act(() => { scroller().scrollTop = maxTop(); });
    content += 60;
    await grow(60);
    expect(scroller().scrollTop).toBe(maxTop());
  });

  it("acompanha o streaming virtualizado ao redimensionar a janela, solta o fio ao rolar e volta ao enviar", async () => {
    measuredVirtualRows = true;
    working = true;
    streaming = new Set(["virtual-a-119"]);
    const streamed = [...longHistory];
    const last = streamed.length - 2;
    streamed[last] = { ...streamed[last]!, text: "a resposta já passou de uma linha e agora está perto de cruzar a próxima" };
    await render(streamed, [], "thread:streaming");
    await runAnimation();
    expect(scroller().scrollTop).toBe(maxTop());
    expect(host.querySelector('[data-virtual-turn="virtual-u-119"]')).not.toBeNull();

    // O fim cresce no mesmo DOM virtualizado que o provedor está atualizando.
    const row = host.querySelector<HTMLElement>('[data-virtual-turn="virtual-u-119"]')!;
    const charsToNextLine = 48 - (row.textContent!.length % 48) + 1;
    streamed[last] = { ...streamed[last]!, text: `${streamed[last]!.text}${"x".repeat(charsToNextLine)}` };
    await render(streamed, [], "thread:streaming");
    let notified = 0;
    await act(async () => { notified = notifyResize(); });
    expect(notified).toBeGreaterThan(0);
    expect(scroller().scrollTop).toBe(maxTop());

    // Resize do viewport sem novo render de React também precisa manter o fim visível.
    await act(async () => { view = VIEW - 80; notifyResize(); });
    expect(scroller().scrollTop).toBe(maxTop());

    act(() => { scroller().scrollTop = 500; });
    const before = scroller().scrollTop;
    await act(async () => { view -= 40; notifyResize(); });
    expect(scroller().scrollTop).toBe(before);

    await act(async () => { requestTimelineFollow("thread:streaming"); });
    await runAnimation();
    expect(scroller().scrollTop).toBe(maxTop());
  });

  it("uma mensagem longa do agente no fim não tira o fio do fim: o texto que chega depois continua sendo acompanhado", async () => {
    content = 2000;
    await render(history);
    await runAnimation();
    expect(scroller().scrollTop).toBe(maxTop());

    // Chega a pergunta (80 px) e uma resposta de 500 px; enquanto a rolagem suave leva o fio ao fim, mais 180 px de texto aparecem.
    content += 580;
    let growth = 3;
    onStep = () => { if (growth-- > 0) content += 60; };
    await render([...history, ask, reply]);
    await runAnimation();
    onStep = null;

    // Mais texto chega depois da animação: o fio precisa seguir o fim.
    await grow(60);
    expect(scroller().scrollTop).toBe(maxTop());
  });

  it("quem rolou para cima para ler continua onde está quando chega mensagem nova", async () => {
    content = 2000;
    await render(history);
    await runAnimation();

    scroller().scrollTop = 500;
    content += 380;
    await render([...history, ask, reply]);
    await runAnimation();
    await grow(60);
    expect(scroller().scrollTop).toBe(500);
  });

  it("ResizeObserver durante a rolagem suave (texto chegando em streaming) mantém o fio colado no fim", async () => {
    content = 2000;
    await render(history);
    await runAnimation();
    expect(scroller().scrollTop).toBe(maxTop());

    // Simula o streaming real: cada passo da rolagem suave revela mais texto e dispara o ResizeObserver.
    content += 600;
    let growth = 4;
    onStep = () => {
      if (growth-- > 0) {
        content += 180;
        notifyResize();
      }
    };
    await render([...history, ask, reply]);
    await runAnimation();
    onStep = null;

    await grow(120);
    expect(scroller().scrollTop).toBe(maxTop());
  });

  it("ao enviar mensagem enquanto lia acima, volta a seguir o fim da conversa", async () => {
    content = 2000;
    await render(history);
    await runAnimation();

    scroller().scrollTop = 500;
    expect(scroller().scrollTop).toBe(500);

    content += 240;
    await render(history, [{ id: "p1", text: "Nova mensagem enviada", at: 1, baseline: 0 }]);
    await runAnimation();
    expect(scroller().scrollTop).toBe(maxTop());

    await grow(160);
    expect(scroller().scrollTop).toBe(maxTop());
  });

  it("rolar para cima com a roda do mouse solta o auto-scroll imediatamente", async () => {
    content = 2000;
    await render(history);
    await runAnimation();
    const before = scroller().scrollTop;
    expect(before).toBe(maxTop());

    await act(async () => {
      scroller().dispatchEvent(new WheelEvent("wheel", { deltaY: -40, bubbles: true }));
    });
    await grow(160);
    expect(scroller().scrollTop).toBe(before);
  });

  it("requestTimelineFollow religa o auto-scroll da conversa mesmo sem item pendente", async () => {
    content = 2000;
    await render(history, [], "tab:conv-follow");
    await runAnimation();

    scroller().scrollTop = 500;
    expect(scroller().scrollTop).toBe(500);

    content += 240;
    await act(async () => { requestTimelineFollow("tab:conv-follow"); });
    await runAnimation();
    expect(scroller().scrollTop).toBe(maxTop());
  });
});
