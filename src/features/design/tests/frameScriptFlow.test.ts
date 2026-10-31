// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";

import { FRAME_MSG, FRAME_SCRIPT, HOST_MSG, studioSrcdoc } from "../frameBridge";

/** Uma prancheta como as do teste: documento completo, estático, com CSS próprio e links .dc.html. */
const BOARD = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Thread</title>
<style>*{outline:none!important}body{margin:0;font-family:sans-serif}</style></head>
<body><div class="app"><header><h1>Olá <b>mundo</b></h1><p>texto</p></header>
<main><a id="go" href="Main.dc.html">Ir</a><a id="ext" href="https://exemplo.com">Fora</a></main></div></body></html>`;

const posts: Array<Record<string, unknown>> = [];
const last = (kind: string) => [...posts].reverse().find((m) => m.kind === kind);
const host = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent("message", { data: { type: HOST_MSG, ...data }, source: window }));
const el = (s: string) => document.querySelector(s)!;
const click = (target: Element, init: MouseEventInit = {}) => {
  target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, ...init }));
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
};

describe("script injetado numa prancheta com documento completo", () => {
  beforeAll(() => {
    // O srcdoc real: o documento do agente vai dentro do <body> e o nosso script fica no fim do body.
    const parsed = new DOMParser().parseFromString(studioSrcdoc(BOARD), "text/html");
    const scripts = parsed.body.querySelectorAll("script");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].textContent).toContain(FRAME_MSG);
    expect(parsed.body.querySelector("div.app h1")).not.toBeNull();
    scripts[0].remove();
    document.body.innerHTML = parsed.body.innerHTML;
    vi.spyOn(window, "postMessage").mockImplementation(((m: Record<string, unknown>) => { posts.push(m); }) as typeof window.postMessage);
    new Function(FRAME_SCRIPT)();
  });

  it("primeiro clique numa prancheta não selecionada só avisa o ponteiro (o app seleciona a prancheta)", () => {
    host({ kind: "mode", mode: "edit" });
    host({ kind: "selection", active: false, selectors: [] });
    posts.length = 0;
    const ev = click(el("p"));
    expect(ev.defaultPrevented).toBe(true);
    expect(last("pointer")).toBeTruthy();
    expect(last("select")).toBeUndefined();
  });

  it("com a prancheta selecionada, o clique escolhe por níveis e o duplo clique entra no filho e edita o texto", () => {
    host({ kind: "selection", active: true, selectors: [] });
    click(el("p"));
    expect(last("select")).toMatchObject({ selector: "div:nth-of-type(1)", elKind: "other" });
    host({ kind: "selection", active: true, selectors: ["div:nth-of-type(1)"] });
    el("p").dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(last("select")).toMatchObject({ selector: "div:nth-of-type(1) > header:nth-of-type(1)" });
    host({ kind: "selection", active: true, selectors: ["div:nth-of-type(1) > header:nth-of-type(1)"] });
    // Clicar num irmão no mesmo nível escolhe o irmão; Shift soma.
    click(el("main a#go"), { shiftKey: true });
    expect(last("select")).toMatchObject({ selector: "div:nth-of-type(1) > main:nth-of-type(1)", shift: true });
    el("p").dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(last("select")).toMatchObject({ selector: "div:nth-of-type(1) > header:nth-of-type(1) > p:nth-of-type(1)", elKind: "text" });
    host({ kind: "selection", active: true, selectors: ["div:nth-of-type(1) > header:nth-of-type(1) > p:nth-of-type(1)"] });
    el("p").dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(el("p").getAttribute("contenteditable")).toBe("true");
    el("p").innerHTML = "novo";
    el("p").dispatchEvent(new FocusEvent("blur"));
    expect(last("textEdited")).toMatchObject({ selector: "div:nth-of-type(1) > header:nth-of-type(1) > p:nth-of-type(1)", html: "novo" });
    expect(el("p").hasAttribute("contenteditable")).toBe(false);
  });

  it("o destaque é uma camada fora do body: não muda o style dos elementos", () => {
    expect(document.documentElement.querySelector(":scope > [data-ags-overlay]")).not.toBeNull();
    expect(el("p").getAttribute("style")).toBeNull();
    expect(document.body.querySelector("[data-ags-overlay]")).toBeNull();
  });

  it("clicar no fundo solta o elemento", () => {
    posts.length = 0;
    click(document.body);
    expect(last("clearSelect")).toBeTruthy();
  });

  it("roda, pinça (Ctrl) e gesto vão ao app com preventDefault", () => {
    posts.length = 0;
    const pinch = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -4 });
    // O happy-dom ignora ctrlKey no construtor do WheelEvent; o WebKit entrega a pinça assim.
    Object.defineProperty(pinch, "ctrlKey", { value: true });
    el("h1").dispatchEvent(pinch);
    expect(pinch.defaultPrevented).toBe(true);
    expect(last("wheel")).toMatchObject({ ctrl: true, dy: -4 });
    const pan = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 3, deltaY: 7 });
    el("h1").dispatchEvent(pan);
    expect(pan.defaultPrevented).toBe(true);
    expect(last("wheel")).toMatchObject({ ctrl: false, dx: 3, dy: 7 });
    const g = new Event("gesturechange", { cancelable: true });
    Object.assign(g, { scale: 1.5, clientX: 10, clientY: 20 });
    window.dispatchEvent(g);
    expect(g.defaultPrevented).toBe(true);
    expect(last("gesture")).toMatchObject({ phase: "change", scale: 1.5 });
  });

  it("as teclas vão ao app e as do estúdio não fazem a ação nativa", () => {
    posts.length = 0;
    const h = new KeyboardEvent("keydown", { key: "h", bubbles: true, cancelable: true });
    document.body.dispatchEvent(h);
    expect(last("key")).toMatchObject({ key: "h", phase: "down" });
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.body.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    const zoom = new KeyboardEvent("keydown", { key: "0", metaKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(zoom);
    expect(zoom.defaultPrevented).toBe(true);
  });

  it("Play: o link local vira navegação; o externo não sai da prancheta; o Esc continua chegando", () => {
    host({ kind: "mode", mode: "play" });
    posts.length = 0;
    const go = click(el("a#go"));
    expect(go.defaultPrevented).toBe(true);
    expect(last("nav")).toMatchObject({ href: "Main.dc.html" });
    posts.length = 0;
    const ext = click(el("a#ext"));
    expect(ext.defaultPrevented).toBe(true);
    expect(last("nav")).toBeUndefined();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "h", bubbles: true }));
    expect(last("key")).toBeUndefined();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(last("key")).toMatchObject({ key: "Escape" });
  });
});
