// @vitest-environment happy-dom
import i18n from "i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/features/terminal/ipc", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ptyWrite: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/shared/brand/botToastStore", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  showBotToast: vi.fn(() => 1),
}));

import { useTabsStore } from "@/features/tabs/store";
import { ptyWrite } from "@/features/terminal/ipc";
import { setStructuredForTests } from "@/features/terminal/structuredState";
import { showBotToast } from "@/shared/brand/botToastStore";

import { avisarBloqueio, blockFromScreen, mostraResultado, sendAutonomous, writeToAgent } from "../safeWrite";
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

/** Diz se a promessa já resolveu, sem esperar: a flag muda quando o `then` roda. */
function resolvida(p: Promise<unknown>): { done: boolean } {
  const box = { done: false };
  void p.then(() => { box.done = true; });
  return box;
}

const APROVACAO = "Do you want to proceed? ❯ 1. Yes";
/** A caixa de entrada com o colado grande ainda não enviado (o marcador que a TUI deixa). */
const COLADO = "› [Pasted Content 3904 chars]";

beforeAll(async () => {
  await i18n.changeLanguage("pt-BR");
});

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
    // O texto já estava na caixa quando o Enter foi barrado: não confirmado, e não se cola de novo.
    expect(await pending).toBe("unconfirmed");
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
    expect(await pending).toBe("unconfirmed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(enters()).toBe(0);
    off();
  });

  it("sem pergunta na tela, o Enter sai uma vez e 'sent' só vale depois da confirmação", async () => {
    const term = fakeTerm(() => ["Editei o arquivo.", "› "]);
    const off = registerTerminal("guarda-livre", term as never);
    const pending = writeToAgent("guarda-livre", "mensagem", { submit: true, source: "peer" });
    const box = resolvida(pending);
    await vi.advanceTimersByTimeAsync(100);
    // O Enter saiu aos 80 ms, mas a caixa ainda não foi conferida: não é 'sent' ainda.
    expect(enters()).toBe(1);
    expect(box.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toBe("sent");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(term.paste).toHaveBeenCalledWith("mensagem");
    expect(enters()).toBe(1);
    off();
  });

  it("o reenvio bloqueado depois do primeiro Enter devolve o bloqueio e avisa (não 'sent')", async () => {
    let screen = ["Editei o arquivo.", COLADO];
    const term = fakeTerm(() => screen);
    const off = registerTerminal("guarda-reenvio-avisa", term as never);
    const pending = writeToAgent("guarda-reenvio-avisa", "mensagem grande", { submit: true, source: "peer" });
    await vi.advanceTimersByTimeAsync(300);
    // O primeiro Enter saiu, mas a caixa ainda segura o colado. Antes da conferência de 900 ms a TUI vira pergunta.
    screen = [...screen, APROVACAO];
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    expect(result).toBe("unconfirmed");
    // Quem chama mostra o resultado: o aviso sai daqui, não de dentro do `writeToAgent`.
    mostraResultado("guarda-reenvio-avisa", "peer", result);
    expect(showBotToast).toHaveBeenCalledTimes(1);
    expect(enters()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(enters()).toBe(1);
    off();
  });

  it("sem confirmação depois de todos os reenvios, devolve 'unconfirmed' e avisa", async () => {
    const term = fakeTerm(() => ["Editei o arquivo.", COLADO]);
    const off = registerTerminal("guarda-sem-confirmacao", term as never);
    const pending = writeToAgent("guarda-sem-confirmacao", "mensagem grande", { submit: true, source: "peer" });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(result).toBe("unconfirmed");
    mostraResultado("guarda-sem-confirmacao", "peer", result);
    expect(showBotToast).toHaveBeenCalledTimes(1);
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

  it("sem terminal viva o resultado é 'no-terminal', próprio, e nada é escrito", async () => {
    expect(await writeToAgent("guarda-sem-terminal", "x", { submit: true, source: "vigia" })).toBe("no-terminal");
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
    useTabsStore.setState({
      tabs: ["auto-poke", "auto-ok", "auto-reagenda", "auto-limite"].map((id) => ({ id, ptyId: PTY }) as never),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    useTabsStore.setState({ tabs: [] });
  });

  it("cutucada do Vigia numa pergunta: não cola, não registra como enviada e avisa", () => {
    const term = fakeTerm(() => ["Editei o arquivo.", APROVACAO]);
    const off = registerTerminal("auto-poke", term as never);
    const onSent = vi.fn();
    const onSkipped = vi.fn();
    sendAutonomous("auto-poke", "[Vigia] cutuca", "vigia", { onSent, onSkipped });
    term.parsed.forEach((cb) => cb());
    // Sem o `guard` do Vigia, a cutucada barrada reagenda até o limite (I6) e só então desiste.
    vi.advanceTimersByTime(120_000);
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

  it("briefing com trabalho no momento de colar é reagendado, não descartado (I6)", () => {
    let screen = ["Codex v0.2 pronto.", "✻ Thinking… (esc to interrupt)"];
    const term = fakeTerm(() => screen);
    const off = registerTerminal("auto-reagenda", term as never);
    const onSent = vi.fn();
    const onSkipped = vi.fn();
    sendAutonomous("auto-reagenda", "briefing", "peer", { onSent, onSkipped });
    term.parsed.forEach((cb) => cb());
    vi.advanceTimersByTime(2_600);
    expect(term.paste).not.toHaveBeenCalled();
    expect(onSkipped).not.toHaveBeenCalled();
    // A TUI termina e fica livre: o briefing sai no reagendamento, sem nova cutucada.
    screen = ["Codex v0.2 pronto.", "› "];
    vi.advanceTimersByTime(6_000);
    expect(term.paste).toHaveBeenCalledWith("briefing");
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onSkipped).not.toHaveBeenCalled();
    off();
  });

  it("depois do limite de tentativas desiste, avisa e só então conta como pulado (I6)", () => {
    const term = fakeTerm(() => ["Codex v0.2 pronto.", "✻ Thinking… (esc to interrupt)"]);
    const off = registerTerminal("auto-limite", term as never);
    const onSkipped = vi.fn();
    sendAutonomous("auto-limite", "briefing", "peer", { onSkipped });
    term.parsed.forEach((cb) => cb());
    vi.advanceTimersByTime(30_000);
    expect(onSkipped).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(onSkipped).toHaveBeenCalledTimes(1);
    expect(term.paste).not.toHaveBeenCalled();
    off();
  });
});

describe("avisarBloqueio: um aviso por bloqueio seguido, com o texto certo", () => {
  beforeEach(() => vi.mocked(showBotToast).mockClear());

  it("repete só quando o bloqueio muda", () => {
    avisarBloqueio("aviso-repetido", "stalled", "blocked-busy");
    avisarBloqueio("aviso-repetido", "stalled", "blocked-busy");
    expect(showBotToast).toHaveBeenCalledTimes(1);
    avisarBloqueio("aviso-repetido", "stalled", "blocked-waiting-user");
    expect(showBotToast).toHaveBeenCalledTimes(2);
  });

  it("o aviso do Vigia ou do aviso de parado diz que tenta de novo sozinho (M2)", () => {
    avisarBloqueio("aviso-vigia", "vigia", "blocked-busy");
    const text = vi.mocked(showBotToast).mock.calls[0][0].text;
    expect(text).toContain("Tento de novo sozinho");
  });

  it("o aviso de um envio de integrante diz para reenviar quando ele parar (M2)", () => {
    avisarBloqueio("aviso-peer", "peer", "blocked-busy");
    const text = vi.mocked(showBotToast).mock.calls[0][0].text;
    expect(text).toContain("Reenvie quando ele parar");
  });

  it("não confirmado diz para apertar Enter na caixa do agente, e não manda reenviar (fix 2)", () => {
    vi.mocked(showBotToast).mockClear();
    avisarBloqueio("aviso-nao-confirmado", "peer", "unconfirmed");
    const text = vi.mocked(showBotToast).mock.calls[0][0].text;
    // O texto já está na caixa: reenviar duplicaria. O aviso manda só apertar Enter lá quando ele parar.
    expect(text).toContain("Enter");
    expect(text).not.toContain("Reenvie quando ele parar");
    expect(text).not.toContain("Tento de novo sozinho");
  });

  it("não confirmado também não reagenda com o Vigia e o aviso de parado (fix 2)", () => {
    vi.mocked(showBotToast).mockClear();
    avisarBloqueio("aviso-nc-vigia", "vigia", "unconfirmed");
    avisarBloqueio("aviso-nc-parado", "stalled", "unconfirmed");
    const texts = vi.mocked(showBotToast).mock.calls.map(([arg]) => arg.text);
    expect(texts).toHaveLength(2);
    for (const text of texts) {
      expect(text).toContain("Enter");
      expect(text).not.toContain("sozinho");
    }
  });

  it("sem terminal tem texto próprio, e não diz que o agente está trabalhando (I9)", () => {
    avisarBloqueio("aviso-sem-terminal", "vigia", "no-terminal");
    const text = vi.mocked(showBotToast).mock.calls[0][0].text;
    expect(text).toContain("não tem terminal aberto");
    expect(text).not.toContain("trabalhando");
  });
});
