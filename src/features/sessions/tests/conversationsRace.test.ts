import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  listConversations: vi.fn(),
}));

vi.mock("../ipc.projectConversations", () => ipc);

import { useConversationsStore } from "../conversationsStore";
import type { ConversationRow } from "../conversationModel";

const row = (id: string, workspaceId: string): ConversationRow => ({
  id,
  workspaceId,
  projectKey: "/p",
  cwd: "/p",
  title: null,
  customTitle: null,
  pinned: false,
  hidden: false,
  state: "active",
  terminals: [],
  createdAt: 1,
  lastActiveAt: 1,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => { resolve = ok; });
  return { promise, resolve };
}

describe("conversationsStore.load", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConversationsStore.setState({ rows: [], loading: false, error: null });
  });

  it("descarta a lista do workspace antigo", async () => {
    const first = deferred<ConversationRow[]>();
    const second = deferred<ConversationRow[]>();
    ipc.listConversations
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const a = useConversationsStore.getState().load("ws-a");
    const b = useConversationsStore.getState().load("ws-b");
    first.resolve([row("old", "ws-a")]);
    await a;
    expect(useConversationsStore.getState().rows.map((item) => item.id)).toEqual([]);
    second.resolve([row("new", "ws-b")]);
    await b;
    expect(useConversationsStore.getState().rows.map((item) => item.id)).toEqual(["new"]);
  });
});
