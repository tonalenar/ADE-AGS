// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { FRAME_SCRIPT, HOST_MSG, studioSrcdoc } from "../frameBridge";

/** Uma prancheta com formulário: campo de texto, área de texto, botão e um parágrafo. */
const BOARD = `<!doctype html><html><head><title>Form</title></head><body><main>
<input id="nome" value="" /><textarea id="obs"></textarea><button id="ok">Ok</button><p>texto</p></main></body></html>`;

const posts: Array<Record<string, unknown>> = [];
const keyPosts = () => posts.filter((m) => m.kind === "key");
const host = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent("message", { data: { type: HOST_MSG, ...data }, source: window }));
const el = (s: string) => document.querySelector(s) as HTMLElement;
const press = (target: Element, key: string) => {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev;
};

describe("teclas numa prancheta com campos de texto", () => {
  beforeAll(() => {
    const parsed = new DOMParser().parseFromString(studioSrcdoc(BOARD), "text/html");
    parsed.body.querySelectorAll("script").forEach((s) => s.remove());
    document.body.innerHTML = parsed.body.innerHTML;
    vi.spyOn(window, "postMessage").mockImplementation(((m: Record<string, unknown>) => { posts.push(m); }) as typeof window.postMessage);
    new Function(FRAME_SCRIPT)();
  });
  beforeEach(() => { posts.length = 0; });

  it.each(["edit", "play"])("no modo %s, Space, Backspace, Delete e Tab digitados num campo são do campo, não do app", (mode) => {
    host({ kind: "mode", mode });
    el("#nome").focus();
    for (const key of [" ", "Backspace", "Delete", "Tab"]) {
      const ev = press(el("#nome"), key);
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(keyPosts()).toHaveLength(0);
  });

  it("no Play, o Esc sai do Play", () => {
    host({ kind: "mode", mode: "play" });
    press(document.body, "Escape");
    expect(keyPosts()).toContainEqual(expect.objectContaining({ key: "Escape", phase: "down" }));
  });

  it("no Play, se a própria página já tratou o Esc (fechou um diálogo), ele não sai do Play", () => {
    host({ kind: "mode", mode: "play" });
    posts.length = 0;
    const page = (e: KeyboardEvent) => e.preventDefault();
    document.addEventListener("keydown", page);
    press(el("#nome"), "Escape");
    document.removeEventListener("keydown", page);
    expect(keyPosts()).toHaveLength(0);
  });

  it("no Play, o botão direito num campo de texto mantém o menu nativo (colar)", () => {
    host({ kind: "mode", mode: "play" });
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    el("#nome").dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("no Play, o botão direito fora de campo vai ao app (menu da prancheta)", () => {
    host({ kind: "mode", mode: "play" });
    posts.length = 0;
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    el("p").dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(posts).toContainEqual(expect.objectContaining({ kind: "context" }));
  });
});
