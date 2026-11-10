/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18next from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import pt from "@/i18n/locales/pt-BR.json";
import type { HarnessExecutionEvent, HarnessExecutionGraph, HarnessExecutionNode } from "@/features/runs/types";

const i18n = i18next.createInstance();
await i18n.init({ lng: "pt-BR", resources: { "pt-BR": { translation: pt } }, interpolation: { escapeValue: false } });

type Handler = (event: { payload: unknown }) => void;
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  attemptEvents: vi.fn(),
  invoke: vi.fn(async (..._args: unknown[]) => null),
  handlers: new Map<string, Set<(event: { payload: unknown }) => void>>(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => i18n.t(key, options), i18n }),
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: Handler) => {
    const set = mocks.handlers.get(name) ?? new Set<Handler>();
    set.add(handler);
    mocks.handlers.set(name, set);
    return () => { set.delete(handler); };
  }),
}));
vi.mock("@/features/runs/ipc", () => ({
  listHarnessExecutionGraph: (...args: unknown[]) => mocks.list(...args),
  readAttemptEvents: (...args: unknown[]) => mocks.attemptEvents(...args),
}));
vi.mock("@/features/chat/unified/selectionActions", () => ({ selectConversation: vi.fn() }));

import { HarnessRunFeed } from "../HarnessRunFeed";
import { useStructured } from "../store";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const node = (partial: Pick<HarnessExecutionNode, "id" | "kind" | "status"> & Partial<HarnessExecutionNode>): HarnessExecutionNode => ({
  parentId: null,
  depth: 0,
  title: partial.id,
  threadId: "raiz",
  runId: null,
  agentId: "claude-code",
  model: null,
  planKey: null,
  attempt: null,
  createdAt: 1_700_000_000_000,
  startedAt: 1_700_000_000_000,
  endedAt: null,
  ...partial,
});

const event = (sequence: number, kind: string, extra: Partial<HarnessExecutionEvent> = {}): HarnessExecutionEvent => ({
  sequence,
  nodeId: `event:${sequence}`,
  parentNodeId: "turn:raiz:t1",
  threadId: "raiz",
  turnId: "t1",
  runId: null,
  taskId: null,
  attemptId: null,
  kind,
  entityId: null,
  payload: {},
  createdAt: 1_700_000_000_000 + sequence,
  ...extra,
});

const NODES: HarnessExecutionNode[] = [
  node({ id: "thread:raiz", kind: "thread", status: "active", title: "Raiz" }),
  node({ id: "turn:raiz:t1", kind: "turn", status: "completed", parentId: "thread:raiz", depth: 1, chatRunId: "t1", runId: "t1" }),
  node({ id: "run:r1", kind: "fleetRun", status: "running", parentId: "turn:raiz:t1", depth: 2, runId: "r1", title: "Frota", executionStatus: "running" }),
  node({
    id: "task:k1", kind: "fleetTask", status: "running", parentId: "run:r1", depth: 3, title: "Testes", planKey: "tests",
    childType: "fleet_task", executionStatus: "running",
  }),
  node({ id: "attempt:a1", kind: "fleetAttempt", status: "failed", parentId: "task:k1", depth: 4, attempt: 1 }),
  node({ id: "attempt:a2", kind: "fleetAttempt", status: "running", parentId: "task:k1", depth: 4, attempt: 2 }),
];

