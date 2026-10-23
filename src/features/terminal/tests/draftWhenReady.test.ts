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
