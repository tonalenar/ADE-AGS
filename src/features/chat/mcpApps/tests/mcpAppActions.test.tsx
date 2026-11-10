// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "pt-BR" },
  }),
}));
vi.mock("neogestify-ui-components", () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) =>
    createElement("button", { onClick }, children),
}));
// O diálogo real traz o Modal da biblioteca; aqui basta o título, o corpo, o rodapé e o fechar.
vi.mock("@/shared/ui/AppDialog", () => ({
  AppDialog: ({ title, footer, onClose, children }: { title: string; footer: React.ReactNode; onClose: () => void; children: React.ReactNode }) =>
    createElement("div", { role: "dialog", "aria-label": title },
      createElement("button", { "data-close": "", onClick: onClose }, "x"),
      children,
      footer),
}));

import { useAskStore } from "@/features/ask/askStore";
import { useChatStore } from "@/features/chat/store";
import { McpAppFrame, type McpAppFrameProps } from "../McpAppFrame";
import { appMessageOf, appMessageText, createMcpAppHandlers, type McpAppHostDeps, type McpAppToolHost } from "../mcpAppHandlers";
import { createFullscreenGuard, FULLSCREEN_GESTURE_TTL_MS, FULLSCREEN_GUARD_MS } from "../mcpAppFullscreen";

const HTML = "<button id=\"go\">ir</button>";
const ALLOW_MESSAGE = "chat.mcpApp.approval.allowMessage";
const ALLOW_TOOL = "chat.mcpApp.approval.allowTool";
const DENY = "chat.mcpApp.approval.deny";

let root: Root | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  useAskStore.setState({ questions: [] });
  useChatStore.setState({ composerInsert: null, composerInsertQueue: [] });
  await act(async () => {
    root?.unmount();
  });
  root = null;
  host.remove();
});

// ── Utilitários ─────────────────────────────────────────────────────

const iframe = () => host.querySelector("iframe")!;
const appWindow = () => iframe().contentWindow!;
const dialog = () => host.querySelector("[role=dialog]");
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);

async function mount(props: Partial<McpAppFrameProps> = {}) {
  await act(async () => {
    root!.render(<McpAppFrame html={HTML} server="clima" {...props} />);
  });
  const posts = vi.spyOn(appWindow(), "postMessage");
  return { posts, replies: () => posts.mock.calls.map((c) => c[0] as Record<string, unknown>) };
}

async function fromApp(data: unknown) {
  const event = new MessageEvent("message", { data });
  Object.defineProperty(event, "source", { value: appWindow() });
  await act(async () => {
    window.dispatchEvent(event);
  });
}

const request = (id: number, method: string, params: unknown) => ({ jsonrpc: "2.0", id, method, params });
const messageRequest = (id: number, text: string) => request(id, "ui/message", { role: "user", content: { type: "text", text } });

async function click(label: string) {
  const target = button(label);
  expect(target, `botão ${label}`).toBeTruthy();
  await act(async () => {
    target!.click();
  });
}

function focusApp() {
  vi.spyOn(document, "activeElement", "get").mockReturnValue(iframe());
}

const isFullscreen = () => !!host.querySelector(".fixed.inset-0");

// ── A regra dos 5 s (pura) ──────────────────────────────────────────

