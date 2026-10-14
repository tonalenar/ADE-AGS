import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import type { ConversationRow } from "../conversationModel";
import { activeConversationFor, cwdBelongsTo } from "../conversationsStore";

const row = (id: string, cwd: string, state: "active" | "saved" = "active"): ConversationRow => ({
  id, workspaceId: "w", projectKey: cwd, cwd, title: null, customTitle: null, pinned: false, hidden: false, state,
  terminals: [], createdAt: 1, lastActiveAt: 1,
});

describe("a que conversa pertence o que se abre numa pasta", () => {
  it("a pasta é a da conversa ou está dentro dela, sem confundir prefixos parecidos nem maiúsculas do Windows", () => {
    expect(cwdBelongsTo("C:\\Users\\a\\proj", "C:/Users/a/proj")).toBe(true);
    expect(cwdBelongsTo("C:/Users/a/proj/sub", "c:/users/a/proj")).toBe(true);
    expect(cwdBelongsTo("C:/Users/a/proj2", "C:/Users/a/proj")).toBe(false);
  });

  it("só uma conversa ATIVA recebe, e a mais específica vence", () => {
    const rows = [row("a", "C:/p", "saved"), row("b", "C:/p"), row("c", "C:/p/app"), row("d", "C:/outro")];
    expect(activeConversationFor(rows, "C:/p/app/src")?.id).toBe("c");
    expect(activeConversationFor(rows, "C:/p")?.id).toBe("b");
    expect(activeConversationFor(rows, "C:/nada")).toBeNull();
    expect(activeConversationFor([row("a", "C:/p", "saved")], "C:/p")).toBeNull();
  });
});
