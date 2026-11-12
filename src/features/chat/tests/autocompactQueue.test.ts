import { beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";

// A conversa por protocolo, sem backend: o estado ao vivo, o que o despachante manda e interrompe.
const structured = vi.hoisted(() => ({ sendToThread: vi.fn(), interruptThread: vi.fn() }));
vi.mock("../structured/store", () => {
  const useStructured = create<{ live: Record<string, { phase: string; requests: unknown[]; items?: unknown[] }> }>(() => ({ live: {} }));
  return { useStructured, sendToThread: structured.sendToThread, interruptThread: structured.interruptThread };
});
vi.mock("../chatActions", () => ({ sendToConversation: vi.fn() }));
vi.mock("../liveStore", () => ({ useChatLive: create(() => ({ phase: {}, question: {}, awaiting: {} })) }));
vi.mock("../permissions/permissionsStore", () => ({ usePermissions: create(() => ({ tui: [] })) }));

import { sendNow, startQueueRunner } from "../queueRunner";
import { useChatStore } from "../store";
import { useStructured } from "../structured/store";

const KEY = "thread:t1";
const compacting = (status: "running" | "done") => [{ kind: "notice", id: "n:compaction:1", label: "compaction", status, text: "ade", at: Date.now() }];
const setLive = (phase: "working" | "idle", items: unknown[] = []) => useStructured.setState({ live: { t1: { phase, requests: [], items } } } as never);

beforeEach(() => {
  useChatStore.setState({ queues: {} });
  useStructured.setState({ live: {} });
  structured.sendToThread.mockReset();
  structured.interruptThread.mockReset();
});

describe("mensagens durante a compactação de contexto", () => {
  it("vão para a fila, mesmo que o motor aceitasse entrar no turno, e não interrompem a compactação", () => {
    setLive("idle", compacting("running"));
    const deliver = vi.fn();
    expect(sendNow(KEY, "continua", "steer", deliver)).toBe("queued");
    expect(deliver).not.toHaveBeenCalled();
    expect(structured.interruptThread).not.toHaveBeenCalled();
    expect(useChatStore.getState().queues[KEY]?.map((m) => m.text)).toEqual(["continua"]);
  });

  it("saem quando o aviso «Contexto compactado» fecha, uma por vez", () => {
    startQueueRunner();
    // O despachante vê a conversa ocupada (compactando) antes de a pessoa mandar.
    setLive("idle", compacting("running"));
    sendNow(KEY, "primeira", "steer", vi.fn());
    sendNow(KEY, "segunda", "steer", vi.fn());
    expect(structured.sendToThread).not.toHaveBeenCalled();
    setLive("idle", compacting("done"));
    expect(structured.sendToThread).toHaveBeenCalledTimes(1);
    expect(structured.sendToThread.mock.calls[0][1]).toBe("primeira");
    expect(useChatStore.getState().queues[KEY]?.map((m) => m.text)).toEqual(["segunda"]);
  });

  it("sem compactação, o envio segue como sempre", () => {
    setLive("idle");
    const deliver = vi.fn();
    expect(sendNow(KEY, "oi", "steer", deliver)).toBe("sent");
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