const graph = (over: Partial<HarnessExecutionGraph> = {}): HarnessExecutionGraph => ({
  rootThreadId: "raiz", nodes: NODES, events: [], cursor: 10, reset: true, ...over,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  mocks.list.mockReset();
  mocks.attemptEvents.mockReset();
  mocks.attemptEvents.mockResolvedValue([]);
  mocks.invoke.mockClear();
  mocks.handlers.clear();
  useStructured.setState({ threads: [], live: {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const emit = async (name: string, payload: unknown) => {
  await act(async () => { for (const handler of [...(mocks.handlers.get(name) ?? [])]) handler({ payload }); });
};
const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };

async function open(first: HarnessExecutionGraph = graph()) {
  mocks.list.mockResolvedValue(first);
  await act(async () => { root.render(<HarnessRunFeed threadId="raiz" />); });
  await flush();
  const toggle = host.querySelector<HTMLButtonElement>("button[aria-expanded]");
  await act(async () => { toggle?.click(); });
}

const row = (id: string) => host.querySelector<HTMLElement>(`[role="treeitem"][data-node-id="${id}"]`);
const press = async (id: string, key: string) => {
  const target = row(id);
  if (!target) throw new Error(`sem a linha ${id}`);
  await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
};

describe("árvore do harness: teclado e acessibilidade", () => {
  it("é uma árvore com itens, nível e aria-expanded em cada nó", async () => {
    await open();
    const tree = host.querySelector('[role="tree"]');
    expect(tree).not.toBeNull();
    expect(row("turn:raiz:t1")?.getAttribute("aria-level")).toBe("1");
    expect(row("turn:raiz:t1")?.getAttribute("aria-expanded")).toBe("false");
    expect(row("run:r1")).toBeNull();
  });

  it("setas, Enter e Espaço abrem e fecham o nó, e a subárvore some e volta", async () => {
    await open();
    row("turn:raiz:t1")?.focus();
    await press("turn:raiz:t1", "ArrowRight");
    expect(row("turn:raiz:t1")?.getAttribute("aria-expanded")).toBe("true");
    expect(row("run:r1")).not.toBeNull();
    await press("turn:raiz:t1", "Enter");
    expect(row("turn:raiz:t1")?.getAttribute("aria-expanded")).toBe("false");
    expect(row("run:r1")).toBeNull();
    await press("turn:raiz:t1", " ");
    expect(row("turn:raiz:t1")?.getAttribute("aria-expanded")).toBe("true");
    await press("turn:raiz:t1", "ArrowLeft");
    expect(row("turn:raiz:t1")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("seta para baixo e para cima movem o foco e só uma linha entra na ordem de Tab", async () => {
    await open();
    await press("turn:raiz:t1", "ArrowRight");
    row("turn:raiz:t1")?.focus();
    await press("turn:raiz:t1", "ArrowDown");
    expect(document.activeElement).toBe(row("run:r1"));
    await press("run:r1", "ArrowUp");
    expect(document.activeElement).toBe(row("turn:raiz:t1"));
    const tabbable = [...host.querySelectorAll('[role="treeitem"]')].filter((el) => (el as HTMLElement).tabIndex === 0);
    expect(tabbable).toHaveLength(1);
  });

  it("tecla dentro de um botão da linha não alterna o nó", async () => {
    await open(graph({
      nodes: [
        ...NODES.slice(0, 1),
        node({ id: "thread:filha", kind: "thread", status: "active", parentId: "thread:raiz", depth: 1, threadId: "filha", title: "Revisar", childType: "provider_chat", executionStatus: "waiting", blocked: { kind: "question", count: 1 } }),
      ],
    }));
    const button = host.querySelector<HTMLButtonElement>('button[aria-label*="pergunta pendente"]');
    expect(button).not.toBeNull();
    await act(async () => { button?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(row("thread:filha")?.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("árvore do harness: detalhe sob demanda", () => {
  const withEvents = () => graph({
    events: [
      event(11, "tool.started", { entityId: "x", payload: { label: "src/segredo.rs" } }),
      event(12, "tool.completed", { entityId: "x", payload: { label: "src/segredo.rs" } }),
    ],
  });

  it("o cartão resumido não leva texto de evento; o detalhe só aparece quando o nó abre", async () => {
    await open(withEvents());
    expect(host.textContent).not.toContain("segredo.rs");
    await press("turn:raiz:t1", "Enter");
    expect(host.querySelector('[data-detail="turn:raiz:t1"]')).not.toBeNull();
    await press("turn:raiz:t1", "Enter");
    expect(host.querySelector('[data-detail="turn:raiz:t1"]')).toBeNull();
  });

  it("o log de uma tentativa só é lido quando ela abre, e uma vez só", async () => {
    mocks.attemptEvents.mockResolvedValue([{ kind: "tool", label: "grep" }]);
    await open();
    await press("turn:raiz:t1", "ArrowRight");
    await press("run:r1", "ArrowRight");
    await press("task:k1", "ArrowRight");
    expect(mocks.attemptEvents).not.toHaveBeenCalled();
    await press("attempt:a2", "Enter");
    await flush();
    expect(mocks.attemptEvents).toHaveBeenCalledTimes(1);
    expect(mocks.attemptEvents).toHaveBeenCalledWith("a2");
    expect(host.textContent).toContain("grep");
    await press("attempt:a2", "Enter");
    await press("attempt:a2", "Enter");
    await flush();
    expect(mocks.attemptEvents).toHaveBeenCalledTimes(1);
  });

  it("a tarefa mostra quantas tentativas teve e cada tentativa o seu estado final", async () => {
    await open();
    await press("turn:raiz:t1", "ArrowRight");
    await press("run:r1", "ArrowRight");
    expect(row("task:k1")?.textContent).toContain("2 tentativas");
    await press("task:k1", "ArrowRight");
    expect(row("attempt:a1")?.textContent).toContain("Tentativa 1");
    expect(row("attempt:a1")?.textContent).toContain("falhou");
    expect(row("attempt:a2")?.textContent).toContain("em andamento");
  });
});

describe("árvore do harness: cursor sem polling", () => {
  const delta = (cursor: number, events: HarnessExecutionEvent[], over: Partial<HarnessExecutionGraph> = {}) =>
    graph({ cursor, events, reset: false, ...over });

  it("a carga inicial pede a árvore inteira (sem cursor)", async () => {
    await open();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith("raiz", null);
  });

  it("o aviso com cursor novo pede só o delta, a partir do cursor aplicado", async () => {
    await open(graph({ events: [event(10, "turn.started", { entityId: "t1" })] }));
    mocks.list.mockResolvedValueOnce(delta(12, [event(11, "tool.started", { entityId: "x" }), event(12, "turn.ended", { entityId: "t1" })]));
    await emit("cc-harness-event", { threadId: "raiz", cursor: 12 });
    await flush();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.list).toHaveBeenLastCalledWith("raiz", 10);
    await press("turn:raiz:t1", "Enter");
    expect(host.querySelector('[data-detail="turn:raiz:t1"]')?.textContent).toContain("Turno concluído");
    expect(host.querySelector('[data-detail="turn:raiz:t1"]')?.textContent).toContain("Turno iniciado");
  });

  it("aviso repetido, antigo ou de outra conversa não chama o backend", async () => {
    await open();
    await emit("cc-harness-event", { threadId: "raiz", cursor: 10 });
    await emit("cc-harness-event", { threadId: "raiz", cursor: 4 });
    await emit("cc-harness-event", { threadId: "de-outra", cursor: 99 });
    await emit("cc-harness-event", "raiz");
    await flush();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("um reset do backend troca os eventos em vez de somar", async () => {
    await open(graph({ events: [event(10, "turn.started", { entityId: "t1" })] }));
    mocks.list.mockResolvedValueOnce(graph({ cursor: 50, reset: true, events: [event(50, "turn.interrupted", { entityId: "t1" })] }));
    await emit("cc-harness-event", { threadId: "raiz", cursor: 50 });
    await flush();
    await press("turn:raiz:t1", "Enter");
    const detail = host.querySelector('[data-detail="turn:raiz:t1"]')?.textContent ?? "";
    expect(detail).toContain("Turno interrompido");
    expect(detail).not.toContain("Turno iniciado");
  });

  it("uma rajada durante a leitura vira uma única leitura seguinte, com o cursor aplicado", async () => {
    await open();
    let resolveFirst: (value: HarnessExecutionGraph) => void = () => {};
    mocks.list.mockImplementationOnce(() => new Promise<HarnessExecutionGraph>((resolve) => { resolveFirst = resolve; }));
    await emit("cc-harness-event", { threadId: "raiz", cursor: 11 });
    await emit("cc-harness-event", { threadId: "raiz", cursor: 12 });
    await emit("cc-harness-event", { threadId: "raiz", cursor: 13 });
    expect(mocks.list).toHaveBeenCalledTimes(2);
    mocks.list.mockResolvedValueOnce(delta(13, []));
    await act(async () => { resolveFirst(delta(12, [event(12, "tool.completed", { entityId: "x" })])); });
    await flush();
    expect(mocks.list).toHaveBeenCalledTimes(3);
    expect(mocks.list).toHaveBeenLastCalledWith("raiz", 12);
  });

  it("não há polling: com o tempo correndo e sem aviso, nenhuma leitura nova", async () => {
    await open();
    await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60 * 1000); });
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("mudança de tarefa ou de run da Frota também atualiza, sem esperar evento do log", async () => {
    await open();
    mocks.list.mockResolvedValue(delta(10, []));
    await emit("cc-task-changed", "k1");
    await flush();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.list).toHaveBeenLastCalledWith("raiz", 10);
    await emit("cc-thread-run-changed", "raiz");
    await flush();
    expect(mocks.list).toHaveBeenCalledTimes(3);
  });

  it("muitos eventos não geram nenhuma mensagem de chat nem comando de envio", async () => {
    await open();
    const before = useStructured.getState();
    for (let cursor = 11; cursor <= 40; cursor += 1) {
      mocks.list.mockResolvedValueOnce(delta(cursor, [event(cursor, cursor % 2 ? "tool.started" : "tool.completed", { entityId: `e${cursor}` })]));
      await emit("cc-harness-event", { threadId: "raiz", cursor });
      await flush();
    }
    expect(useStructured.getState().live).toBe(before.live);
    expect(useStructured.getState().threads).toBe(before.threads);
    const commands = mocks.invoke.mock.calls.map(([command]) => String(command));
    expect(commands.filter((command) => /send|message|post|notify/i.test(command))).toEqual([]);
  });
});

describe("árvore do harness: consolidação", () => {
  const many = () => [
    event(11, "turn.started", { entityId: "t1" }),
    ...Array.from({ length: 40 }, (_, i) => event(12 + i, i % 2 ? "tool.completed" : "tool.started", { entityId: `x${i}`, payload: { label: `src/arq${i}.rs` } })),
    event(60, "tool.failed", { entityId: "x1", payload: { label: "src/quebrou.rs" } }),
  ];

  it("40 chamadas de ferramenta viram uma linha de resumo; a falha continua em destaque", async () => {
    await open(graph({ events: many() }));
    await press("turn:raiz:t1", "Enter");
    const detail = host.querySelector('[data-detail="turn:raiz:t1"]');
    expect(detail?.textContent).toContain("40 eventos de rotina");
    expect(detail?.textContent).toContain("Ferramenta falhou");
    expect(detail?.textContent).not.toContain("arq7.rs");
  });

  it("'ver todos os eventos' abre o texto de cada um, sob pedido", async () => {
    await open(graph({ events: many() }));
    await press("turn:raiz:t1", "Enter");
    const all = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Ver todos os eventos");
    expect(all).toBeDefined();
    await act(async () => { all?.click(); });
    expect(host.querySelector('[data-detail="turn:raiz:t1"]')?.textContent).toContain("arq7.rs");
  });

  it("evento ainda aberto aparece como em andamento e o fechado como registrado", async () => {
    await open(graph({ events: [event(11, "tool.started", { entityId: "aberta" }), event(12, "tool.started", { entityId: "fechada" }), event(13, "tool.completed", { entityId: "fechada" })] }));
    await press("turn:raiz:t1", "Enter");
    const all = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Ver todos os eventos");
    await act(async () => { all?.click(); });
    const rows = [...host.querySelectorAll<HTMLElement>("[data-event-seq]")];
    expect(rows.find((el) => el.dataset.eventSeq === "11")?.dataset.phase).toBe("inProgress");
    expect(rows.find((el) => el.dataset.eventSeq === "12")?.dataset.phase).toBe("persisted");
    expect(rows.find((el) => el.dataset.eventSeq === "13")?.dataset.phase).toBe("persisted");
  });
});

describe("árvore do harness: estados que a pessoa precisa ver", () => {
  const states = () => graph({
    nodes: [
      node({ id: "thread:raiz", kind: "thread", status: "active" }),
      node({ id: "task:espera", kind: "fleetTask", status: "running", parentId: "thread:raiz", depth: 1, title: "Espera", childType: "fleet_task", executionStatus: "waiting", blocked: { kind: "approval", count: 1 } }),
      node({ id: "task:parou", kind: "fleetTask", status: "interrupted", parentId: "thread:raiz", depth: 1, title: "Parou", childType: "fleet_task", executionStatus: "interrupted" }),
      node({ id: "task:cancelou", kind: "fleetTask", status: "cancelled", parentId: "thread:raiz", depth: 1, title: "Cancelou", childType: "fleet_task", executionStatus: "cancelled" }),
      node({ id: "turn:raiz:t9", kind: "turn", status: "interrupted", parentId: "thread:raiz", depth: 1, interruptionReason: "O processo do ADE foi fechado.", outcomeUnknown: true }),
    ],
  });

  it("espera de pessoa, interrupção, cancelamento e resultado desconhecido aparecem em texto, não só em cor", async () => {
    await open(states());
    expect(row("task:espera")?.textContent).toContain("aguardando você");
    expect(row("task:espera")?.textContent).toContain("aprovação pendente");
    expect(row("task:parou")?.textContent).toContain("interrompida");
    expect(row("task:cancelou")?.textContent).toContain("cancelada");
    expect(row("turn:raiz:t9")?.textContent).toContain("resultado desconhecido");
    expect(row("task:espera")?.dataset.state).toBe("waiting");
    expect(row("task:parou")?.dataset.state).toBe("interrupted");
    expect(row("task:cancelou")?.dataset.state).toBe("cancelled");
    expect(row("turn:raiz:t9")?.dataset.state).toBe("unknown");
  });

  it("todas as linhas são alcançáveis pelo teclado, e o detalhe mostra o motivo da interrupção", async () => {
    await open(states());
    for (const id of ["task:espera", "task:parou", "task:cancelou", "turn:raiz:t9"]) {
      expect(row(id)?.hasAttribute("tabindex")).toBe(true);
    }
    await press("turn:raiz:t9", "Enter");
    expect(host.querySelector('[data-detail="turn:raiz:t9"]')?.textContent).toContain("O processo do ADE foi fechado.");
    expect(host.querySelector('[data-detail="turn:raiz:t9"]')?.textContent).toContain("Estado final");
  });
});