describe("regra da tela cheia", () => {
  function clock() {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
  }

  it("só abre logo depois de um clique no app, e uma vez por clique", () => {
    const c = clock();
    const guard = createFullscreenGuard(c.now);
    expect(guard.consume()).toBe(false);
    guard.gesture();
    c.advance(200);
    expect(guard.consume()).toBe(true);
    expect(guard.consume()).toBe(false);
  });

  it("o clique no app não vale para um pedido que demora mais que o prazo", () => {
    const c = clock();
    const guard = createFullscreenGuard(c.now);
    guard.gesture();
    c.advance(FULLSCREEN_GESTURE_TTL_MS + 1);
    expect(guard.consume()).toBe(false);
  });

  it("clique ou tecla fora do app nos 5 s anteriores ao clique invalida o pedido", () => {
    const c = clock();
    const guard = createFullscreenGuard(c.now);
    guard.outside();
    c.advance(FULLSCREEN_GUARD_MS - 1);
    guard.gesture();
    expect(guard.consume()).toBe(false);
    // Passados os 5 s, o mesmo gesto vale.
    c.advance(FULLSCREEN_GUARD_MS);
    guard.gesture();
    expect(guard.consume()).toBe(true);
  });

  it("atividade fora do app depois do clique, antes do pedido, também invalida", () => {
    const c = clock();
    const guard = createFullscreenGuard(c.now);
    guard.gesture();
    c.advance(100);
    guard.outside();
    c.advance(100);
    expect(guard.consume()).toBe(false);
  });
});

// ── Política dos handlers (pura) ────────────────────────────────────

describe("política do que o app pode pedir", () => {
  function deps(over: Partial<McpAppHostDeps> = {}) {
    const calls = { approvals: [] as unknown[], composer: [] as string[], executed: [] as unknown[] };
    const toolHost: McpAppToolHost = {
      isReadOnly: (tool) => tool === "consulta",
      call: async (tool, args) => { calls.executed.push([tool, args]); return { ok: true }; },
    };
    const base: McpAppHostDeps = {
      server: "clima",
      requestApproval: async (req) => { calls.approvals.push(req); return "approved"; },
      toolHost,
      postToComposer: (text) => { calls.composer.push(text); },
      enterFullscreen: () => false,
      exitFullscreen: () => undefined,
      ...over,
    };
    return { calls, handlers: createMcpAppHandlers(base) };
  }

  it("tools/call: ferramenta que não é somente leitura pede aprovação e, concedida, executa", async () => {
    const { calls, handlers } = deps();
    const out = await handlers["tools/call"]!({ name: "grava", arguments: { id: 7 } });
    expect(out).toEqual({ result: { ok: true } });
    expect(calls.approvals).toEqual([{ kind: "tool", server: "clima", tool: "grava", args: JSON.stringify({ id: 7 }, null, 2) }]);
    expect(calls.executed).toEqual([["grava", { id: 7 }]]);
  });

  it("tools/call negado: o app recebe erro e nada executa", async () => {
    const { calls, handlers } = deps({ requestApproval: async () => "denied" });
    const out = await handlers["tools/call"]!({ name: "grava", arguments: {} });
    expect(out).toMatchObject({ error: { code: -32000 } });
    expect(calls.executed).toEqual([]);
  });

  it("tools/call somente leitura roda sem diálogo", async () => {
    const { calls, handlers } = deps();
    expect(await handlers["tools/call"]!({ name: "consulta" })).toEqual({ result: { ok: true } });
    expect(calls.approvals).toEqual([]);
    expect(calls.executed).toEqual([["consulta", {}]]);
  });

  it("tools/call com outro pedido já aguardando aprovação recebe erro, sem executar", async () => {
    const { calls, handlers } = deps({ requestApproval: async () => "busy" });
    expect(await handlers["tools/call"]!({ name: "grava" })).toMatchObject({ error: { code: -32001 } });
    expect(calls.executed).toEqual([]);
  });

  it("tools/call com parâmetros inválidos não pede aprovação", async () => {
    const { calls, handlers } = deps();
    for (const params of [null, {}, { name: "" }, { name: 3 }, { name: "x".repeat(201) }, { name: "a", arguments: [] }, { name: "a", arguments: "x" }]) {
      expect(await handlers["tools/call"]!(params)).toMatchObject({ error: { code: -32602 } });
    }
    expect(calls.approvals).toEqual([]);
  });

  it("sem toolHost não existe handler de ferramenta: a ponte segue recusando", () => {
    const { handlers } = deps({ toolHost: undefined });
    expect(handlers["tools/call"]).toBeUndefined();
    expect(handlers["ui/message"]).toBeDefined();
  });

  it("ui/message pede aprovação mesmo quando o servidor marca tudo como somente leitura", async () => {
    const readOnly: McpAppToolHost = { isReadOnly: () => true, call: async () => ({}) };
    const { calls, handlers } = deps({ toolHost: readOnly });
    await handlers["ui/message"]!({ role: "user", content: [{ type: "text", text: "oi" }] });
    expect(calls.approvals).toEqual([{ kind: "message", server: "clima", text: "oi" }]);
  });

  it("ui/message aprovada vai ao composer marcada como do app; negada não vai", async () => {
    const aprovada = deps();
    expect(await aprovada.handlers["ui/message"]!({ role: "user", content: { type: "text", text: "  quero o relatório  " } })).toEqual({ result: {} });
    expect(aprovada.calls.composer).toEqual([appMessageText("clima", "quero o relatório")]);
    expect(aprovada.calls.composer[0]).toContain("App MCP");
    const negada = deps({ requestApproval: async () => "denied" });
    expect(await negada.handlers["ui/message"]!({ role: "user", content: { type: "text", text: "oi" } })).toMatchObject({ error: { code: -32000 } });
    expect(negada.calls.composer).toEqual([]);
  });

  it("ui/message só aceita texto: sem texto, vazio ou enorme não chega nem ao diálogo", async () => {
    const { calls, handlers } = deps();
    for (const params of [null, {}, { content: { type: "image", data: "x" } }, { content: { type: "text", text: "  " } }, { content: { type: "text", text: "a".repeat(4_001) } }]) {
      expect(await handlers["ui/message"]!(params)).toMatchObject({ error: { code: -32602 } });
    }
    expect(calls.approvals).toEqual([]);
    expect(appMessageOf({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] })).toBe("a\nb");
  });

  it("tela cheia: sem clique válido o app recebe inline, e o pedido inline sempre sai da tela cheia", async () => {
    const exit = vi.fn();
    const { handlers } = deps({ enterFullscreen: () => false, exitFullscreen: exit });
    expect(await handlers["ui/request-display-mode"]!({ mode: "fullscreen" })).toEqual({ result: { mode: "inline" } });
    expect(await handlers["ui/request-display-mode"]!({ mode: "pip" })).toEqual({ result: { mode: "inline" } });
    expect(await handlers["ui/request-display-mode"]!({ mode: "inline" })).toEqual({ result: { mode: "inline" } });
    expect(exit).toHaveBeenCalledTimes(1);
    const ok = deps({ enterFullscreen: () => true });
    expect(await ok.handlers["ui/request-display-mode"]!({ mode: "fullscreen" })).toEqual({ result: { mode: "fullscreen" } });
  });
});

