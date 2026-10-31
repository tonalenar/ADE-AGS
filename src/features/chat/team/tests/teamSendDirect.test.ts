// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

/** O backend, em memória: cada `chat_thread_send` fica pendente até o teste resolver ou recusar. */
const backend = vi.hoisted(() => ({
  sends: [] as { args: Record<string, unknown>; resolve: () => void; reject: (e: string) => void }[],
  calls: [] as [string, Record<string, unknown>][],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown> = {}) => {
    backend.calls.push([cmd, args]);
    if (cmd === "chat_thread_send") return new Promise<void>((resolve, reject) => backend.sends.push({ args, resolve, reject }));
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => undefined) }));

import { usePendingSends } from "../../timeline/pending";
import { sendToThread } from "../../structured/store";
import { sendDirect, setAllowTools, setAutoDecide, setSendError, useTeamStore } from "../teamStore";

const flush = () => new Promise((r) => setTimeout(r, 0));
const pendingOf = (key: string) => (usePendingSends.getState().byKey[key] ?? []).map((p) => p.text);

beforeEach(() => {
  backend.sends.length = 0;
  backend.calls.length = 0;
  usePendingSends.setState({ byKey: {} });
  useTeamStore.setState({ sendErrors: {} });
});

describe("sendToThread: onSent e onError", () => {
  it("onSent só depois de o backend aceitar; onError (com a mensagem) só se ele recusar", async () => {
    const sent = vi.fn();
    const failed = vi.fn();
    sendToThread("t1", "oi", failed, sent);
    await flush();
    expect(sent).not.toHaveBeenCalled();
    backend.sends[0]!.resolve();
    await flush();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();

    sendToThread("t2", "oi", failed, sent);
    backend.sends[1]!.reject("A conversa fechou");
    await flush();
    expect(failed).toHaveBeenCalledWith(expect.stringContaining("A conversa fechou"));
    expect(sent).toHaveBeenCalledTimes(1);
  });
});

describe("sendDirect (@menção do orquestrador)", () => {
  it("mostra a bolha pendente na conversa que a pessoa olha e a tira quando o backend aceita", async () => {
    sendDirect("tab-lead", "thread:m1", "rode os testes", { key: "thread:lead", items: [] });
    expect(pendingOf("thread:lead")).toEqual(["rode os testes"]);
    expect(backend.sends[0]!.args).toMatchObject({ threadId: "m1", text: "rode os testes" });
    backend.sends[0]!.resolve();
    await flush();
    expect(pendingOf("thread:lead")).toEqual([]);
    expect(useTeamStore.getState().sendErrors["tab-lead"]).toBeUndefined();
  });

  it("o erro aparece na conversa do orquestrador e a bolha sai; o próximo envio limpa o erro", async () => {
    sendDirect("tab-lead", "thread:m1", "oi", { key: "thread:lead", items: [] });
    backend.sends[0]!.reject("O agente desta conversa já fechou");
    await flush();
    expect(pendingOf("thread:lead")).toEqual([]);
    expect(useTeamStore.getState().sendErrors["tab-lead"]).toContain("já fechou");
    sendDirect("tab-lead", "thread:m1", "de novo", { key: "thread:lead", items: [] });
    expect(useTeamStore.getState().sendErrors["tab-lead"]).toBeUndefined();
  });

  it("setSendError(null) limpa", () => {
    setSendError("o", "x");
    expect(useTeamStore.getState().sendErrors.o).toBe("x");
    setSendError("o", null);
    expect(useTeamStore.getState().sendErrors.o).toBeUndefined();
  });
});

describe("setAutoDecide (o interruptor «não decidir sozinho»)", () => {
  it("mostra já e pede ao backend; só a tela chama isto", () => {
    useTeamStore.setState({ teams: [{ id: "t1", orchestrator: "tab", agentId: "claude-code", label: "L", cwd: "/", title: "", createdAt: 1, updatedAt: 1, headcount: 1, members: [] }] });
    setAutoDecide("t1", false);
    expect(useTeamStore.getState().teams[0]!.autoDecide).toBe(false);
    expect(backend.calls[backend.calls.length - 1]).toEqual(["chat_team_auto_decide", { teamId: "t1", enabled: false }]);
    setAutoDecide("t1", true);
    expect(useTeamStore.getState().teams[0]!.autoDecide).toBe(true);
  });
});

describe("setAllowTools (ferramentas de fora do shell)", () => {
  it("nasce desligado, mostra já e pede ao backend", () => {
    useTeamStore.setState({ teams: [{ id: "t1", orchestrator: "tab", agentId: "claude-code", label: "L", cwd: "/", title: "", createdAt: 1, updatedAt: 1, headcount: 1, members: [] }] });
    expect(useTeamStore.getState().teams[0]!.allowTools).toBeUndefined();
    setAllowTools("t1", true);
    expect(useTeamStore.getState().teams[0]!.allowTools).toBe(true);
    expect(backend.calls[backend.calls.length - 1]).toEqual(["chat_team_allow_tools", { teamId: "t1", enabled: true }]);
  });
});
