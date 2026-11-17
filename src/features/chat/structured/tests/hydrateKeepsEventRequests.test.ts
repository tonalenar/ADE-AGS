import { beforeEach, describe, expect, it, vi } from "vitest";

// As leituras do banco são simuladas: o teste segura a leitura de pedidos até chegar um pedido por evento.
const db = vi.hoisted(() => ({ items: vi.fn(), requests: vi.fn(), status: vi.fn(), goal: vi.fn(), provider: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return {
    ...actual,
    chatThreadItems: db.items,
    chatThreadRequests: db.requests,
    chatThreadStatus: db.status,
    chatThreadGoalGet: db.goal,
    chatThreadProviderConfig: db.provider,
  };
});

import { hydrateThread, useStructured } from "../store";

const request = (id: string) => ({ id, threadId: "t1", kind: "command", itemId: null, title: id, detail: "", options: null, state: "pending", createdAt: 1 }) as never;

beforeEach(() => {
  vi.useFakeTimers();
  useStructured.setState({ threads: [], live: {}, goals: {}, goalNotices: {}, hydrated: {}, hydrateErrors: {}, logFailures: {} });
  db.items.mockReset().mockResolvedValue([]);
  db.requests.mockReset().mockResolvedValue([]);
  db.status.mockReset().mockResolvedValue({ working: false });
  db.goal.mockReset().mockResolvedValue(null);
  db.provider.mockReset().mockResolvedValue(null);
});

describe("a releitura da conversa não perde pedido que chegou por evento durante a leitura", () => {
  it("pedido do evento fica quando o banco devolve outros pedidos (lista não vazia)", async () => {
    let answer: (rows: unknown[]) => void = () => undefined;
    db.requests.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    hydrateThread("t1");
    // Chega por evento enquanto a leitura de pedidos ainda está no banco.
    useStructured.setState((s) => ({ live: { ...s.live, t1: { ...(s.live.t1 ?? { items: [], requests: [], phase: "idle", drafts: [], error: null, providerCommands: [], providerConfig: null }), requests: [request("novo")] } } }) as never);
    answer([request("antigo")]);
    await vi.runAllTimersAsync();
    expect(useStructured.getState().live.t1!.requests.map((r) => r.id)).toEqual(["antigo", "novo"]);
  });
});