// ── No quadro da timeline ───────────────────────────────────────────

describe("aprovação humana no quadro", () => {
  it("ui/message abre o diálogo fora do iframe, mostra servidor e texto, e aprovada põe no composer sem enviar", async () => {
    const postToComposer = vi.fn();
    const { replies } = await mount({ postToComposer });
    await fromApp(messageRequest(5, "manda o resumo"));
    const box = dialog();
    expect(box).not.toBeNull();
    expect(box!.closest("iframe")).toBeNull();
    expect(iframe().getAttribute("srcdoc")).not.toContain("role=\"dialog\"");
    expect(box!.querySelector("[data-approval=server]")?.textContent).toBe("clima");
    expect(box!.querySelector("[data-approval=body]")?.textContent).toBe("manda o resumo");
    expect(replies()).toEqual([]);
    expect(postToComposer).not.toHaveBeenCalled();

    await click(ALLOW_MESSAGE);
    expect(postToComposer).toHaveBeenCalledTimes(1);
    expect(postToComposer.mock.calls[0]![0]).toBe(appMessageText("clima", "manda o resumo"));
    expect(replies()).toEqual([{ jsonrpc: "2.0", id: 5, result: {} }]);
    expect(dialog()).toBeNull();
  });

  it("o texto aprovado entra no composer da conversa pela fila do chat, marcado como do app", async () => {
    await mount();
    await fromApp(messageRequest(1, "oi do app"));
    await click(ALLOW_MESSAGE);
    const fila = useChatStore.getState().composerInsertQueue;
    expect(fila.map((i) => i.text)).toEqual([appMessageText("clima", "oi do app")]);
  });

  it("ui/message negada ou fechada devolve erro ao app e nada vai ao composer", async () => {
    const postToComposer = vi.fn();
    const { replies } = await mount({ postToComposer });
    await fromApp(messageRequest(1, "a"));
    await click(DENY);
    await fromApp(messageRequest(2, "b"));
    await act(async () => {
      (dialog()!.querySelector("[data-close]") as HTMLButtonElement).click();
    });
    expect(postToComposer).not.toHaveBeenCalled();
    expect(replies().map((r) => [r.id, (r.error as { code: number }).code])).toEqual([[1, -32000], [2, -32000]]);
    expect(dialog()).toBeNull();
  });

  it("um segundo pedido enquanto há aprovação aberta recebe erro, sem empilhar diálogos", async () => {
    const { replies } = await mount();
    await fromApp(messageRequest(1, "a"));
    await fromApp(messageRequest(2, "b"));
    expect(host.querySelectorAll("[role=dialog]")).toHaveLength(1);
    expect(replies()).toMatchObject([{ id: 2, error: { code: -32001 } }]);
  });

  it("desmontar o quadro com aprovação aberta nega sem executar nada", async () => {
    const postToComposer = vi.fn();
    await mount({ postToComposer });
    await fromApp(messageRequest(1, "a"));
    await act(async () => {
      root?.unmount();
    });
    root = createRoot(host);
    expect(postToComposer).not.toHaveBeenCalled();
  });

  it("sem toolHost, tools/call segue recusado com -32601 e sem diálogo", async () => {
    const { replies } = await mount();
    await fromApp(request(3, "tools/call", { name: "grava", arguments: {} }));
    expect(dialog()).toBeNull();
    expect(replies()).toMatchObject([{ id: 3, error: { code: -32601, message: "não suportado ainda" } }]);
  });

  it("com toolHost: ferramenta comum mostra servidor, ferramenta e argumentos; concedida executa e negada não", async () => {
    const call = vi.fn(async () => ({ content: [{ type: "text", text: "feito" }] }));
    const toolHost: McpAppToolHost = { isReadOnly: (tool) => tool === "consulta", call };
    const { replies } = await mount({ toolHost });

    await fromApp(request(1, "tools/call", { name: "grava", arguments: { id: 9 } }));
    const box = dialog()!;
    expect(box.querySelector("[data-approval=server]")?.textContent).toBe("clima");
    expect(box.querySelector("[data-approval=tool]")?.textContent).toBe("grava");
    expect(box.querySelector("[data-approval=body]")?.textContent).toContain("\"id\": 9");
    expect(call).not.toHaveBeenCalled();
    await click(ALLOW_TOOL);
    expect(call).toHaveBeenCalledWith("grava", { id: 9 });
    expect(replies()).toMatchObject([{ id: 1, result: { content: [{ type: "text", text: "feito" }] } }]);

    await fromApp(request(2, "tools/call", { name: "apaga", arguments: {} }));
    await click(DENY);
    expect(call).toHaveBeenCalledTimes(1);
    expect(replies()[1]).toMatchObject({ id: 2, error: { code: -32000 } });

    // Somente leitura: sem diálogo, direto.
    await fromApp(request(3, "tools/call", { name: "consulta", arguments: {} }));
    expect(dialog()).toBeNull();
    expect(call).toHaveBeenCalledTimes(2);
    expect(replies()[2]).toMatchObject({ id: 3, result: { content: [{ text: "feito" }] } });
  });
});

