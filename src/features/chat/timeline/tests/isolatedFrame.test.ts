// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import { DESIGN_SANDBOX } from "@/features/canvas/design/srcdoc";
import { MCP_APP_SANDBOX, mcpAppSrcdoc } from "@/features/chat/mcpApps/mcpAppDocument";
import { renderSrcdoc } from "@/features/renders/model";

import { ISOLATED_FRAME_CSP, ISOLATED_FRAME_SANDBOX } from "../isolatedFrame";
import { visualReplyDocument } from "../VisualReplyPreview";

/** A janela de mentira do guarda: recebe `postMessage` e eventos, e não vaza nada para a janela de teste. */
type GuardWindow = EventTarget & { postMessage: ReturnType<typeof vi.fn> };

/**
 * Roda o script de guarda (o primeiro `<script>` do documento) num documento e numa janela próprios. Assim cada
 * caso tem os seus listeners: o de um guarda não cancela o clique do outro.
 */
function runGuard(doc: string): { root: Document; win: GuardWindow } {
  const script = new DOMParser().parseFromString(doc, "text/html").querySelector("script");
  if (!script?.textContent) throw new Error("o documento não tem script de guarda");
  const root = document.implementation.createHTMLDocument("quadro");
  const win = Object.assign(new EventTarget(), { postMessage: vi.fn() }) as GuardWindow;
  new Function("document", "window", "parent", script.textContent)(root, win, win);
  return { root, win };
}

/** Um clique de verdade (cancelável) no seletor; `true` se o guarda o cancelou. */
function clickPrevented(root: Document, selector: string): boolean {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`sem ${selector}`);
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event.defaultPrevented;
}

const LINKS = `<a id="fora" href="https://exemplo.invalido/">fora</a><a id="ancora" href="#topo">topo</a>`;
const TOP_NAVIGATION_TOKENS = ["allow-top-navigation", "allow-top-navigation-by-user-activation", "allow-same-origin", "allow-popups"];

describe("iframe_nao_navega_para_fora", () => {
  it("a CSP não depende de navigate-to, diretiva que nenhum navegador aplica", () => {
    expect(ISOLATED_FRAME_CSP).not.toContain("navigate-to");
  });

  it("nenhum sandbox do quadro dá navegação de primeiro nível, pop-up nem a origem da ADE", () => {
    for (const sandbox of [ISOLATED_FRAME_SANDBOX, DESIGN_SANDBOX, MCP_APP_SANDBOX]) {
      const tokens = sandbox.split(" ");
      for (const forbidden of TOP_NAVIGATION_TOKENS) expect(tokens, sandbox).not.toContain(forbidden);
    }
  });

  it("um link para fora é cancelado dentro do quadro, nas três superfícies", () => {
    for (const doc of [visualReplyDocument("<p>x</p>"), renderSrcdoc("<p>x</p>", { dark: false, declarations: "" }), mcpAppSrcdoc("<p>x</p>")]) {
      const { root } = runGuard(doc);
      root.body.innerHTML = LINKS;
      expect(clickPrevented(root, "#fora"), doc.slice(0, 160)).toBe(true);
    }
  });

  it("a âncora (#) segue nas prévias de render e de app MCP; a prévia de resposta cancela todo link", () => {
    const quadros: Array<[string, string, boolean]> = [
      ["resposta visual", visualReplyDocument("<p>x</p>"), true],
      ["render", renderSrcdoc("<p>x</p>", { dark: false, declarations: "" }), false],
      ["app MCP", mcpAppSrcdoc("<p>x</p>"), false],
    ];
    for (const [nome, doc, cancelada] of quadros) {
      const { root } = runGuard(doc);
      root.body.innerHTML = LINKS;
      expect(clickPrevented(root, "#ancora"), nome).toBe(cancelada);
    }
  });

  it("o guarda da prévia manda o aviso navigate-away ao pai no beforeunload; o bloqueio do quadro é do pai (visualReplyPreview.test.tsx)", () => {
    const { win } = runGuard(visualReplyDocument("<p>x</p>"));
    win.dispatchEvent(new Event("beforeunload"));
    expect(win.postMessage).toHaveBeenCalledWith({ source: "ags-visual-reply", kind: "navigate-away" }, "*");
  });
});
