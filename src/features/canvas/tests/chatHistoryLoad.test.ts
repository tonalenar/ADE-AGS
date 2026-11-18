import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { loadChatHistory, resetChatHistoryInflightForTests } from "../chatHistory";

describe("leitura do histórico do chat do canvas", () => {
  beforeEach(() => {
    invoke.mockReset();
    resetChatHistoryInflightForTests();
  });

  it("duas leituras da mesma aba ao mesmo tempo viram um IPC", async () => {
    let resolve!: (v: { messages: [] }) => void;
    invoke.mockReturnValue(new Promise((r) => { resolve = r as (v: { messages: [] }) => void; }));
    const a = loadChatHistory("tab-1");
    const b = loadChatHistory("tab-1");
    expect(invoke).toHaveBeenCalledTimes(1);
    resolve({ messages: [] });
    await Promise.all([a, b]);
    expect(invoke).toHaveBeenCalledWith("chat_history", { tabId: "tab-1" });
  });
});