describe("tela cheia no quadro", () => {
  async function mountWithClock() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T10:00:00Z"));
    return mount();
  }
  const clickInApp = () => fromApp({ source: "ags-mcp-app", kind: "user-gesture" });
  const askFullscreen = (id: number) => fromApp(request(id, "ui/request-display-mode", { mode: "fullscreen" }));
  const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

  it("sem clique dentro do app, o pedido de tela cheia não abre", async () => {
    const { replies } = await mountWithClock();
    await askFullscreen(1);
    expect(isFullscreen()).toBe(false);
    expect(replies()).toEqual([{ jsonrpc: "2.0", id: 1, result: { mode: "inline" } }]);
  });

  it("clique dentro do app (quadro em foco) e pedido: abre, no mesmo iframe e sem recarregar", async () => {
    const { replies } = await mountWithClock();
    const before = iframe();
    focusApp();
    await clickInApp();
    await askFullscreen(1);
    expect(isFullscreen()).toBe(true);
    expect(iframe()).toBe(before);
    expect(replies()).toEqual([{ jsonrpc: "2.0", id: 1, result: { mode: "fullscreen" } }]);
  });

  it("um app que só posta o aviso de clique, sem o quadro em foco, não abre a tela cheia", async () => {
    await mountWithClock();
    await clickInApp();
    await askFullscreen(1);
    expect(isFullscreen()).toBe(false);
  });

  it("clique ou tecla em outro lugar da ADE nos 5 s anteriores invalida o clique no app", async () => {
    await mountWithClock();
    focusApp();
    await act(async () => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    advance(1_000);
    await clickInApp();
    await askFullscreen(1);
    expect(isFullscreen()).toBe(false);

    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    });
    advance(FULLSCREEN_GUARD_MS - 1);
    await clickInApp();
    await askFullscreen(2);
    expect(isFullscreen()).toBe(false);

    // Passados os 5 s sem atividade fora, o clique vale.
    advance(FULLSCREEN_GUARD_MS);
    await clickInApp();
    await askFullscreen(3);
    expect(isFullscreen()).toBe(true);
  });

  async function openFullscreen() {
    const mounted = await mountWithClock();
    focusApp();
    await clickInApp();
    await askFullscreen(1);
    expect(isFullscreen()).toBe(true);
    return mounted;
  }

  it("Escape fora do app devolve o app à conversa; outra tecla não", async () => {
    await openFullscreen();
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    });
    expect(isFullscreen()).toBe(true);
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(isFullscreen()).toBe(false);
  });

  it("o botão de canto devolve o app à conversa", async () => {
    await openFullscreen();
    await click("chat.mcpApp.exitFullscreen");
    expect(isFullscreen()).toBe(false);
    expect(button("chat.mcpApp.exitFullscreen")).toBeUndefined();
  });

  it("uma aprovação pendente devolve o app à conversa, e o diálogo aparece", async () => {
    await openFullscreen();
    const before = iframe();
    await fromApp(messageRequest(2, "oi"));
    expect(isFullscreen()).toBe(false);
    expect(dialog()).not.toBeNull();
    expect(iframe()).toBe(before);
  });

  it("outro diálogo da ADE esperando a pessoa também devolve o app, e impede de abrir", async () => {
    await openFullscreen();
    await act(async () => {
      useAskStore.getState().add({ id: "q", question: "?", options: [], from: "agente", fromId: "t", expiresAt: Date.now() + 60_000, resolve: () => undefined });
    });
    expect(isFullscreen()).toBe(false);
    focusApp();
    advance(FULLSCREEN_GUARD_MS + 1);
    await clickInApp();
    await askFullscreen(5);
    expect(isFullscreen()).toBe(false);
  });

  it("o app pedindo inline volta à conversa", async () => {
    const { replies } = await openFullscreen();
    await fromApp(request(9, "ui/request-display-mode", { mode: "inline" }));
    expect(isFullscreen()).toBe(false);
    expect(replies()[replies().length - 1]).toEqual({ jsonrpc: "2.0", id: 9, result: { mode: "inline" } });
  });
});
