// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "pt-BR" } }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(null) }));

// A conversa por protocolo, sem backend: a fase de cada uma e o que o despachante manda e interrompe.
const structured = vi.hoisted(() => ({ sendToThread: vi.fn(), interruptThread: vi.fn() }));
vi.mock("../structured/store", () => {
  const useStructured = create<{ live: Record<string, { phase: string; requests: unknown[] }> }>(() => ({ live: {} }));
  return { useStructured, sendToThread: structured.sendToThread, interruptThread: structured.interruptThread };
});
vi.mock("../chatActions", () => ({ sendToConversation: vi.fn() }));
vi.mock("../liveStore", () => ({ useChatLive: create(() => ({ phase: {}, question: {}, awaiting: {} })) }));
vi.mock("../permissions/permissionsStore", () => ({ usePermissions: create(() => ({ tui: [] })) }));

import { ChatComposer } from "../ChatComposer";
import { midTurnOf, PROTOCOL_AGENTS } from "../chatModel";
import { DEFAULT_CHAT_PREFS, saveChatPrefs } from "../chatPrefs";
import { sendNow, startQueueRunner } from "../queueRunner";
import { dequeueMessage, enqueueMessage, unqueueMessage, updateQueuedMessage, useChatStore } from "../store";
import { useStructured } from "../structured/store";

const KEY = "thread:t1";
// O mock guarda só a fase e os pedidos; o tipo é o da store real, por isso o `as never`.
const setPhase = (p: "working" | "idle") => useStructured.setState({ live: { t1: { phase: p, requests: [] } } } as never);
const phase = (p: "working" | "idle") => act(() => { setPhase(p); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useChatStore.setState({ queues: {} });
  saveChatPrefs({ ...DEFAULT_CHAT_PREFS });
  useStructured.setState({ live: {} });
  structured.sendToThread.mockReset();
  structured.interruptThread.mockReset();
});

describe("o «enviar agora» de cada motor", () => {
  it("Codex e Claude entram no turno; Cursor, Antigravity e OpenCode param o turno", () => {
    expect(midTurnOf("codex")).toBe("steer");
    expect(midTurnOf("claude-code")).toBe("steer");
    expect(midTurnOf("cursor")).toBe("interrupt");
    expect(midTurnOf("antigravity")).toBe("interrupt");
    expect(midTurnOf("opencode")).toBe("interrupt");
    // Todo motor por protocolo diz o que faz; um desconhecido não promete entrar no turno.
    expect(Object.values(PROTOCOL_AGENTS).every((e) => e.midTurn === "steer" || e.midTurn === "interrupt")).toBe(true);
    expect(midTurnOf("outro")).toBe("interrupt");
  });

  it("no motor que entra no turno, a mensagem vai na hora, sem fila nem parar", () => {
    setPhase("working");
    const deliver = vi.fn();
    expect(sendNow(KEY, "olha isso", "steer", deliver)).toBe("sent");
    expect(deliver).toHaveBeenCalledOnce();
    expect(structured.interruptThread).not.toHaveBeenCalled();
    expect(useChatStore.getState().queues[KEY]).toBeUndefined();
  });

  it("no Cursor trabalhando, a mensagem vai na frente da fila, o turno para e ela sai assim que parar", () => {
    startQueueRunner();
    phase("working");
    enqueueMessage(KEY, "depois");
    const deliver = vi.fn();
    expect(sendNow(KEY, "agora sim", "interrupt", deliver)).toBe("interrupting");
    // Antes: ela ia para a fila do backend, atrás de um turno que podia não acabar, e o Parar a descartava.
    expect(deliver).not.toHaveBeenCalled();
    expect(structured.interruptThread).toHaveBeenCalledWith("t1");
    expect(useChatStore.getState().queues[KEY]?.map((m) => [m.text, !!m.now])).toEqual([["agora sim", true], ["depois", false]]);
    // O turno parou: sai a de «agora», uma por turno; a da fila espera o próximo fim.
    phase("idle");
    expect(structured.sendToThread).toHaveBeenCalledTimes(1);
    expect(structured.sendToThread).toHaveBeenCalledWith("t1", "agora sim");
    expect(useChatStore.getState().queues[KEY]?.map((m) => m.text)).toEqual(["depois"]);
  });

  it("sem turno em andamento, o «enviar agora» é o envio de sempre", () => {
    const deliver = vi.fn();
    expect(sendNow(KEY, "oi", "interrupt", deliver)).toBe("sent");
    expect(deliver).toHaveBeenCalledOnce();
    expect(structured.interruptThread).not.toHaveBeenCalled();
  });
});

