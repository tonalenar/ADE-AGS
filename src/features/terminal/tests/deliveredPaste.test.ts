// @vitest-environment happy-dom
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "@/features/tabs/types";
import { useTabsStore } from "@/features/tabs/store";

vi.mock("../ptyLaunch", () => ({ requestPtyLaunch: vi.fn() }));

import { notePtyWrite, registerTerminal, sendWhenReady } from "../terminalRegistry";

/** Mesmo valor de `SETTLE_MS` no registro: a TUI fica quieta por esse tempo e então cola. */
const SETTLE_MS = 2500;

/** Terminal de mentira: o `paste` dispara `onData` na hora, como o xterm real, e `onWriteParsed` é acionado pelo teste. */
function falsoTerminal() {
  const dados: Array<(data: string) => void> = [];
  const saidas: Array<() => void> = [];
  const buffer = { type: "normal", baseY: 0, cursorY: 0, viewportY: 0, length: 0, getLine: () => undefined };
  const term = {
    cols: 80,
    rows: 24,
    modes: { bracketedPasteMode: false },
    buffer: { active: buffer },
    paste: (text: string) => {
      for (const cb of dados) cb(text);
    },
    input: (data: string) => {
      for (const cb of dados) cb(data);
    },
    onData: (cb: (data: string) => void) => {
      dados.push(cb);
      return { dispose: () => undefined };
    },
    onWriteParsed: (cb: () => void) => {
      saidas.push(cb);
      return { dispose: () => undefined };
    },
  };
  return {
    term: term as unknown as Terminal,
    dados,
    saiu: () => {
      for (const cb of saidas) cb();
    },
  };
}

function tab(id: string, ptyId: number): Tab {
  return { id, title: id, cwd: "/tmp", agentId: "bash", agentLabel: "bash", command: "bash", ptyId, openedAt: 1 } as Tab;
}

/** Deixa as promessas encadeadas andarem, sem relógio. */
async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe("sendWhenReady: onSent só com a entrega confirmada", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useTabsStore.setState({ tabs: [tab("a", 5)] });
  });
  afterEach(() => {
    vi.useRealTimers();
    useTabsStore.setState({ tabs: [] });
  });

  it("a TUI só conta como enviada quando o PTY aceita a escrita", async () => {
    const t = falsoTerminal();
    const aceitas: Array<() => void> = [];
    t.dados.push((data) => {
      if (data !== "\r") notePtyWrite("a", new Promise<void>((resolve) => aceitas.push(resolve)));
    });
    const sair = registerTerminal("a", t.term);
    const onSent = vi.fn();
    const onFailed = vi.fn();

    sendWhenReady("a", "oi", { onSent, onFailed });
    t.saiu();
    vi.advanceTimersByTime(SETTLE_MS);
    expect(onSent).not.toHaveBeenCalled();

    aceitas[0]!();
    await flush();
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onFailed).not.toHaveBeenCalled();
    sair();
  });

  it("a escrita recusada vira falha, e a mensagem não conta como enviada", async () => {
    const t = falsoTerminal();
    t.dados.push((data) => {
      if (data !== "\r") {
        const recusada = Promise.reject(new Error("Terminal ocupado: a entrada não foi enviada"));
        recusada.catch(() => undefined);
        notePtyWrite("a", recusada);
      }
    });
    const sair = registerTerminal("a", t.term);
    const onSent = vi.fn();
    const onFailed = vi.fn();

    sendWhenReady("a", "oi", { onSent, onFailed });
    t.saiu();
    vi.advanceTimersByTime(SETTLE_MS);
    await flush();
    expect(onSent).not.toHaveBeenCalled();
    expect(onFailed).toHaveBeenCalledWith(expect.stringContaining("ocupado"));
    sair();
  });
});
