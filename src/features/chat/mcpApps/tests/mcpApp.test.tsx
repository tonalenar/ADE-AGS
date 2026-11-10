// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "pt-BR" },
  }),
}));

import { ToolRow } from "@/features/chat/timeline/ConversationTimeline";
import type { TimelineItem } from "@/features/chat/timeline/types";
import { McpAppBoundary, McpAppFrame } from "../McpAppFrame";
import { createMcpAppSession, decideAppMessage, MCP_APP_UNSUPPORTED } from "../mcpAppBridge";
import { MCP_APP_SANDBOX, mcpAppSrcdoc } from "../mcpAppDocument";
import { parseMcpAppResource } from "../mcpAppResource";

const HTML = "<p id=\"app\">clima</p>";

/** Recurso como o `resources/read` do ext-apps devolve em `contents[]`. */
function contentsResult(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    contents: [{
      uri: "ui://weather-server/dashboard-template",
      mimeType: "text/html;profile=mcp-app",
      text: HTML,
      ...extra,
    }],
  });
}

/** O mesmo recurso aninhado no resultado da ferramenta (`content[].resource`). */
function embeddedResult(): string {
  return JSON.stringify({
    content: [{
      type: "resource",
      resource: {
        uri: "ui://weather-server/dashboard-template",
        mimeType: "text/html;profile=mcp-app",
        text: HTML,
      },
    }],
  });
}

let root: Root | null = null;
let host: HTMLDivElement;

async function render(node: React.ReactNode) {
  await act(async () => {
    root!.render(node);
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  host.remove();
});

describe("recurso de app MCP", () => {
  it("reconhece o recurso ui:// em contents[] e em content[].resource", () => {
    expect(parseMcpAppResource(contentsResult())?.uri).toBe("ui://weather-server/dashboard-template");
    expect(parseMcpAppResource(embeddedResult())?.html).toBe(HTML);
  });

  it("lê o HTML em blob base64 quando não há text", () => {
    const blob = btoa("<p>blob</p>");
    const raw = JSON.stringify({
      contents: [{ uri: "ui://srv/app", mimeType: "text/html;profile=mcp-app", blob }],
    });
    expect(parseMcpAppResource(raw)?.html).toBe("<p>blob</p>");
  });

  it("ignora texto comum, mime errado e uri que não é ui://", () => {
    expect(parseMcpAppResource("só texto")).toBeNull();
    expect(parseMcpAppResource(JSON.stringify({
      contents: [{ uri: "ui://srv/app", mimeType: "text/html", text: HTML }],
    }))).toBeNull();
    expect(parseMcpAppResource(JSON.stringify({
      contents: [{ uri: "https://example.com/app", mimeType: "text/html;profile=mcp-app", text: HTML }],
    }))).toBeNull();
  });

  it("não trata só o resourceUri como app: sem HTML não há o que mostrar", () => {
    const raw = JSON.stringify({
      content: [{ type: "text", text: "15:04" }],
      _meta: { ui: { resourceUri: "ui://get-time/mcp-app.html" } },
    });
    expect(parseMcpAppResource(raw)).toBeNull();
  });
});

describe("contêiner isolado", () => {
  it("monta srcdoc com CSP estrita, tema e sem rede externa", () => {
    const doc = mcpAppSrcdoc(HTML, { dark: true, declarations: "--color-gray-50:#fff;--font-sans:sans-serif" });
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("connect-src 'none'");
    expect(doc).toContain("navigate-to 'none'");
    expect(doc).toContain("frame-src 'none'");
    expect(doc).toContain("form-action 'none'");
    expect(doc).not.toMatch(/https:/);
    expect(doc).toContain("--color-gray-50:#fff");
    expect(doc).toContain('data-ade-scheme="dark"');
    expect(doc).toContain('id="app"');
  });

  it("tira meta http-equiv e base do HTML do app para não afrouxar a CSP", () => {
    const doc = mcpAppSrcdoc('<meta http-equiv="Content-Security-Policy" content="default-src *"><base href="https://evil.test/"><p>ok</p>');
    expect(doc).not.toContain("default-src *");
    expect(doc).not.toContain("<base");
    expect(doc).toContain("connect-src 'none'");
  });

  it("a timeline troca o resultado por um iframe sem allow-same-origin", async () => {
    const tool: TimelineItem = { kind: "tool", id: "mcp-1", tool: "other", label: "clima", status: "done", output: embeddedResult() };
    await render(<ToolRow tool={tool} />);
    const iframe = host.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("sandbox")).toBe(MCP_APP_SANDBOX);
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe?.getAttribute("sandbox")?.split(/\s+/)).not.toContain("allow-same-origin");
    expect(iframe?.getAttribute("srcdoc")).toContain("connect-src 'none'");
    expect(host.querySelector("pre")).toBeNull();
  });
});

