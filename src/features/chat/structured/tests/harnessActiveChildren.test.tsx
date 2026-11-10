/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18next from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import pt from "@/i18n/locales/pt-BR.json";
import type { HarnessExecutionGraph, HarnessExecutionNode } from "@/features/runs/types";

const i18n = i18next.createInstance();
await i18n.init({ lng: "pt-BR", resources: { "pt-BR": { translation: pt } }, interpolation: { escapeValue: false } });

const graphMock = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => i18n.t(key, options), i18n }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/features/runs/ipc", () => ({
  listHarnessExecutionGraph: (...args: unknown[]) => graphMock.list(...args),
  readAttemptEvents: vi.fn(async () => []),
}));
vi.mock("@/features/chat/unified/selectionActions", () => ({ selectConversation: vi.fn() }));

import { HarnessRunFeed } from "../HarnessRunFeed";

// @ts-expect-error Flag global do React para act em happy-dom
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const node = (partial: Pick<HarnessExecutionNode, "id" | "kind" | "status"> & Partial<HarnessExecutionNode>): HarnessExecutionNode => ({
  parentId: partial.kind === "thread" ? null : "thread:raiz",
  depth: partial.kind === "thread" ? 0 : 1,
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

const graph = (turn: Partial<HarnessExecutionNode>): HarnessExecutionGraph => ({
  rootThreadId: "raiz",
  events: [],
  nodes: [
    node({ id: "thread:raiz", kind: "thread", status: "active" }),
    node({ id: "turn:raiz:t1", kind: "turn", status: "completed", parentId: "thread:raiz", chatRunId: "t1", runId: "t1", ...turn }),
  ],
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  graphMock.list.mockReset();
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
  graphMock.list.mockResolvedValue(snapshot);
  await act(async () => { root.render(<HarnessRunFeed threadId="raiz" />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  const toggle = host.querySelector<HTMLButtonElement>("button[aria-expanded]");
  await act(async () => { toggle?.click(); });
}

const dotOf = (text: string) => [...host.querySelectorAll("span.rounded-full")].find((span) => span.parentElement?.textContent?.includes(text));

describe("filhos ativos no turno do harness", () => {
  it("mostra o texto no singular e no plural, e o ponto continua o do turno", async () => {
    await open(graph({ activeChildren: 1 }));
    expect(host.textContent).toContain("concluído");
    expect(host.textContent).toContain("1 filho ativo");
    expect(dotOf("1 filho ativo")?.className).toContain("bg-gray-400");
    expect(dotOf("1 filho ativo")?.className).not.toContain("emerald");

    await open(graph({ activeChildren: 3 }));
    expect(host.textContent).toContain("3 filhos ativos");
    expect(host.textContent).not.toContain("1 filho ativo");
  });

  it("não mostra com zero nem com o turno em andamento", async () => {
    await open(graph({ activeChildren: 0 }));
    expect(host.textContent).toContain("concluído");
    expect(host.textContent).not.toContain("filho ativo");

    await open(graph({ status: "inProgress", activeChildren: 4, endedAt: null }));
    expect(host.textContent).toContain("em andamento");
    expect(host.textContent).not.toContain("filho ativo");
    expect(dotOf("em andamento")?.className).toContain("bg-emerald-500");
  });
});
