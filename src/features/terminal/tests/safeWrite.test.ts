// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/features/terminal/ipc", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ptyWrite: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/shared/brand/botToastStore", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  showBotToast: vi.fn(() => 1),
}));

import { ptyWrite } from "@/features/terminal/ipc";
import { setStructuredForTests } from "@/features/terminal/structuredState";
import { showBotToast } from "@/shared/brand/botToastStore";

import { avisarBloqueio, blockFromScreen, sendAutonomous, writeToAgent } from "../safeWrite";
import { registerTerminal } from "../terminalRegistry";

/** O PTY da aba de teste: o `ptyWrite` que o Terminal.tsx chama quando o xterm recebe uma tecla. */
const PTY = 7;

/**
 * Um xterm de mentira. `input` chega ao PTY pelo mesmo caminho do app (onData → ptyWrite), então o
 * spy de `ptyWrite` vê exatamente o que a TUI receberia. `lines` é a tela, e pode mudar durante o teste.
 */
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
        type: "normal",
        baseY: 0,
        viewportY: 0,
        cursorX: 0,
        get cursorY() { return Math.max(0, lines().length - 1); },
        get length() { return lines().length; },
        getLine: (y: number) => ({ translateToString: () => lines()[y] ?? "" }),
      },
    },
  };
}

/** Quantos Enters (`\r`) chegaram ao PTY. */
const enters = () => vi.mocked(ptyWrite).mock.calls.filter(([, data]) => data === "\r").length;

const APROVACAO = "Do you want to proceed? ❯ 1. Yes";

