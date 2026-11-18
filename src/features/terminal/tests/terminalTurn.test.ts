// @vitest-environment happy-dom
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "@/features/tabs/types";
import { useTabsStore } from "@/features/tabs/store";

vi.mock("../ptyLaunch", () => ({ requestPtyLaunch: vi.fn() }));

import { registerTerminal, sendWhenReady, watchTurn } from "../terminalRegistry";

/** O silêncio que dá o turno por terminado (mesmo valor de `TURN_QUIET_MS` no registro). */
const SILENCIO_MS = 5000;

describe("silêncio do turno do agente", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("500 pedaços de saída não criam um timer por pedaço, e o fim do turno sai uma vez", () => {
    const ouvintes: Array<() => void> = [];
    const term = {
      onWriteParsed: (cb: () => void) => {
        ouvintes.push(cb);
        return { dispose: vi.fn() };
      },
    } as unknown as Terminal;
    const fim = vi.fn();
    const contar = vi.spyOn(window, "setTimeout");
    watchTurn(term, fim);
    const antes = contar.mock.calls.length;

    for (let i = 0; i < 500; i++) ouvintes[0]?.();

    expect(contar.mock.calls.length - antes).toBeLessThanOrEqual(2);
    vi.advanceTimersByTime(SILENCIO_MS);
    expect(fim).toHaveBeenCalledTimes(1);
    contar.mockRestore();
  });
});

function tab(id: string, ptyId: number | null): Tab {
  return { id, title: id, cwd: "/tmp", agentId: "bash", agentLabel: "bash", command: "bash", ptyId, openedAt: 1 } as Tab;
}

describe("lançamento de uma aba que ainda não tem PTY", () => {
  afterEach(() => useTabsStore.setState({ tabs: [] }));

  it("espera a aba ganhar o PTY pela store, sem timer de 100 ms", () => {
    useTabsStore.setState({ tabs: [tab("b", null)] });
    const intervalos = vi.spyOn(window, "setInterval");
    let saidas = 0;
    const term = {
      cols: 80,
      rows: 24,
      buffer: { active: { type: "normal", baseY: 0, cursorY: 0, viewportY: 0, length: 0, getLine: () => undefined } },
      onData: () => ({ dispose: () => undefined }),
      onWriteParsed: () => {
        saidas += 1;
        return { dispose: () => undefined };
      },
      paste: () => undefined,
      input: () => undefined,
    } as unknown as Terminal;
    const sair = registerTerminal("b", term);

    sendWhenReady("b", "oi");
    // Enquanto a aba não tem PTY, nada consulta em laço: a espera é por evento.
    expect(intervalos).not.toHaveBeenCalled();

    // A aba ganha o PTY: o registro reage à mudança da store, sem esperar a próxima consulta.
    useTabsStore.setState({ tabs: [tab("b", 3)] });
    expect(saidas).toBe(1);
    intervalos.mockRestore();
    sair();
  });
});
