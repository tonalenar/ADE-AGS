import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useCanvasStore } from "@/features/canvas/store";
import { useTabsStore } from "@/features/tabs/store";

import { useChatStore } from "../../store";
import { useStructured } from "../../structured/store";
import { selectConversation, startSelectionSync } from "../selectionActions";

let stop = () => undefined as void;

beforeEach(() => {
  useChatStore.setState({ thread: null });
  useCanvasStore.setState({ boards: {}, activeThread: null, focus: null });
  useStructured.setState({
    threads: [{ id: "a", agentId: "codex", cwd: "/p", title: "A", model: null, effort: null, access: "ask", accountId: null, state: "active", createdAt: 1, updatedAt: 1 }],
  });
  stop = startSelectionSync();
});
afterEach(() => stop());

describe("seleção única de conversa", () => {
  it("escolher uma conversa por protocolo a abre, fixa o canvas da pasta e pede o foco", () => {
    selectConversation("thread:a");
    expect(useChatStore.getState().thread).toBe("a");
    expect(useCanvasStore.getState().activeThread?.ref).toBe("thread:a");
    expect(useCanvasStore.getState().activeThread?.key).toMatch(/\|\/p$/);
    expect(useCanvasStore.getState().focus).toMatchObject({ ref: "thread:a" });
  });

  it("o canvas que já tem o cartão dela é o canvas dela", () => {
    useCanvasStore.setState({ boards: { "main|/outra#c:1": { threads: { "thread:a": { x: 0, y: 0, w: 1, h: 1 } }, nodes: {} } as never } });
    selectConversation("thread:a");
    expect(useCanvasStore.getState().activeThread?.key).toBe("main|/outra#c:1");
  });

  it("ativar uma aba, mesmo a que já está ativa, tira a conversa por protocolo da frente", () => {
    useTabsStore.setState({ activeTabId: "t1" });
    selectConversation("thread:a");
    useTabsStore.getState().activateTab("t1");
    expect(useChatStore.getState().thread).toBeNull();
    expect(useCanvasStore.getState().activeThread).toBeNull();
  });
});
