// @vitest-environment happy-dom
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "@/features/tabs/types";
import { useTabsStore } from "@/features/tabs/store";

/** Cada escrita que o registro manda ao PTY fica pendente até o teste aceitar ou recusar. */
const mocks = vi.hoisted(() => ({
  writes: [] as Array<{ id: number; data: string; resolve: () => void; reject: (e: Error) => void }>,
  ptyWrite: vi.fn(),
  /** Os envios compostos (colagem, pausa, Enter) pendentes até o teste aceitar ou recusar. */
  composites: [] as Array<{ id: number; passos: unknown[]; resolve: () => void; reject: (e: Error) => void }>,
  ptyWriteComposto: vi.fn(),
}));
mocks.ptyWriteComposto.mockImplementation(
  (id: number, passos: unknown[]) =>
    new Promise<void>((resolve, reject) => {
      mocks.composites.push({ id, passos, resolve, reject });
    }),
);
mocks.ptyWrite.mockImplementation(
  (id: number, data: string) =>
    new Promise<void>((resolve, reject) => {
      mocks.writes.push({ id, data, resolve, reject });
    }),
);

vi.mock("@/features/terminal/ipc", () => ({
  ptyWrite: (id: number, data: string) => mocks.ptyWrite(id, data),
  ptyWriteComposto: (id: number, passos: unknown[]) => mocks.ptyWriteComposto(id, passos),
}));
vi.mock("../ptyLaunch", () => ({ requestPtyLaunch: vi.fn() }));

import { pasteEnvelope, registerTerminal, sendPasteToPty, sendWhenReady } from "../terminalRegistry";

/** Mesmo valor de `SETTLE_MS` no registro: a TUI fica quieta por esse tempo e então cola. */
const SETTLE_MS = 2500;
/** Mesmo valor da pausa entre a colagem e o Enter. */
const ENTER_MS = 80;

/** Terminal de mentira: o registro só usa `modes`, `onData`, `onWriteParsed`, e o teste aciona a saída. */
function falsoTerminal(bracketed = false) {
  const saidas: Array<() => void> = [];
  const buffer = { type: "normal", baseY: 0, cursorY: 0, viewportY: 0, length: 0, getLine: () => undefined };
  const term = {
    cols: 80,
    rows: 24,
    modes: { bracketedPasteMode: bracketed },
    buffer: { active: buffer },
    paste: () => undefined,
    input: () => undefined,
    onData: () => ({ dispose: () => undefined }),
    onWriteParsed: (cb: () => void) => {
      saidas.push(cb);
      return { dispose: () => undefined };
    },
  };
  return {
    term: term as unknown as Terminal,
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
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("sendWhenReady: onSent só com a escrita do Enter aceita pelo PTY", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.writes.length = 0;
    mocks.composites.length = 0;
    mocks.ptyWrite.mockClear();
    mocks.ptyWriteComposto.mockClear();
    useTabsStore.setState({ tabs: [tab("a", 5)] });
  });
  afterEach(() => {
    vi.useRealTimers();
    useTabsStore.setState({ tabs: [] });
  });

  it("a colagem, a pausa e o Enter vão ao PTY como um pedido só, e a mensagem só conta como enviada quando ele é aceito", async () => {
    const t = falsoTerminal(false);
    const sair = registerTerminal("a", t.term);
    const onSent = vi.fn();
    const onFailed = vi.fn();

    sendWhenReady("a", "oi", { onSent, onFailed });
    t.saiu();
    vi.advanceTimersByTime(SETTLE_MS);
    // Um pedido só: colagem, pausa e Enter. Entram juntos, ou nenhum entra.
    expect(mocks.composites).toHaveLength(1);
    expect(mocks.composites[0]!.passos).toEqual([
      { tipo: "texto", dados: "oi" },
      { tipo: "pausa", ms: ENTER_MS },
      { tipo: "texto", dados: "\r" },
    ]);
    expect(onSent).not.toHaveBeenCalled();

    mocks.composites[0]!.resolve();
    await flush();
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onFailed).not.toHaveBeenCalled();
    sair();
  });

  it("um pedido recusado vira onFailed, e a mensagem não conta como enviada", async () => {
    const t = falsoTerminal(false);
    const sair = registerTerminal("a", t.term);
    const onSent = vi.fn();
    const onFailed = vi.fn();

    sendWhenReady("a", "oi", { onSent, onFailed });
    t.saiu();
    vi.advanceTimersByTime(SETTLE_MS);
    mocks.composites[0]!.reject(new Error("Terminal ocupado: a entrada não foi enviada"));
    await flush();
    expect(onSent).not.toHaveBeenCalled();
    expect(onFailed).toHaveBeenCalledWith(expect.stringContaining("ocupado"));
    sair();
  });

  it("a colagem vai com o envelope do bracketed paste: quebra de linha vira CR, e o modo ligado põe 200~/201~", async () => {
    expect(pasteEnvelope("oi\nlinha", true)).toBe("\x1b[200~oi\rlinha\x1b[201~");
    expect(pasteEnvelope("oi\nlinha", false)).toBe("oi\rlinha");

    // O registro manda o envelope que o modo do terminal pede, pela fila.
    const t = falsoTerminal(true);
    const sair = registerTerminal("a", t.term);
    void sendPasteToPty("a", t.term, "oi\nlinha", false);
    expect(mocks.writes[mocks.writes.length - 1]?.data).toBe("\x1b[200~oi\rlinha\x1b[201~");
    sair();
  });
});
