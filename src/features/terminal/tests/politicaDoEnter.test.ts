// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/features/terminal/ipc", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ptyWrite: vi.fn(() => Promise.resolve()),
}));

import { ptyWrite } from "@/features/terminal/ipc";

import { pasteIntoTab, registerTerminal, type SubmitPolicy } from "../terminalRegistry";

const PTY = 9;

/** Um xterm de mentira: o `input` chega ao PTY como no app. `lines` é a tela, e pode mudar. */
function fakeTerm(lines: () => string[]) {
  const dataListeners: ((data: string) => void)[] = [(data) => void ptyWrite(PTY, data)];
  const parsed: (() => void)[] = [];
  return {
    parsed,
    rows: 40,
    modes: { bracketedPasteMode: true },
    onData: (cb: (data: string) => void) => { dataListeners.push(cb); return { dispose() {} }; },
    onWriteParsed: (cb: () => void) => { parsed.push(cb); return { dispose() {} }; },
    paste: vi.fn(),
    input: vi.fn((data: string) => { for (const cb of dataListeners) cb(data); }),
    focus: vi.fn(),
    getSelection: () => "",
    buffer: {
      active: {
        type: "normal", baseY: 0, viewportY: 0, cursorX: 0,
        get cursorY() { return Math.max(0, lines().length - 1); },
        get length() { return lines().length; },
        getLine: (y: number) => ({ translateToString: () => lines()[y] ?? "" }),
      },
    },
  };
}

const enters = () => vi.mocked(ptyWrite).mock.calls.filter(([, data]) => data === "\r").length;
const APROVACAO = "Do you want to proceed? ❯ 1. Yes";
const COLADO = "› [Pasted Content 3904 chars]";

describe("pasteIntoTab com política: confere antes de colar (I7)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(ptyWrite).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("com bloqueio antes de colar, não cola e devolve falso", () => {
    const term = fakeTerm(() => ["Editei o arquivo.", APROVACAO]);
    const off = registerTerminal("pol-antes", term as never);
    const policy: SubmitPolicy = { gate: () => "blocked-waiting-user", onBlocked: vi.fn() };
    expect(pasteIntoTab("pol-antes", "mensagem", true, undefined, policy)).toBe(false);
    expect(term.paste).not.toHaveBeenCalled();
    expect(policy.onBlocked).toHaveBeenCalledWith("blocked-waiting-user", false);
    off();
  });

  it("depois de colar com bloqueio no Enter, não cola de novo no reenvio (a caixa fica com um colado só)", () => {
    let screen = ["Editei o arquivo.", COLADO];
    const term = fakeTerm(() => screen);
    const off = registerTerminal("pol-sem-recolar", term as never);
    let blocked = false;
    const policy: SubmitPolicy = { gate: () => (blocked ? "blocked-waiting-user" : null), onBlocked: vi.fn() };
    pasteIntoTab("pol-sem-recolar", "mensagem", true, undefined, policy);
    expect(term.paste).toHaveBeenCalledTimes(1);
    // O Enter de 80 ms é barrado: o texto já está na caixa, e nenhum reenvio pode colar de novo.
    screen = [...screen, APROVACAO];
    blocked = true;
    vi.advanceTimersByTime(60_000);
    expect(term.paste).toHaveBeenCalledTimes(1);
    expect(enters()).toBe(0);
    off();
  });
});

describe("pasteIntoTab com política: confirmação do envio (I3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(ptyWrite).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("onSubmitted sai com o Enter, e onConfirmed só depois que a caixa já não segura o texto", () => {
    const term = fakeTerm(() => ["Editei o arquivo.", "› "]);
    const off = registerTerminal("pol-confirma", term as never);
    const onSubmitted = vi.fn();
    const onConfirmed = vi.fn();
    pasteIntoTab("pol-confirma", "mensagem", true, undefined, { gate: () => null, onSubmitted, onConfirmed });
    vi.advanceTimersByTime(100);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    expect(onConfirmed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    off();
  });

  it("enquanto a caixa segura o colado, não confirma; ao fim dos reenvios, onUnconfirmed", () => {
    const term = fakeTerm(() => ["Editei o arquivo.", COLADO]);
    const off = registerTerminal("pol-nao-confirma", term as never);
    const onConfirmed = vi.fn();
    const onUnconfirmed = vi.fn();
    pasteIntoTab("pol-nao-confirma", "mensagem grande", true, undefined, { gate: () => null, onConfirmed, onUnconfirmed });
    vi.advanceTimersByTime(30_000);
    expect(onConfirmed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(onUnconfirmed).toHaveBeenCalledTimes(1);
    off();
  });

  it("reenvio bloqueado depois do primeiro Enter chama onBlocked (o aviso sai), e nunca onConfirmed", () => {
    let screen = ["Editei o arquivo.", COLADO];
    const term = fakeTerm(() => screen);
    const off = registerTerminal("pol-reenvio-bloqueado", term as never);
    const onBlocked = vi.fn();
    const onConfirmed = vi.fn();
    let blocked = false;
    pasteIntoTab("pol-reenvio-bloqueado", "mensagem grande", true, undefined, {
      gate: () => (blocked ? "blocked-waiting-user" : null),
      onBlocked,
      onConfirmed,
    });
    vi.advanceTimersByTime(300);
    screen = [...screen, APROVACAO];
    blocked = true;
    vi.advanceTimersByTime(1_000);
    // Bloqueio depois de colar: `pasted` é verdadeiro, e o chamador não cola de novo.
    expect(onBlocked).toHaveBeenCalledWith("blocked-waiting-user", true);
    expect(onConfirmed).not.toHaveBeenCalled();
    off();
  });
});