describe("ciclo de vida", () => {
  function sessionHarness() {
    const logs: { method: string; note: string }[] = [];
    const posts: unknown[] = [];
    let stopped = false;
    const frame = { postMessage: (data: unknown) => { posts.push(data); } };
    const listeners = new Set<(ev: MessageEvent) => void>();
    const target = {
      addEventListener: (_type: string, fn: EventListener) => { listeners.add(fn as (ev: MessageEvent) => void); },
      removeEventListener: (_type: string, fn: EventListener) => { listeners.delete(fn as (ev: MessageEvent) => void); },
    };
    const session = createMcpAppSession({
      host: target,
      getFrameWindow: () => frame as unknown as Window,
      onStop: () => { stopped = true; },
      onLog: (entry) => { logs.push(entry); },
    });
    return {
      logs, posts, frame,
      get stopped() { return stopped; },
      listenerCount: () => listeners.size,
      emit(data: unknown) {
        for (const fn of [...listeners]) fn({ data, source: frame } as MessageEvent);
      },
      close: () => session.close(),
    };
  }

  it("para o app quando ele avisa que vai sair da página", () => {
    const box = sessionHarness();
    expect(decideAppMessage({ source: "ags-mcp-app", kind: "navigate-away" })).toEqual({ kind: "stop" });
    box.emit({ source: "ags-mcp-app", kind: "navigate-away" });
    expect(box.stopped).toBe(true);
  });

  it("a navegação para fora desmonta o iframe na timeline", async () => {
    await render(<McpAppFrame html={'<a href="https://example.com/sai">sai</a>'} />);
    const iframe = host.querySelector("iframe");
    expect(iframe).not.toBeNull();
    const ev = new MessageEvent("message", { data: { source: "ags-mcp-app", kind: "navigate-away" } });
    Object.defineProperty(ev, "source", { value: iframe?.contentWindow });
    await act(async () => {
      window.dispatchEvent(ev);
    });
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).toContain("chat.mcpApp.stopped");
  });

  it("recusa chamar ferramenta, postar mensagem e tela cheia, e registra não suportado ainda", () => {
    const box = sessionHarness();
    const pedidos = [
      { id: 1, method: "tools/call" },
      { id: "msg", method: "ui/message" },
      { id: 3, method: "ui/request-display-mode" },
    ];
    for (const pedido of pedidos) {
      const data = { jsonrpc: "2.0", id: pedido.id, method: pedido.method, params: {} };
      expect(decideAppMessage(data)).toMatchObject({
        kind: "refuse",
        method: pedido.method,
        note: MCP_APP_UNSUPPORTED,
        response: { jsonrpc: "2.0", id: pedido.id, error: { code: -32601, message: MCP_APP_UNSUPPORTED } },
      });
      box.emit(data);
    }
    expect(box.stopped).toBe(false);
    expect(box.logs.map((l) => l.method)).toEqual(["tools/call", "ui/message", "ui/request-display-mode"]);
    expect(box.logs.every((l) => l.note === "não suportado ainda")).toBe(true);
    expect(box.posts).toHaveLength(3);
    expect(box.posts.every((p) => (p as { error: { message: string } }).error.message === "não suportado ainda")).toBe(true);
  });

  it("não responde a lixo nem deixa um erro do callback derrubar o host", () => {
    const frame = { postMessage: () => { throw new Error("canal fechado"); } };
    const listeners = new Set<(ev: MessageEvent) => void>();
    const session = createMcpAppSession({
      host: {
        addEventListener: (_t: string, fn: EventListener) => { listeners.add(fn as (ev: MessageEvent) => void); },
        removeEventListener: (_t: string, fn: EventListener) => { listeners.delete(fn as (ev: MessageEvent) => void); },
      },
      getFrameWindow: () => frame as unknown as Window,
      onStop: () => { throw new Error("parada"); },
      onLog: () => { throw new Error("log"); },
    });
    expect(() => {
      for (const fn of listeners) fn({ data: { jsonrpc: "2.0", id: 1, method: "tools/call" }, source: frame } as unknown as MessageEvent);
    }).not.toThrow();
    expect(decideAppMessage(null)).toEqual({ kind: "ignore" });
    expect(decideAppMessage("oi")).toEqual({ kind: "ignore" });
    session.close();
  });

  it("desmontar tira o listener e ignora mensagens depois", () => {
    const box = sessionHarness();
    expect(box.listenerCount()).toBe(1);
    box.close();
    expect(box.listenerCount()).toBe(0);
    box.emit({ jsonrpc: "2.0", id: 9, method: "tools/call" });
    expect(box.posts).toHaveLength(0);
    expect(box.logs).toHaveLength(0);
  });

  it("desmontar o quadro tira o listener da janela", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    await render(<McpAppFrame html="<p>oi</p>" />);
    const added = add.mock.calls.filter((c) => c[0] === "message").length;
    expect(added).toBeGreaterThan(0);
    await act(async () => {
      root?.unmount();
    });
    root = null;
    const removed = remove.mock.calls.filter((c) => c[0] === "message").length;
    expect(removed).toBeGreaterThanOrEqual(added);
    add.mockRestore();
    remove.mockRestore();
  });

  it("um erro de render do app não apaga o resto da timeline", async () => {
    function Boom(): React.JSX.Element {
      throw new Error("app quebrado");
    }
    await render(
      <div>
        <McpAppBoundary><Boom /></McpAppBoundary>
        <p>timeline segue</p>
      </div>,
    );
    expect(host.textContent).toContain("timeline segue");
    expect(host.textContent).toContain("chat.mcpApp.failed");
  });
});
