// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FunctionalRole, Squad } from "@/features/squads/types";
import { activitySnapshot, markOutput } from "@/features/terminal/activity";
import {
  pasteIntoTab,
  pasteStillPending,
  registerTerminal,
  screenOf,
  sendWhenReady,
  START_CHECK_MS,
  START_DEADLINE_MS,
  SUBMIT_RETRY_MS,
  type SendTimings,
} from "@/features/terminal/terminalRegistry";

import { useStallAlerts } from "../stallAlerts";
import { startMissionInTerminals } from "../terminals";
import { missionTurns } from "../turns";
import type { Mission } from "../types";

// Polyfill window in case happy-dom globals are partially shadowed
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = globalThis;
}

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  addTab: vi.fn(),
  activateTab: vi.fn(),
  board: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/features/accounts/store", () => ({
  useAccountsStore: { getState: () => ({ accounts: [] }) },
}));
vi.mock("@/features/tabs/store", () => ({
  useTabsStore: {
    getState: () => ({
      addTab: mocks.addTab,
      activateTab: mocks.activateTab,
      detectedAgents: [
        { id: "codex", command: "codex", available: true },
        { id: "claude-code", command: "claude", available: true },
      ],
      tabs: [],
    }),
  },
}));
vi.mock("@/features/canvas/store", () => ({
  canvasActions: { buildMissionTeam: mocks.board },
  missionBoardKey: () => "mission-board",
  setWorkMode: vi.fn(),
}));
vi.mock("../autonomy", () => ({
  getAutonomy: () => "safe",
  withAutonomy: (_id: string, command: string) => command,
}));

/**
 * Terminal simulado compatível com a interface usada por `terminalRegistry`.
 * Suporta tela normal e tela alternativa (alt screen), registro de callbacks
 * de parse de escrita, entradas (`\r`) e colagens.
 */
class SimulatedTerminal {
  public rows = 24;
  public lines: string[] = [];
  public isAlt = false;
  public inputs: string[] = [];
  public pastes: string[] = [];
  public dataListeners = new Set<(data: string) => void>();
  public writeParsedListeners = new Set<() => void>();
  public onInputReceived?: (data: string) => void;

  constructor(lines: string[] = [], isAlt = false) {
    this.lines = [...lines];
    this.isAlt = isAlt;
  }

  get buffer() {
    return {
      active: {
        type: this.isAlt ? "alternate" : "normal",
        baseY: 0,
        cursorY: Math.max(0, this.lines.length - 1),
        viewportY: 0,
        length: Math.max(this.lines.length, this.rows),
        getLine: (y: number) => ({
          translateToString: (_trimRight?: boolean) => this.lines[y] ?? "",
        }),
      },
    };
  }

  onWriteParsed(fn: () => void) {
    this.writeParsedListeners.add(fn);
    return {
      dispose: () => {
        this.writeParsedListeners.delete(fn);
      },
    };
  }

  onData(fn: (data: string) => void) {
    this.dataListeners.add(fn);
    return {
      dispose: () => {
        this.dataListeners.delete(fn);
      },
    };
  }

  paste(text: string) {
    this.pastes.push(text);
  }

  input(data: string) {
    this.inputs.push(data);
    for (const listener of this.dataListeners) {
      listener(data);
    }
    this.onInputReceived?.(data);
  }

  focus() {
    // noop
  }

  emitOutput(newLines?: string[]) {
    if (newLines) {
      this.lines.push(...newLines);
    }
    for (const fn of [...this.writeParsedListeners]) {
      fn();
    }
  }

  setLines(newLines: string[], isAlt = this.isAlt) {
    this.lines = [...newLines];
    this.isAlt = isAlt;
  }
}

const cleanups: Array<() => void> = [];

function registerSimulated(tabId: string, term: SimulatedTerminal): SimulatedTerminal {
  const unregister = registerTerminal(tabId, term as unknown as import("@xterm/xterm").Terminal);
  cleanups.push(unregister);
  return term;
}

