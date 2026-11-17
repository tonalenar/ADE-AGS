import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";

import { COMPACTION_TTL_MS } from "../autocompact/model";
import { startQueueRunner } from "../queueRunner";
import { enqueueMessage, useChatStore } from "../store";

const structured = vi.hoisted(() => ({ sendToThread: vi.fn(), interruptThread: vi.fn() }));
vi.mock("../structured/store", () => {
  const useStructured = create<{ live: Record<string, unknown>; threads: unknown[] }>(() => ({ live: {}, threads: [] }));
  return { useStructured, sendToThread: structured.sendToThread, interruptThread: structured.interruptThread };
});
vi.mock("../chatActions", () => ({ sendToConversation: vi.fn() }));
vi.mock("../liveStore", () => ({ useChatLive: create(() => ({ phase: {}, question: {}, awaiting: {}, turn: {} })) }));
vi.mock("../permissions/permissionsStore", () => ({ usePermissions: create(() => ({ tui: [] })) }));
// A procura de compactação é espiada: o custo por pedaço é o que o teste mede.
vi.mock("../autocompact/model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../autocompact/model")>();
  return { ...actual, isCompacting: vi.fn(actual.isCompacting) };
});

import { useStructured } from "../structured/store";
import { isCompacting as isCompactingSpy } from "../autocompact/model";

const KEY = "thread:t1";
const compacting = (at: number) => ({ kind: "notice", id: "c1", label: "compaction", status: "running", at, text: "auto" });
const live = (items: unknown[], phase: "idle" | "working" = "idle") => ({ t1: { items, requests: [], phase, drafts: [], error: null } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_000_000));
  useChatStore.setState({ queues: {} });
  structured.sendToThread.mockReset();
  vi.mocked(isCompactingSpy).mockClear();
  useStructured.setState({ live: {}, threads: [] });
});
afterEach(() => { vi.useRealTimers(); });

describe("a fila do composer solta a mensagem quando a compactação passa do prazo", () => {
  it("fila_solta_pelo_ttl: sem nenhuma outra mudança, a mensagem sai quando o aviso de compactação expira", () => {
    startQueueRunner();
    const at = Date.now();
    useStructured.setState({ live: live([compacting(at)]) as never });
    enqueueMessage(KEY, "depois");
    // Uma avaliação com a compactação em andamento: a fila segura a mensagem.
    useStructured.setState({ live: live([compacting(at)]) as never });
    expect(structured.sendToThread).not.toHaveBeenCalled();
    // Nada muda na conversa: só o tempo passa além do prazo.
    vi.advanceTimersByTime(COMPACTION_TTL_MS + 1000);
    expect(structured.sendToThread).toHaveBeenCalledWith("t1", "depois");
  });

  it("nao_procura_compactacao_a_cada_pedaco: com o agente trabalhando, cada pedaço não varre os itens", () => {
    startQueueRunner();
    useStructured.setState({ live: live([{ kind: "user", id: "u", text: "faça" }], "working") as never });
    enqueueMessage(KEY, "depois");
    vi.mocked(isCompactingSpy).mockClear();
    for (let i = 0; i < 20; i++) {
      useStructured.setState({ live: live([{ kind: "user", id: "u", text: "faça" }, { kind: "assistant", id: "a", text: "x".repeat(i + 1) }], "working") as never });
    }
    expect(isCompactingSpy).not.toHaveBeenCalled();
    expect(structured.sendToThread).not.toHaveBeenCalled();
  });
});
