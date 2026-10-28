// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { registerTerminal, sendWhenReady } from "../terminalRegistry";

/** Um xterm de mentira: só o que o registro usa. */
function fakeTerm() {
  const parsed: (() => void)[] = [];
  return {
    parsed,
    onData: () => ({ dispose() {} }),
    onWriteParsed: (cb: () => void) => { parsed.push(cb); return { dispose() {} }; },
    paste: vi.fn(),
    input: vi.fn(),
  };
}

describe("sendWhenReady com draft", () => {
  afterEach(() => vi.useRealTimers());

  it("só cola o texto na caixa, sem o Enter", () => {
    vi.useFakeTimers();
    const term = fakeTerm();
    // Aba fora do store: o registro cola assim que a terminal se aquieta.
    const unregister = registerTerminal("tab-draft", term as never);
    sendWhenReady("tab-draft", "pergunta pré-preenchida", { draft: true });
    term.parsed.forEach((cb) => cb());
    vi.advanceTimersByTime(60_000);
    expect(term.paste).toHaveBeenCalledWith("pergunta pré-preenchida");
    expect(term.input).not.toHaveBeenCalled();
    unregister();
  });

  it("sem draft, envia com Enter como sempre", () => {
    vi.useFakeTimers();
    const term = fakeTerm();
    const unregister = registerTerminal("tab-send", term as never);
    sendWhenReady("tab-send", "briefing");
    term.parsed.forEach((cb) => cb());
    // Quieta por 2,5 s e o Enter 80 ms depois do pegado (antes das reenviadas, que leem a tela).
    vi.advanceTimersByTime(2_600);
    expect(term.paste).toHaveBeenCalledWith("briefing");
    expect(term.input).toHaveBeenCalledWith("\r");
    unregister();
  });
});

describe("sendWhenReady com guard (rechecagem logo antes de colar)", () => {
  afterEach(() => vi.useRealTimers());

  it("o guard que diz não na hora de colar descarta a mensagem e avisa", () => {
    vi.useFakeTimers();
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
    const bad = fakeTerm();
    const offBad = registerTerminal("tab-guard-2", bad as never);
    sendWhenReady("tab-guard-2", "x", { draft: true, guard: () => { throw new Error("falhou"); } });
    bad.parsed.forEach((cb) => cb());
    vi.advanceTimersByTime(2_600);
    expect(bad.paste).not.toHaveBeenCalled();
    offBad();
    const good = fakeTerm();
    const offGood = registerTerminal("tab-guard-3", good as never);
    sendWhenReady("tab-guard-3", "y", { draft: true, guard: () => true });
    good.parsed.forEach((cb) => cb());
    vi.advanceTimersByTime(2_600);
    expect(good.paste).toHaveBeenCalledWith("y");
    offGood();
  });
});
