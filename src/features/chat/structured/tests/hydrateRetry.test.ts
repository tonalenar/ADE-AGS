import { beforeEach, describe, expect, it, vi } from "vitest";

// As leituras do banco são simuladas: o teste controla quantas falham antes de a leitura dar certo.
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

import { hydrateThread, retryThreadHydration, useStructured } from "../store";

beforeEach(() => {
  vi.useFakeTimers();
  useStructured.setState({ threads: [], live: {}, goals: {}, goalNotices: {}, hydrated: {}, hydrateErrors: {}, logFailures: {} });
  db.items.mockReset().mockResolvedValue([]);
  db.requests.mockReset().mockResolvedValue([]);
  db.status.mockReset().mockResolvedValue({ working: false });
  db.goal.mockReset().mockResolvedValue(null);
  db.provider.mockReset().mockResolvedValue(null);
});

describe("a leitura da conversa por protocolo tenta de novo e não fica carregando para sempre", () => {
  it("uma falha seguida de leitura certa deixa a conversa carregada, sem erro", async () => {
    db.items.mockRejectedValueOnce(new Error("banco ocupado")).mockResolvedValue([]);
    hydrateThread("t1");
    await vi.runAllTimersAsync();
    expect(db.items).toHaveBeenCalledTimes(2);
    expect(useStructured.getState().hydrated.t1).toBe(true);
    expect(useStructured.getState().hydrateErrors.t1).toBeUndefined();
  });

  it("se todas as tentativas falham, o erro fica em hydrateErrors e a conversa não é marcada como lida", async () => {
    db.items.mockRejectedValue(new Error("sem banco"));
    hydrateThread("t1");
    await vi.runAllTimersAsync();
    expect(db.items).toHaveBeenCalledTimes(3);
    expect(useStructured.getState().hydrated.t1).toBe(false);
    expect(useStructured.getState().hydrateErrors.t1).toContain("sem banco");
  });

  it("tentar de novo limpa o erro e lê a conversa outra vez", async () => {
    db.items.mockRejectedValue(new Error("sem banco"));
    hydrateThread("t1");
    await vi.runAllTimersAsync();
    db.items.mockReset().mockResolvedValue([]);
    retryThreadHydration("t1");
    await vi.runAllTimersAsync();
    expect(useStructured.getState().hydrated.t1).toBe(true);
    expect(useStructured.getState().hydrateErrors.t1).toBeUndefined();
  });
});