const workspace = (name: string, path: string) => ({
  name,
  cwd: path,
  root: path,
  branch: `cc/${name.toLowerCase()}`,
  cargoTargetDir: `${path}/target`,
  prelaunch: `set target=${path}`,
  environment: `ENV ${path}`,
});

describe("Teste ponta a ponta do início de missão com terminais simulados", () => {
  const recordedSpans: Array<{ missionId: string; span: { kind: string; actor?: string; detail?: string; startedMs: number; endedMs: number } }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    recordedSpans.length = 0;
    cleanups.splice(0, cleanups.length).forEach((fn) => fn());

    mocks.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "mission_prepare_team") {
        return {
          workspaces: [
            workspace("Orquestrador", "C:/projects/app/wt/lead"),
            workspace("Backend", "C:/projects/app/wt/backend"),
            workspace("Frontend", "C:/projects/app/wt/frontend"),
            workspace("QA", "C:/projects/app/wt/qa"),
          ],
          precheck: "ACHADOS ANTERIORES",
          memory: "MEMORIA RECENTE",
        };
      }
      if (cmd === "mission_timing_add") {
        recordedSpans.push(args as unknown as { missionId: string; span: { kind: string; actor?: string; detail?: string; startedMs: number; endedMs: number } });
        return {};
      }
      return {};
    });
  });

  afterEach(() => {
    cleanups.splice(0, cleanups.length).forEach((fn) => fn());
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("todos os agentes arrancam em 2 min sem Enter manual (briefing, TUIs, retentativas e aviso de agente parado)", async () => {
    const mission = {
      id: "m-e2e-1",
      title: "Missão E2E",
      objective: "Desenvolver feature com equipe completa",
      cwd: "C:/projects/app",
      leadAgentId: "codex",
      autoAccount: true,
    } as Mission;

    const squad: Squad = {
      id: "sq-1",
      name: "Squad E2E",
      description: "",
      createdAt: 0,
      updatedAt: 0,
      available: true,
      unavailableReasons: [],
      lead: {
        agentId: "codex",
        model: null,
        accountId: null,
        autoAccount: true,
        complexity: null,
        availability: "available",
        unavailableReason: null,
      },
      members: [
        {
          roleId: "backend",
          agentId: "codex",
          model: null,
          accountId: null,
          autoAccount: true,
          complexity: null,
          isolateDefault: false,
          availability: "available",
          unavailableReason: null,
        },
        {
          roleId: "frontend",
          agentId: "claude-code",
          model: null,
          accountId: null,
          autoAccount: true,
          complexity: null,
          isolateDefault: false,
          availability: "available",
          unavailableReason: null,
        },
        {
          roleId: "qa",
          agentId: "codex",
          model: null,
          accountId: null,
          autoAccount: true,
          complexity: null,
          isolateDefault: false,
          availability: "available",
          unavailableReason: null,
        },
      ],
    };

    const roles: FunctionalRole[] = [
      { id: "backend", label: "Backend", description: "API e banco", instructions: "Crie a API" },
      { id: "frontend", label: "Frontend", description: "Interface", instructions: "Crie as telas" },
      { id: "qa", label: "QA", description: "Testes automatizados", instructions: "Rode os testes" },
    ];

    const leadTabId = "tab-e2e-lead";
    const backendTabId = "tab-e2e-backend";
    const frontendTabId = "tab-e2e-frontend";
    const qaTabId = "tab-e2e-qa";

    mocks.addTab
      .mockReturnValueOnce(leadTabId)
      .mockReturnValueOnce(backendTabId)
      .mockReturnValueOnce(frontendTabId)
      .mockReturnValueOnce(qaTabId);

    // Cria os 4 terminais simulados
    const leadTerm = new SimulatedTerminal(["$ codex --model o3-mini"]);
    const backendTerm = new SimulatedTerminal(["$ codex"]);
    // Frontend em alt screen (como Claude Code em tela cheia)
    const frontendTerm = new SimulatedTerminal(["$ claude"], true);
    // QA: agente que nunca arrancará
    const qaTerm = new SimulatedTerminal(["$ codex"]);

    // 1. Inicia a missão pelas funções do sistema
    const started = await startMissionInTerminals(mission, squad, roles);
    expect(started.leadTabId).toBe(leadTabId);
    expect(started.memberTabIds).toEqual([backendTabId, frontendTabId, qaTabId]);

    // 2. Registra as abas nos terminais simulados
    registerSimulated(leadTabId, leadTerm);
    registerSimulated(backendTabId, backendTerm);
    registerSimulated(frontendTabId, frontendTerm);
    registerSimulated(qaTabId, qaTerm);

    // 3. Emite a saída inicial de boot em cada terminal
    leadTerm.emitOutput(["Codex v0.2 pronto.", "› "]);
    backendTerm.emitOutput(["Codex v0.2 pronto.", "› "]);
    frontendTerm.emitOutput(["Claude Code v1.0", "❯ "]);
    qaTerm.emitOutput(["Codex v0.2 pronto.", "› "]);

    // 4. Aguarda o tempo de estabilização (SETTLE_MS = 2500ms)
    expect(leadTerm.pastes).toHaveLength(0);
    expect(backendTerm.pastes).toHaveLength(0);

    vi.advanceTimersByTime(2500);

    // Todos os briefings foram colados automaticamente!
    expect(leadTerm.pastes).toHaveLength(1);
    expect(leadTerm.pastes[0]).toContain("missão \"Missão E2E\"");
    expect(backendTerm.pastes).toHaveLength(1);
    expect(backendTerm.pastes[0]).toContain("Backend");
    expect(frontendTerm.pastes).toHaveLength(1);
    expect(frontendTerm.pastes[0]).toContain("Frontend");
    expect(qaTerm.pastes).toHaveLength(1);
    expect(qaTerm.pastes[0]).toContain("QA");

    // Spans de start_briefing registrados
    const briefingSpans = recordedSpans.filter((s) => s.span.kind === "start_briefing");
    expect(briefingSpans.map((s) => s.span.actor)).toEqual(["Orquestrador", "Backend", "Frontend", "QA"]);

    // 5. Após 80ms, o primeiro Enter (\r) é disparado pelo pasteIntoTab
    vi.advanceTimersByTime(80);
    expect(leadTerm.inputs).toContain("\r");
    expect(backendTerm.inputs).toContain("\r");
    expect(frontendTerm.inputs).toContain("\r");
    expect(qaTerm.inputs).toContain("\r");

    // Simulação do comportamento das TUIs:
    // - Lead: aceitou o Enter imediatamente e começou a trabalhar
    leadTerm.setLines(["Pensando no plano da missão..."]);

    // - Backend (Codex): colagem grande engoliu o Enter inicial!
    // A tela mostra o marcador de colagem pendente no prompt
    backendTerm.setLines([
      "─── Entrada ───",
      "› [Pasted Content 3904 chars]",
      "",
      "  medium · ~\\ADE-AGS",
    ]);

    // - Frontend (Claude Code em alt screen): engoliu o Enter inicial!
    // A tela alternativa mostra o marcador de colagem pendente
    frontendTerm.setLines(
      [
        "────────────────────────────────────────",
        "❯ [Pasted text #1 +30 lines]",
        "────────────────────────────────────────",
      ],
      true,
    );

    // - QA: terminal não mostra marcador pendente, mas não produzirá saída de trabalho

    // 6. SUBMIT_RETRY_MS: aos 900ms (SUBMIT_RETRY_MS[0]) após o envio, o sistema verifica a tela
    expect(SUBMIT_RETRY_MS[0]).toBe(900);
    const backendInputsBeforeRetry = backendTerm.inputs.length;
    const frontendInputsBeforeRetry = frontendTerm.inputs.length;

    vi.advanceTimersByTime(SUBMIT_RETRY_MS[0] - 80);

    // Detectou [Pasted Content 3904 chars] e [Pasted text #1 +30 lines]!
    // Reenviou Enter para Backend e Frontend automaticamente sem intervenção manual!
    expect(backendTerm.inputs.length).toBe(backendInputsBeforeRetry + 1);
    expect(backendTerm.inputs[backendTerm.inputs.length - 1]).toBe("\r");

    expect(frontendTerm.inputs.length).toBe(frontendInputsBeforeRetry + 1);
    expect(frontendTerm.inputs[frontendTerm.inputs.length - 1]).toBe("\r");

    // onRetry chamou recordSpan gravando start_retry para Backend e Frontend
    const retrySpans = recordedSpans.filter((s) => s.span.kind === "start_retry");
    expect(retrySpans.some((s) => s.span.actor === "Backend")).toBe(true);
    expect(retrySpans.some((s) => s.span.actor === "Frontend")).toBe(true);

    // TUIs recebem o Enter reenviado e processam o comando
    backendTerm.setLines(["› Processando tarefa do backend...", "Criando schemas..."]);
    frontendTerm.setLines(["❯ Analisando briefing...", "Renderizando componentes..."], true);

    const members = new Map([
      [leadTabId, { mission: mission.id, actor: "Orquestrador" }],
      [backendTabId, { mission: mission.id, actor: "Backend" }],
      [frontendTabId, { mission: mission.id, actor: "Frontend" }],
      [qaTabId, { mission: mission.id, actor: "QA" }],
    ]);

    // 7. Agentes emitem saída após ECHO_MS (4000ms após envio = +3100ms agora)
    vi.advanceTimersByTime(4000);
    backendTerm.emitOutput(["[backend] Arquivo api.ts criado."]);
    markOutput(backendTabId, "codex");

    frontendTerm.emitOutput(["[frontend] Tela principal montada."]);
    markOutput(frontendTabId, "claude-code");

    // onActivity disparado via watchStart -> start_activity registrado para Backend e Frontend
    const activitySpans = recordedSpans.filter((s) => s.span.kind === "start_activity");
    expect(activitySpans.some((s) => s.span.actor === "Backend")).toBe(true);
    expect(activitySpans.some((s) => s.span.actor === "Frontend")).toBe(true);

    // Amostra atividade enquanto o agente trabalha (como o watcher faz a cada segundo)
    missionTurns.sample(activitySnapshot(), members, Date.now());

    // QA continua calado (não produz saída após ECHO_MS)

    // 8. Aos 25s após o envio do briefing (START_CHECK_MS = 25000ms):
    // Decorrido desde o envio: 900ms + 4000ms = 4900ms.
    // Falta avançar START_CHECK_MS - 4900ms = 20100ms.
    expect(START_CHECK_MS).toBe(25_000);
    const qaInputsBeforeCheck = qaTerm.inputs.length;
    const leadPastesBeforeCheck = leadTerm.pastes.length;

    vi.advanceTimersByTime(START_CHECK_MS - 4900);

    // Backend e Frontend tiveram atividade detectada após ECHO_MS -> NÃO foram dados como stalled!
    // QA NUNCA arrancou:
    // - Recebeu mais um Enter no seu próprio terminal (tentativa de despertar)
    expect(qaTerm.inputs.length).toBe(qaInputsBeforeCheck + 1);
    expect(qaTerm.inputs[qaTerm.inputs.length - 1]).toBe("\r");

    // - Callback onRetry e onStalled disparados para QA
    expect(recordedSpans.filter((s) => s.span.kind === "start_stalled" && s.span.actor === "QA")).toHaveLength(1);
    expect(recordedSpans.filter((s) => s.span.kind === "start_retry" && s.span.actor === "QA")).toHaveLength(1);

    // - Orquestrador recebeu o aviso explícito colado no seu terminal!
    expect(leadTerm.pastes.length).toBe(leadPastesBeforeCheck + 1);
    const avisoOrquestrador = leadTerm.pastes[leadTerm.pastes.length - 1];
    expect(avisoOrquestrador).toContain("[AGS] QA não mostrou atividade após o briefing (recebeu um Enter).");
    expect(avisoOrquestrador).toContain("Confirme se ele está trabalhando; se não, reenvie a tarefa dele com ags peer tell.");

    // 80ms depois, o aviso no orquestrador é enviado com Enter
    vi.advanceTimersByTime(80);
    expect(leadTerm.inputs[leadTerm.inputs.length - 1]).toBe("\r");

    // 9. Amostragem de turnos no missionTurns
    // Após período de silêncio (> 5s QUIET_MS), o turno do briefing do Backend é concluído
    const completedTurns = missionTurns.sample(activitySnapshot(), members, Date.now());
    expect(completedTurns.length).toBeGreaterThanOrEqual(1);
    const backendTurn = completedTurns.find((c) => c.span.actor === "Backend");
    expect(backendTurn).toBeDefined();
    expect(backendTurn).toMatchObject({
      mission: mission.id,
      span: {
        actor: "Backend",
        detail: "briefing",
        kind: "turn",
      },
    });

    // 10. Tempo total decorrido está bem abaixo de 2 minutos (START_DEADLINE_MS = 120_000ms)
    // 2500ms + 25000ms + 6000ms = 33500ms (~33,5s)
    // Todos os agentes arrancaram ou tiveram diagnóstico em tempo hábil sem Enter manual!
  });

  describe("Detecção e reenvio de Enter com marcadores de colagem de TUIs e callbacks", () => {
    it("reconhece marcadores '[Pasted Content N chars]' em tela normal, reenvia Enter e invoca onRetry", () => {
      const tabId = "tab-paste-content";
      const term = new SimulatedTerminal([
        "linha 1",
        "linha 2",
        "› [Pasted Content 500 chars]",
        "",
      ]);
      registerSimulated(tabId, term);

      const retryTimes: number[] = [];
      const onRetry = (at: number) => retryTimes.push(at);

      // Cola com submit ativo e callback onRetry
      pasteIntoTab(tabId, "texto grande", true, onRetry);
      expect(term.inputs).toHaveLength(0);

      // Enter inicial aos 80ms
      vi.advanceTimersByTime(80);
      expect(term.inputs).toEqual(["\r"]);
      expect(retryTimes).toHaveLength(0);

      // Aos 900ms (SUBMIT_RETRY_MS[0]), marcador ainda presente -> reenvia Enter e chama onRetry
      vi.advanceTimersByTime(900 - 80);
      expect(term.inputs).toEqual(["\r", "\r"]);
      expect(retryTimes).toHaveLength(1);

      // TUI processa e remove marcador
      term.setLines(["linha 1", "linha 2", "› Executando..."]);

      // Aos 2200ms (SUBMIT_RETRY_MS[1]), marcador não está mais presente -> não reenvia nem chama onRetry
      vi.advanceTimersByTime(2200 - 900);
      expect(term.inputs).toEqual(["\r", "\r"]);
      expect(retryTimes).toHaveLength(1);
    });

    it("reconhece marcadores '[Pasted text #1 +N lines]' em alt screen (Claude Code), reenvia Enter e invoca onRetry", () => {
      const tabId = "tab-paste-alt";
      const term = new SimulatedTerminal(
        [
          "────────────────────────────────────────────",
          "❯ [Pasted text #1 +45 lines]",
          "────────────────────────────────────────────",
        ],
        true, // alternate buffer
      );
      registerSimulated(tabId, term);

      const screen = screenOf(tabId, null, 12);
      expect(screen).not.toBeNull();
      expect(screen?.alt).toBe(true);
      expect(pasteStillPending(screen!.lines)).toBe(true);

      const retryTimes: number[] = [];
      pasteIntoTab(tabId, "texto longo", true, (at) => retryTimes.push(at));
      vi.advanceTimersByTime(80);
      expect(term.inputs).toEqual(["\r"]);

      // Aos 900ms: retry ativado pelo marcador pendente na tela alternativa
      vi.advanceTimersByTime(900 - 80);
      expect(term.inputs).toEqual(["\r", "\r"]);
      expect(retryTimes).toHaveLength(1);

      // Remove marcador
      term.setLines(["────────────────────────────────────────────", "❯ Thinking...", "────────────────────────────────────────────"], true);
      vi.advanceTimersByTime(2200 - 900);
      expect(term.inputs).toEqual(["\r", "\r"]);
      expect(retryTimes).toHaveLength(1);
    });
  });

  describe("Agente que nunca arranca", () => {
    it("reenvia Enter ao agente, invoca onRetry e onStalled e alerta a orquestradora aos 25s", () => {
      const leadTabId = "tab-stalled-lead";
      const memberTabId = "tab-stalled-member";

      const leadTerm = new SimulatedTerminal(["› "]);
      const memberTerm = new SimulatedTerminal(["› "]);

      registerSimulated(leadTabId, leadTerm);
      registerSimulated(memberTabId, memberTerm);

      let stalledCalled = false;
      const retryCalls: number[] = [];
      const timings: SendTimings = {
        onRetry: (at) => retryCalls.push(at),
        onStalled: () => {
          stalledCalled = true;
          pasteIntoTab(
            leadTabId,
            "[AGS] QA não mostrou atividade após o briefing (recebeu um Enter). Confirme se ele está trabalhando; se não, reenvie a tarefa dele com ags peer tell.",
            true,
          );
        },
      };

      // Dispara envio
      sendWhenReady(memberTabId, "Briefing do QA", timings);

      // Boot e settle (2500ms)
      memberTerm.emitOutput(["Iniciando TUI..."]);
      vi.advanceTimersByTime(2500);

      expect(memberTerm.pastes).toHaveLength(1);
      vi.advanceTimersByTime(80);
      expect(memberTerm.inputs).toEqual(["\r"]);

      // Emite eco dentro de ECHO_MS (<= 4000ms), que é ignorado como atividade
      vi.advanceTimersByTime(2000);
      memberTerm.emitOutput(["eco da colagem..."]);

      // Avança até 25000ms após o envio (START_CHECK_MS)
      vi.advanceTimersByTime(23000);

      expect(stalledCalled).toBe(true);
      // Member recebeu novo Enter
      expect(memberTerm.inputs).toEqual(["\r", "\r"]);
      // onRetry chamado quando o Enter de stall foi enviado
      expect(retryCalls).toHaveLength(1);

      // Lead recebeu o aviso com Enter
      expect(leadTerm.pastes[0]).toContain("[AGS] QA não mostrou atividade após o briefing");
      vi.advanceTimersByTime(80);
      expect(leadTerm.inputs).toEqual(["\r"]);
    });

    it("quando o agente mostra atividade após 4s, invoca onActivity e não dispara aviso de stall aos 25s", () => {
      const leadTabId = "tab-active-lead";
      const memberTabId = "tab-active-member";

      const leadTerm = new SimulatedTerminal(["› "]);
      const memberTerm = new SimulatedTerminal(["› "]);

      registerSimulated(leadTabId, leadTerm);
      registerSimulated(memberTabId, memberTerm);

      let stalledCalled = false;
      const activityTimes: number[] = [];
      const timings: SendTimings = {
        onActivity: (at) => activityTimes.push(at),
        onStalled: () => {
          stalledCalled = true;
        },
      };

      sendWhenReady(memberTabId, "Briefing", timings);
      memberTerm.emitOutput(["Iniciando..."]);
      vi.advanceTimersByTime(2500); // settle
      vi.advanceTimersByTime(80); // enter

      // Aos 5000ms (> ECHO_MS = 4000ms), o agente produz saída real
      vi.advanceTimersByTime(5000 - 80);
      memberTerm.emitOutput(["Pensando na solução..."]);

      // onActivity invocado imediatamente
      expect(activityTimes).toHaveLength(1);

      // Avança até os 25000ms
      vi.advanceTimersByTime(20000);

      expect(stalledCalled).toBe(false);
      expect(leadTerm.pastes).toHaveLength(0);
    });
  });

  describe("Todos os agentes arrancando em até 120s (START_DEADLINE_MS)", () => {
    it("emite span start_all_working e atualiza stallAlerts quando toda a equipe mostra atividade", async () => {
      const mission = {
        id: "m-all-work",
        title: "Todos Trabalhando",
        objective: "Todos arrancam",
        cwd: "C:/projects/app",
        leadAgentId: "codex",
        autoAccount: true,
      } as Mission;

      const squad: Squad = {
        id: "sq-fast",
        name: "Squad Rápido",
        description: "",
        createdAt: 0,
        updatedAt: 0,
        available: true,
        unavailableReasons: [],
        lead: { agentId: "codex", model: null, accountId: null, autoAccount: true, complexity: null, availability: "available", unavailableReason: null },
        members: [
          { roleId: "backend", agentId: "codex", model: null, accountId: null, autoAccount: true, complexity: null, isolateDefault: false, availability: "available", unavailableReason: null },
        ],
      };

      const roles: FunctionalRole[] = [
        { id: "backend", label: "Backend", description: "API", instructions: "API" },
      ];

      mocks.addTab.mockReturnValueOnce("tab-all-lead").mockReturnValueOnce("tab-all-backend");

      const leadTerm = new SimulatedTerminal(["› "]);
      const backendTerm = new SimulatedTerminal(["› "]);

      await startMissionInTerminals(mission, squad, roles);
      registerSimulated("tab-all-lead", leadTerm);
      registerSimulated("tab-all-backend", backendTerm);

      leadTerm.emitOutput(["Pronto"]);
      backendTerm.emitOutput(["Pronto"]);
      vi.advanceTimersByTime(2500); // settle

      // Orquestrador mostra atividade aos 5s
      vi.advanceTimersByTime(5000);
      leadTerm.emitOutput(["Planejando tarefas..."]);

      // Backend mostra atividade aos 12s
      vi.advanceTimersByTime(7000);
      backendTerm.emitOutput(["Iniciando backend..."]);

      // Verifica que o span 'start_all_working' foi registrado para 'all'
      const allWorking = recordedSpans.find((s) => s.span.kind === "start_all_working");
      expect(allWorking).toBeDefined();
      expect(allWorking?.span.actor).toBe("all");

      // useStallAlerts foi atualizado sem pendências
      const st = useStallAlerts.getState().startup[mission.id];
      expect(st).toBeDefined();
      expect(st.pendingNames).toEqual([]);
      expect(st.allWorkingMs).toBeGreaterThan(0);

      // Avança até START_DEADLINE_MS (120s) para garantir que watchers finalizam limpos
      expect(START_DEADLINE_MS).toBe(120_000);
      vi.advanceTimersByTime(START_DEADLINE_MS);
    });
  });

  describe("Orquestrador (lead)", () => {
    it("grava start_stalled se não houver atividade, mas não cola aviso a si mesmo", () => {
      const leadTabId = "tab-lead-alone";
      const leadTerm = new SimulatedTerminal(["› "]);
      registerSimulated(leadTabId, leadTerm);

      let stalledCalled = false;
      const timings: SendTimings = {
        onStalled: () => {
          stalledCalled = true;
        },
      };

      sendWhenReady(leadTabId, "Briefing Líder", timings);
      leadTerm.emitOutput(["Pronto"]);
      vi.advanceTimersByTime(2500);
      vi.advanceTimersByTime(80);

      // Avança até 25s sem atividade
      vi.advanceTimersByTime(START_CHECK_MS);
      expect(stalledCalled).toBe(true);
    });
  });
});
