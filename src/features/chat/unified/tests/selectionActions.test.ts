import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useCanvasStore } from "@/features/canvas/store";
import { useTabsStore } from "@/features/tabs/store";
import { useTeamIndex } from "@/features/chat/team/teamIndex";

import { useChatStore } from "../../store";
import { useStructured } from "../../structured/store";
import { selectConversation, startSelectionSync } from "../selectionActions";

let stop = () => undefined as void;

beforeEach(() => {
  useChatStore.setState({ thread: null });
  useCanvasStore.setState({ boards: {}, activeThread: null, focus: null });
  useTeamIndex.setState({ teams: [] });
  useStructured.setState({
    threads: [{ id: "a", agentId: "codex", cwd: "/p", title: "A", model: null, effort: null, access: "ask", accountId: null, state: "active", createdAt: 1, updatedAt: 1 }],
  });
  stop = startSelectionSync();
});
afterEach(() => stop());

describe("seleção única de conversa", () => {
  it("escolher uma conversa por protocolo a abre, fixa o canvas próprio e pede o foco", () => {
    selectConversation("thread:a");
    expect(useChatStore.getState().thread).toBe("a");
    expect(useCanvasStore.getState().activeThread?.ref).toBe("thread:a");
    expect(useCanvasStore.getState().activeThread?.key).toBe("main|/p#s:thread:a");
    expect(useCanvasStore.getState().focus).toMatchObject({ ref: "thread:a" });
  });

  it("o canvas que já tem o cartão dela é o canvas dela", () => {
    useCanvasStore.setState({ boards: { "main|/outra#c:1": { threads: { "thread:a": { x: 0, y: 0, w: 1, h: 1 } }, nodes: {} } as never } });
    selectConversation("thread:a");
    expect(useCanvasStore.getState().activeThread?.key).toBe("main|/outra#c:1");
  });

  it("integrante por protocolo abre no canvas do orquestrador por protocolo", () => {
    useStructured.setState({ threads: [
      { id: "a", agentId: "codex", cwd: "/p", title: "A", model: null, effort: null, access: "ask", accountId: null, state: "active", createdAt: 1, updatedAt: 1 },
      { id: "lead", agentId: "codex", cwd: "/lead", title: "Lead", model: null, effort: null, access: "ask", accountId: null, state: "active", createdAt: 1, updatedAt: 1 },
    ] });
    useTeamIndex.setState({ teams: [{ id: "team", orchestrator: "thread:lead", cwd: "/lead", members: [{ teamId: "team", member: "thread:a" }] } as never] });
    selectConversation("thread:a");
    expect(useCanvasStore.getState().activeThread?.key).toBe("main|/lead#s:thread:lead");
  });

  it("time promovido da pasta mantém a conversa por protocolo no canvas legado", () => {
    const key = "main|/lead";
    useStructured.setState({ threads: [
      { id: "member", agentId: "codex", cwd: "/lead", title: "Member", model: null, effort: null, access: "ask", accountId: null, state: "active", createdAt: 1, updatedAt: 1 },
      { id: "lead", agentId: "codex", cwd: "/lead", title: "Lead", model: null, effort: null, access: "ask", accountId: null, state: "active", createdAt: 1, updatedAt: 1 },
    ] });
    useTeamIndex.setState({ teams: [{ id: "team", orchestrator: "thread:lead", cwd: "/lead", origin: "canvas", boardKey: key, members: [{ teamId: "team", member: "thread:member" }] } as never] });
    useCanvasStore.setState({ boards: { [key]: { nodes: {}, threads: {
      "thread:lead": { x: 0, y: 0, w: 100, h: 100 }, "thread:member": { x: 120, y: 0, w: 100, h: 100 },
    }, edges: [{ id: "e1", a: "thread:lead", b: "thread:member" }], orchestrators: ["thread:lead"] } as never } });
    selectConversation("thread:member");
    expect(useCanvasStore.getState().activeThread?.key).toBe(key);
  });

  it("ativar uma aba, mesmo a que já está ativa, tira a conversa por protocolo da frente", () => {
    useTabsStore.setState({ activeTabId: "t1" });
    selectConversation("thread:a");
    useTabsStore.getState().activateTab("t1");
    expect(useChatStore.getState().thread).toBeNull();
    expect(useCanvasStore.getState().activeThread).toBeNull();
  });
});
