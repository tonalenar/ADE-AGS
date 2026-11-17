// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { registerTerminal, sendWhenReady } from "../terminalRegistry";
import { useTabsStore } from "@/features/tabs/store";
import type { Tab } from "@/features/tabs/types";

function liveTab(id: string, ptyId: number): Tab {
  return { id, title: id, cwd: "/tmp", agentId: "bash", agentLabel: "bash", command: "bash", ptyId, openedAt: 1 } as Tab;
}

async function flushPromises() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** Um xterm de mentira: só o que o registro usa. */
function fakeTerm() {
  const parsed: (() => void)[] = [];
  return {
    parsed,
    cols: 80,
    rows: 24,
    modes: { bracketedPasteMode: false },
    buffer: {
      active: {
        type: "normal",
        baseY: 0,
        cursorY: 0,
        viewportY: 0,
        length: 24,
        getLine: () => undefined,
      },
    },
    onData: () => ({ dispose() {} }),
    onWriteParsed: (cb: () => void) => { parsed.push(cb); return { dispose() {} }; },
    paste: vi.fn(),
    input: vi.fn(),
  };
}

describe("sendWhenReady com draft", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    useTabsStore.setState({ tabs: [] });
    mocks.invoke.mockReset();
  });

  it("aba missing espera nascer um PTY antes de enviar pelo pedido composto", async () => {
    vi.useFakeTimers();
    mocks.invoke.mockResolvedValue(undefined);
    useTabsStore.setState({ tabs: [] });
    const term = fakeTerm();
    const unregister = registerTerminal("tab-missing", term as never);
    const onSent = vi.fn();
    const onFailed = vi.fn();
    sendWhenReady("tab-missing", "briefing", { onSent, onFailed });

    // Mesmo com o terminal registrado e quieto, sem aba/PTY a entrega não aconteceu.
    term.parsed.forEach((cb) => cb());
    vi.advanceTimersByTime(2_000);
    expect(onSent).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();

    // Quando a aba e o PTY aparecem, a mesma entrega composta confirma o envio.
    useTabsStore.setState({ tabs: [liveTab("tab-missing", 41)] });
    term.parsed.forEach((cb) => cb());
    vi.advanceTimersByTime(2_500);
    expect(mocks.invoke).toHaveBeenCalledWith("pty_write_composto", {
      id: 41,
      passos: [
        { tipo: "texto", dados: "briefing" },
        { tipo: "pausa", ms: 80 },
        { tipo: "texto", dados: "\r" },
      ],
    });
    expect(onSent).not.toHaveBeenCalled();
    await flushPromises();
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onFailed).not.toHaveBeenCalled();
    expect(term.paste).not.toHaveBeenCalled();
    expect(term.input).not.toHaveBeenCalled();
    unregister();
  });

  it("aba que não nasce no prazo existente falha sem contar como enviada", () => {
    vi.useFakeTimers();
    useTabsStore.setState({ tabs: [] });
    const term = fakeTerm();
    const unregister = registerTerminal("tab-never-born", term as never);
    const onSent = vi.fn();
    const onFailed = vi.fn();
    sendWhenReady("tab-never-born", "briefing", { onSent, onFailed });

    vi.advanceTimersByTime(8_000);

    expect(onSent).not.toHaveBeenCalled();
    expect(onFailed).toHaveBeenCalledWith(expect.stringContaining("a tempo"));
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(term.paste).not.toHaveBeenCalled();
    unregister();
  });

  it("draft escreve no PTY sem Enter e só confirma depois da escrita aceita", async () => {
    vi.useFakeTimers();
    mocks.invoke.mockResolvedValue(undefined);
    useTabsStore.setState({ tabs: [liveTab("tab-draft", 43)] });
    const term = fakeTerm();
    const unregister = registerTerminal("tab-draft", term as never);
    const onSent = vi.fn();
    sendWhenReady("tab-draft", "pergunta pré-preenchida", { draft: true, onSent });
    term.parsed.forEach((cb) => cb());
    vi.advanceTimersByTime(2_500);

    expect(mocks.invoke).toHaveBeenCalledWith("pty_write", { id: 43, data: "pergunta pré-preenchida" });
    expect(onSent).not.toHaveBeenCalled();
    expect(term.paste).not.toHaveBeenCalled();
    expect(term.input).not.toHaveBeenCalled();
    await flushPromises();
    expect(onSent).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("sem draft, envia com Enter como sempre", () => {
    vi.useFakeTimers();
    mocks.invoke.mockResolvedValue(undefined);
    useTabsStore.setState({ tabs: [liveTab("tab-send", 42)] });
    const term = fakeTerm();
    const unregister = registerTerminal("tab-send", term as never);
    sendWhenReady("tab-send", "briefing");
    term.parsed.forEach((cb) => cb());
    // Quieta por 2,5 s e o Enter 80 ms depois do pegado (antes das reenviadas, que leem a tela).
    vi.advanceTimersByTime(2_600);
    expect(mocks.invoke).toHaveBeenCalledWith("pty_write_composto", expect.objectContaining({ id: 42 }));
    expect(term.paste).not.toHaveBeenCalled();
    expect(term.input).not.toHaveBeenCalled();
    unregister();
  });
});

describe("sendWhenReady com guard (rechecagem logo antes de colar)", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    useTabsStore.setState({ tabs: [] });
    mocks.invoke.mockReset();
  });

  it("o guard que diz não na hora de colar descarta a mensagem e avisa", () => {
    vi.useFakeTimers();
    mocks.invoke.mockResolvedValue(undefined);
    useTabsStore.setState({ tabs: [liveTab("tab-guard", 51)] });
    const term = fakeTerm();
    const unregister = registerTerminal("tab-guard", term as never);
    let allowed = true;
    const onSkipped = vi.fn();
    const onSent = vi.fn();
    sendWhenReady("tab-guard", "[Vigia] lembrete", { draft: true, guard: () => allowed, onSkipped, onSent });
    // Durante a espera da TUI o destino voltou a trabalhar (ou o Vigia foi desligado).
    allowed = false;
    term.parsed.forEach((cb) => cb());
    vi.advanceTimersByTime(60_000);
    expect(term.paste).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
    expect(onSkipped).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("guard que lança é um não (falha fechada); guard que diz sim cola", () => {
    vi.useFakeTimers();
    mocks.invoke.mockResolvedValue(undefined);
    useTabsStore.setState({ tabs: [liveTab("tab-guard-2", 52)] });
    const bad = fakeTerm();
    const offBad = registerTerminal("tab-guard-2", bad as never);
    sendWhenReady("tab-guard-2", "x", { draft: true, guard: () => { throw new Error("falhou"); } });
    bad.parsed.forEach((cb) => cb());
    vi.advanceTimersByTime(2_600);
    expect(bad.paste).not.toHaveBeenCalled();
    offBad();
    useTabsStore.setState({ tabs: [liveTab("tab-guard-3", 53)] });
    const good = fakeTerm();
    const offGood = registerTerminal("tab-guard-3", good as never);
    sendWhenReady("tab-guard-3", "y", { draft: true, guard: () => true });
    good.parsed.forEach((cb) => cb());
    vi.advanceTimersByTime(2_600);
    expect(good.paste).not.toHaveBeenCalled();
    offGood();
  });
});
