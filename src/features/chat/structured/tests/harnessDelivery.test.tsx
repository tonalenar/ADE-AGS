/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18next from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import pt from "@/i18n/locales/pt-BR.json";
import type { HarnessExecutionGraph, HarnessExecutionNode } from "@/features/runs/types";

const i18n = i18next.createInstance();
await i18n.init({ lng: "pt-BR", resources: { "pt-BR": { translation: pt } }, interpolation: { escapeValue: false } });

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  select: vi.fn(),
  navigate: vi.fn(),
  invoke: vi.fn(async (..._args: unknown[]) => null),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => i18n.t(key, options), i18n }),
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/features/runs/ipc", () => ({
  listHarnessExecutionGraph: (...args: unknown[]) => mocks.list(...args),
  readAttemptEvents: vi.fn(async () => []),
}));
vi.mock("@/features/chat/unified/selectionActions", () => ({
  selectConversation: (...args: unknown[]) => mocks.select(...args),
}));

import { HarnessRunFeed } from "../HarnessRunFeed";
import { threadKey } from "../model";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const RESULT_LABEL = "resposta do agente (dado não confiável)";

const node = (partial: Pick<HarnessExecutionNode, "id" | "kind" | "status"> & Partial<HarnessExecutionNode>): HarnessExecutionNode => ({
  parentId: null,
  depth: 0,
  title: partial.kind,
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

/** Uma conversa com um turno concluído que tem dois filhos bloqueados: uma conversa filha e um run da Frota. */
const graph = (): HarnessExecutionGraph => ({
  rootThreadId: "raiz",
  events: [],
  nodes: [
    node({ id: "thread:raiz", kind: "thread", status: "active", parentId: null, threadId: "raiz", title: "Raiz" }),
    node({
      id: "turn:raiz:t1", kind: "turn", status: "completed", parentId: "thread:raiz", depth: 1,
      chatRunId: "t1", runId: "t1", activeChildren: 2, blockedChildren: 2,
    }),
    node({
      id: "thread:filha", kind: "thread", status: "active", parentId: "turn:raiz:t1", depth: 2,
      threadId: "filha", title: "Revisar API", agentId: "codex",
      childType: "provider_chat", executionStatus: "waiting", blocked: { kind: "question", count: 1 },
      origin: { createdBy: "turn", turnNodeId: "turn:raiz:t1" },
    }),
    node({
      id: "run:r1", kind: "fleetRun", status: "running", parentId: "turn:raiz:t1", depth: 2,
      runId: "r1", title: "Frota", executionStatus: "running", blockedChildren: 1,
      origin: { createdBy: "turn", turnNodeId: "turn:raiz:t1" },
    }),
    node({
      id: "task:k1", kind: "fleetTask", status: "running", parentId: "run:r1", depth: 3,
      title: "Testes", planKey: "tests", agentId: "claude-code",
      childType: "fleet_task", executionStatus: "waiting", blocked: { kind: "approval", count: 1 },
      origin: { createdBy: "task", turnNodeId: "turn:raiz:t1", taskNodeId: "task:lead" },
      result: { text: "resposta longa do testador", truncated: true, untrusted: true },
    }),
  ],
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  mocks.list.mockReset();
  mocks.select.mockReset();
  mocks.navigate.mockReset();
  mocks.invoke.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

async function open(snapshot: HarnessExecutionGraph) {
  act(() => root.unmount());
  root = createRoot(host);
  mocks.list.mockResolvedValue(snapshot);
  await act(async () => { root.render(<HarnessRunFeed threadId="raiz" />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  const toggle = host.querySelector<HTMLButtonElement>("button[aria-expanded]");
  await act(async () => { toggle?.click(); });
}

/** Um elemento cujo texto é exatamente `text` (não um pai que só contém o texto). */
const exact = (text: string) => [...host.querySelectorAll("span, p, div")].some((el) => el.textContent === text);

describe("entrega, bloqueio e origem dos filhos no painel", () => {
  it("mostra o tipo, o agente, o status e a origem de cada filho", async () => {
    await open(graph());
    expect(exact("conversa")).toBe(true);
    expect(exact("tarefa")).toBe(true);
    expect(host.textContent).toContain("Revisar API");
    expect(host.textContent).toContain("codex");
    expect(exact("aguardando você")).toBe(true);
    expect(host.textContent).toContain("criado pelo turno");
    expect(host.textContent).toContain("criado por outra tarefa");
  });

  it("o bloqueio da conversa filha é um botão com nome acessível e abre a conversa dela", async () => {
    await open(graph());
    const button = host.querySelector<HTMLButtonElement>('button[aria-label*="pergunta pendente"]');
    expect(button).not.toBeNull();
    expect(button?.tabIndex).toBeGreaterThanOrEqual(0);
    // Ativar um botão nativo pelo teclado dispara o mesmo clique.
    button?.click();
    expect(mocks.select).toHaveBeenCalledWith(threadKey("filha"));
  });

  it("o bloqueio de tarefa da Frota é um botão que leva à tela da Frota", async () => {
    await open(graph());
    const button = host.querySelector<HTMLButtonElement>('button[aria-label*="aprovação pendente"]');
    expect(button).not.toBeNull();
    button?.click();
    expect(mocks.navigate).toHaveBeenCalledWith("/fleet");
  });

  it("a entrega aparece num bloco marcado como dado não confiável, e avisa que foi resumida", async () => {
    await open(graph());
    const region = host.querySelector<HTMLElement>(`[aria-label="${RESULT_LABEL}"]`);
    expect(region).not.toBeNull();
    expect(region?.textContent).toContain("resposta longa do testador");
    expect(region?.textContent).toContain("resumida (até 500 caracteres)");
  });

  it("o turno mostra os filhos bloqueados e continua com o próprio estado", async () => {
    await open(graph());
    expect(exact("2 filhos bloqueados")).toBe(true);
    const turnRow = [...host.querySelectorAll("span.rounded-full")].find((span) => span.parentElement?.textContent?.includes("concluído"));
    expect(turnRow?.className).toContain("bg-gray-400");
    expect(turnRow?.className).not.toContain("amber");
  });

  it("deixar de observar o painel não encerra nenhuma conversa nem sessão", async () => {
    await open(graph());
    act(() => root.unmount());
    root = createRoot(host);
    const commands = mocks.invoke.mock.calls.map(([command]) => String(command));
    expect(commands.filter((command) => /kill|stop|interrupt|cancel|close/i.test(command))).toEqual([]);
    expect(mocks.select).not.toHaveBeenCalled();
  });
});