describe("a fila do composer", () => {
  it("as de «agora» passam na frente das outras, na ordem em que vieram; tirar devolve o texto", () => {
    enqueueMessage(KEY, "a");
    enqueueMessage(KEY, "urgente 1", true);
    enqueueMessage(KEY, "b");
    enqueueMessage(KEY, "urgente 2", true);
    const list = useChatStore.getState().queues[KEY]!;
    expect(list.map((m) => m.text)).toEqual(["urgente 1", "urgente 2", "a", "b"]);
    expect(unqueueMessage(KEY, list[2]!.id)).toBe("a");
    expect(unqueueMessage(KEY, "nao-existe")).toBeNull();
    expect(dequeueMessage(KEY)).toBe("urgente 1");
    expect(useChatStore.getState().queues[KEY]?.map((m) => m.text)).toEqual(["urgente 2", "b"]);
  });

  it("edita no mesmo lugar sem alterar prioridade e ignora itens já consumidos", () => {
    enqueueMessage(KEY, "primeira");
    enqueueMessage(KEY, "agora", true);
    const [urgent, regular] = useChatStore.getState().queues[KEY]!;
    expect(updateQueuedMessage(KEY, regular!.id, "  revisada  ")).toBe(true);
    expect(updateQueuedMessage(KEY, regular!.id, "   ")).toBe(false);
    expect(updateQueuedMessage(KEY, "consumida", "texto")).toBe(false);
    expect(useChatStore.getState().queues[KEY]).toEqual([
      urgent,
      { ...regular, text: "revisada" },
    ]);
  });

  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

  it("edita a mensagem pelo composer, preserva o rascunho e permite cancelar ou remover", async () => {
    enqueueMessage(KEY, "primeira");
    enqueueMessage(KEY, "agora", true);
    const Composer = () => {
      const queue = useChatStore((s) => s.queues[KEY]) ?? [];
      return <ChatComposer placeholder="p" onSubmit={() => undefined} onQueue={() => undefined} queue={queue}
        onUnqueue={(id) => unqueueMessage(KEY, id)} onUpdateQueued={(id, text) => updateQueuedMessage(KEY, id, text)} />;
    };
    await act(async () => { root.render(<Composer />); });
    const rows = () => [...host.querySelectorAll("li[data-queued]")];
    expect(rows().map((r) => [r.getAttribute("data-queued"), r.textContent])).toEqual([
      ["now", "chat.queue.afterStopagora"],
      ["queued", "chat.queue.queuedprimeira"],
    ]);
    const composer = () => host.querySelector("textarea[data-chat-composer]") as HTMLTextAreaElement;
    const typeComposer = async (value: string) => act(async () => {
      const el = composer();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await typeComposer("rascunho");
    // Editar: o texto vai ao composer, enquanto o item continua na fila e recebe realce.
    await act(async () => { (rows()[1]!.querySelector("button[aria-label='chat.queue.edit']") as HTMLButtonElement).click(); });
    expect(composer().value).toBe("primeira");
    expect(rows()[1]!.getAttribute("data-editing")).toBe("true");
    await act(async () => { (rows()[1]!.querySelector("button[aria-label='chat.queue.cancelEdit']") as HTMLButtonElement).click(); });
    expect(composer().value).toBe("rascunho");
    expect(rows()[1]!.getAttribute("data-editing")).toBeNull();
    expect(useChatStore.getState().queues[KEY]?.[1]?.text).toBe("primeira");
    await act(async () => { (rows()[1]!.querySelector("button[aria-label='chat.queue.edit']") as HTMLButtonElement).click(); });
    expect(composer().value).toBe("primeira");
    await typeComposer("revisada");
    await act(async () => { (rows()[1]!.querySelector("button[aria-label='chat.queue.saveEdit']") as HTMLButtonElement).click(); });
    expect(useChatStore.getState().queues[KEY]?.map((m) => m.text)).toEqual(["agora", "revisada"]);
    expect(rows()).toHaveLength(2);
    expect(rows()[1]!.textContent).toContain("revisada");
    expect(composer().value).toBe("rascunho");
    // Tirar: some da fila e da tela.
    await act(async () => { (rows()[0]!.querySelector("button[aria-label='chat.queue.remove']") as HTMLButtonElement).click(); });
    expect(rows()).toHaveLength(1);
    await act(async () => { (rows()[0]!.querySelector("button[aria-label='chat.queue.remove']") as HTMLButtonElement).click(); });
    expect(rows()).toHaveLength(0);
    expect(useChatStore.getState().queues[KEY]).toBeUndefined();
  });

  it("recupera o texto editado quando o runner consome o item durante a edição e o composer estava vazio", async () => {
    enqueueMessage(KEY, "original");
    const Composer = () => {
      const queue = useChatStore((s) => s.queues[KEY]) ?? [];
      return <ChatComposer placeholder="p" onSubmit={() => undefined} onQueue={() => undefined} queue={queue}
        onUnqueue={(id) => unqueueMessage(KEY, id)} onUpdateQueued={(id, text) => updateQueuedMessage(KEY, id, text)} />;
    };
    await act(async () => { root.render(<Composer />); });
    const row = () => host.querySelector("li[data-queued]")!;
    await act(async () => { (row().querySelector("button[aria-label='chat.queue.edit']") as HTMLButtonElement).click(); });
    const editor = host.querySelector("textarea[data-chat-composer]") as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(editor, "revisada enquanto enviava");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { expect(dequeueMessage(KEY)).toBe("original"); });
    expect(host.querySelectorAll("li[data-queued]")).toHaveLength(0);
    expect((host.querySelector("textarea[data-chat-composer]") as HTMLTextAreaElement).value).toBe("revisada enquanto enviava");
  });

  it("usa a preferência de acompanhamento para Enter e inverte a ação com Cmd+Enter", async () => {
    saveChatPrefs({ ...DEFAULT_CHAT_PREFS, followUpBehavior: "queue" });
    const sent: string[] = [];
    const queued: string[] = [];
    await act(async () => {
      root.render(<ChatComposer placeholder="p" turnActive onSubmit={(text) => { sent.push(text); }}
        onQueue={(text) => { queued.push(text); }} />);
    });
    const composer = host.querySelector("textarea[data-chat-composer]") as HTMLTextAreaElement;
    const type = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(composer, value);
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const enter = async (metaKey = false) => act(async () => {
      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, metaKey }));
    });
    await type("para depois");
    await enter();
    expect(queued).toEqual(["para depois"]);
    expect(sent).toEqual([]);
    await type("agora");
    await enter(true);
    expect(sent).toEqual(["agora"]);
    expect(queued).toEqual(["para depois"]);
  });

  it("Alt+↑ carrega no composer a mensagem mais recente da fila para editar", async () => {
    enqueueMessage(KEY, "mais antiga");
    enqueueMessage(KEY, "mais recente");
    const Composer = () => {
      const queue = useChatStore((s) => s.queues[KEY]) ?? [];
      return <ChatComposer placeholder="p" onSubmit={() => undefined} onQueue={() => undefined} queue={queue}
        onUnqueue={(id) => unqueueMessage(KEY, id)} onUpdateQueued={(id, text) => updateQueuedMessage(KEY, id, text)} />;
    };
    await act(async () => { root.render(<Composer />); });
    const editor = host.querySelector("textarea[data-chat-composer]") as HTMLTextAreaElement;
    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true, cancelable: true }));
    });
    expect(editor.value).toBe("mais recente");
    expect(host.querySelector("li[data-queued][data-editing='true']")?.textContent).toContain("mais recente");
  });
});
