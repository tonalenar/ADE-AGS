import { describe, expect, it, vi } from "vitest";

// A foto do backend chega depois de um evento mais novo da mesma aba: o teste controla a ordem.
const wire = vi.hoisted(() => ({ handlers: {} as Record<string, (e: { payload: unknown }) => void>, snapshot: null as null | ((v: unknown[]) => void) }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: () => new Promise((resolve) => { wire.snapshot = resolve; }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => { wire.handlers[name] = cb; return Promise.resolve(() => undefined); },
}));

import { startChatLive, useChatLive } from "../liveStore";

describe("a foto do estado ao vivo não sobrescreve um evento mais novo", () => {
  it("um evento que chega antes da foto fica; a foto só preenche as abas que não tiveram evento", async () => {
    startChatLive();
    await Promise.resolve();
    wire.handlers["cc-structured-state"]!({ payload: { tabId: "t1", phase: "working", question: null, turnStartedAt: 5, turnEndedAt: null, tools: [] } });
    wire.snapshot!([
      { tabId: "t1", phase: "idle", question: null, turnStartedAt: 1, turnEndedAt: 2, tools: [] },
      { tabId: "t2", phase: "working", question: null, turnStartedAt: 3, turnEndedAt: null, tools: [] },
    ]);
    await Promise.resolve();
    await Promise.resolve();
    expect(useChatLive.getState().phase.t1).toBe("working");
    expect(useChatLive.getState().phase.t2).toBe("working");
  });
});