describe("writeToAgent: a guarda confere antes de colar e antes do Enter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(ptyWrite).mockClear();
    vi.mocked(showBotToast).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    setStructuredForTests([]);
  });

  it("vigia_nao_aperta_enter_em_pergunta_de_aprovacao", async () => {
    const term = fakeTerm(() => ["Editei o arquivo.", APROVACAO]);
    const off = registerTerminal("guarda-vigia", term as never);
    const result = await writeToAgent("guarda-vigia", "[Vigia] lembrete", { submit: true, source: "vigia" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(result).toBe("blocked-waiting-user");
    expect(ptyWrite).not.toHaveBeenCalledWith(PTY, "\r");
    expect(term.paste).not.toHaveBeenCalled();
    off();
  });

  it("aviso_de_parado_nao_aperta_enter_em_pergunta_de_aprovacao", async () => {
    const term = fakeTerm(() => ["Editei o arquivo.", APROVACAO]);
    const off = registerTerminal("guarda-parado", term as never);
    const result = await writeToAgent("guarda-parado", "[Aviso automático do ADE AGS] parado", { submit: true, source: "stalled" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(result).toBe("blocked-waiting-user");
    expect(ptyWrite).not.toHaveBeenCalledWith(PTY, "\r");
    off();
  });

  it("pergunta_que_aparece_entre_colar_e_enter_bloqueia_o_enter", async () => {
    let screen = ["Editei o arquivo.", "› "];
    const term = fakeTerm(() => screen);
    const off = registerTerminal("guarda-corrida", term as never);
    const pending = writeToAgent("guarda-corrida", "mensagem", { submit: true, source: "stalled" });
    await vi.advanceTimersByTimeAsync(40);
    // Depois de colado e antes do Enter (80 ms), a TUI abre um diálogo de aprovação.
    screen = ["Editei o arquivo.", APROVACAO];
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBe("blocked-waiting-user");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(enters()).toBe(0);
    off();
  });

  it("trabalho_que_comeca_entre_colar_e_enter_bloqueia_o_enter", async () => {
    let screen = ["Editei o arquivo.", "› "];
    const term = fakeTerm(() => screen);
    const off = registerTerminal("guarda-trabalho", term as never);
    const pending = writeToAgent("guarda-trabalho", "mensagem", { submit: true, source: "vigia" });
    await vi.advanceTimersByTimeAsync(40);
    screen = ["Editei o arquivo.", "✻ Thinking… (esc to interrupt)"];
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBe("blocked-busy");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(enters()).toBe(0);
    off();
  });

  it("o bloqueio no Enter cancela os reenvios, mesmo com o marcador do colado na caixa", async () => {
    let screen = ["Editei o arquivo.", "› [Pasted Content 3904 chars]"];
    const term = fakeTerm(() => screen);
    const off = registerTerminal("guarda-reenvio", term as never);
    const pending = writeToAgent("guarda-reenvio", "mensagem grande", { submit: true, source: "peer" });
    await vi.advanceTimersByTimeAsync(40);
    screen = [...screen, APROVACAO];
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBe("blocked-waiting-user");
    // Os reenvios (até 50 s) leem a tela de novo: nenhum pode apertar Enter numa pergunta.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(enters()).toBe(0);
    off();
  });

  it("sem pergunta na tela, envia com um Enter só e devolve sent", async () => {
    const term = fakeTerm(() => ["Editei o arquivo.", "› "]);
    const off = registerTerminal("guarda-livre", term as never);
    const pending = writeToAgent("guarda-livre", "mensagem", { submit: true, source: "peer" });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBe("sent");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(term.paste).toHaveBeenCalledWith("mensagem");
    expect(enters()).toBe(1);
    off();
  });

  it("transcript em turno aberto conta como trabalhando, mesmo com a tela quieta", async () => {
    setStructuredForTests([{
      tabId: "guarda-transcript", agentId: "claude", mode: "full", phase: "working", stale: false,
      tools: [], question: null, endsWithQuestion: false,
    } as never]);
    const term = fakeTerm(() => ["Editei o arquivo.", "› "]);
    const off = registerTerminal("guarda-transcript", term as never);
    expect(await writeToAgent("guarda-transcript", "mensagem", { submit: true, source: "vigia" })).toBe("blocked-busy");
    expect(term.paste).not.toHaveBeenCalled();
    off();
  });

  it("rascunho sem Enter também não cola numa pergunta de aprovação", async () => {
    const term = fakeTerm(() => ["Editei o arquivo.", APROVACAO]);
    const off = registerTerminal("guarda-rascunho", term as never);
    expect(await writeToAgent("guarda-rascunho", "texto", { submit: false, source: "vigia" })).toBe("blocked-waiting-user");
    expect(term.paste).not.toHaveBeenCalled();
    off();
  });

  it("rascunho sem Enter cola na caixa quando a tela está livre, e não aperta Enter", async () => {
    const term = fakeTerm(() => ["Editei o arquivo.", "› "]);
    const off = registerTerminal("guarda-rascunho-livre", term as never);
    expect(await writeToAgent("guarda-rascunho-livre", "texto", { submit: false, source: "peer" })).toBe("sent");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(term.paste).toHaveBeenCalledWith("texto");
    expect(enters()).toBe(0);
    off();
  });

  it("sem terminal viva não há para onde escrever: devolve blocked-busy", async () => {
    expect(await writeToAgent("guarda-sem-terminal", "x", { submit: true, source: "vigia" })).toBe("blocked-busy");
    expect(ptyWrite).not.toHaveBeenCalled();
  });
});

describe("blockFromScreen (pura)", () => {
  it("pergunta de aprovação vence o trabalho", () => {
    expect(blockFromScreen([APROVACAO], true)).toBe("blocked-waiting-user");
  });

  it("trabalhando bloqueia", () => {
    expect(blockFromScreen(["✻ Thinking… (esc to interrupt)"], true)).toBe("blocked-busy");
  });

  it("tela quieta e sem trabalho libera", () => {
    expect(blockFromScreen(["›"], false)).toBeNull();
  });
});

describe("sendAutonomous: a fila de espera da TUI usa a mesma guarda", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(ptyWrite).mockClear();
    vi.mocked(showBotToast).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("cutucada do Vigia numa pergunta: não cola, não registra como enviada e avisa", () => {
    const term = fakeTerm(() => ["Editei o arquivo.", APROVACAO]);
    const off = registerTerminal("auto-poke", term as never);
    const onSent = vi.fn();
    const onSkipped = vi.fn();
    sendAutonomous("auto-poke", "[Vigia] cutuca", "vigia", { onSent, onSkipped });
    term.parsed.forEach((cb) => cb());
    vi.advanceTimersByTime(60_000);
    expect(term.paste).not.toHaveBeenCalled();
    expect(enters()).toBe(0);
    expect(onSent).not.toHaveBeenCalled();
    expect(onSkipped).toHaveBeenCalledTimes(1);
    expect(showBotToast).toHaveBeenCalledTimes(1);
    off();
  });

  it("sem pergunta, o onSent só dispara quando o Enter sai", () => {
    const term = fakeTerm(() => ["Editei o arquivo.", "› "]);
    const off = registerTerminal("auto-ok", term as never);
    const onSent = vi.fn();
    sendAutonomous("auto-ok", "mensagem", "peer", { onSent });
    term.parsed.forEach((cb) => cb());
    vi.advanceTimersByTime(2_700);
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(enters()).toBe(1);
    off();
  });
});

describe("avisarBloqueio: um aviso por bloqueio seguido", () => {
  beforeEach(() => vi.mocked(showBotToast).mockClear());

  it("repete só quando o bloqueio muda", () => {
    avisarBloqueio("aviso-repetido", "stalled", "blocked-busy");
    avisarBloqueio("aviso-repetido", "stalled", "blocked-busy");
    expect(showBotToast).toHaveBeenCalledTimes(1);
    avisarBloqueio("aviso-repetido", "stalled", "blocked-waiting-user");
    expect(showBotToast).toHaveBeenCalledTimes(2);
  });
});
