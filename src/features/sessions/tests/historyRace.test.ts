import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  listHistory: vi.fn(),
  deleteHistoryEntry: vi.fn(),
  checkSessionSkills: vi.fn(),
  restoreSessionSkills: vi.fn(),
  sessionMarkdown: vi.fn(),
  exportSessionMarkdown: vi.fn(),
}));

vi.mock("../ipc", () => ipc);

import { useSessionsStore } from "../store";
import type { SessionHistoryEntry } from "../types";

const entry = (id: string, workspaceId: string): SessionHistoryEntry => ({
  id,
  workspaceId,
  agentId: "claude-code",
  agentLabel: "Claude",
  command: "claude",
  cwd: "/p",
  title: id,
  sessionId: null,
  skills: [],
  siblingTabs: [],
  accountId: null,
  prelaunch: [],
  openedAt: 1,
  closedAt: 2,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => { resolve = ok; });
  return { promise, resolve };
}

describe("loadHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionsStore.setState({ history: [], loading: false, error: null });
  });

  it("descarta a resposta do workspace antigo", async () => {
    const first = deferred<SessionHistoryEntry[]>();
    const second = deferred<SessionHistoryEntry[]>();
    ipc.listHistory
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const a = useSessionsStore.getState().loadHistory("ws-a");
    const b = useSessionsStore.getState().loadHistory("ws-b");

    first.resolve([entry("old", "ws-a")]);
    await a;
    expect(useSessionsStore.getState().history.map((row) => row.id)).toEqual([]);

    second.resolve([entry("new", "ws-b")]);
    await b;
    expect(useSessionsStore.getState().history.map((row) => row.id)).toEqual(["new"]);
    expect(useSessionsStore.getState().loading).toBe(false);
  });
});
