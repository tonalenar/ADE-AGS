import { describe, expect, it } from "vitest";

import { CHAT_GROUP, chatPlacements, placementsFrom } from "@/features/tabs/layout/layoutStore";
import { agentKey } from "@/features/tabs/layout/layoutTree";

const slot = { left: 280, top: 60, width: 900, height: 600 };

describe("chatPlacements (casca do modo chat)", () => {
  it("só o terminal da conversa aberta, no espaço reservado, com o teclado", () => {
    const p = chatPlacements(slot, "a");
    expect([...p.visible.entries()]).toEqual([[agentKey("a"), { groupId: CHAT_GROUP, rect: slot }]]);
    expect(p.focusedItem).toBe(agentKey("a"));
  });

  it("sem espaço (a tela de conversa nova) nenhum terminal aparece", () => {
    const p = chatPlacements(null, "a");
    expect(p.visible.size).toBe(0);
    expect(p.focusedItem).toBeNull();
  });

  it("passa na frente do canvas e das vistas: o resto fica montado e escondido", () => {
    const p = placementsFrom({
      layout: null, slots: {}, activeTabId: "a", activeViewId: "browser-1", mode: "canvas",
      liveRects: { a: slot, b: slot }, grid: ["a", "b"], chat: { slot },
    });
    expect([...p.visible.keys()]).toEqual([agentKey("a")]);
  });

  it("sem a casca do chat nada muda", () => {
    const p = placementsFrom({
      layout: null, slots: {}, activeTabId: "a", activeViewId: null, mode: "canvas",
      liveRects: { a: slot, b: slot }, grid: null, chat: null,
    });
    expect([...p.visible.keys()].sort()).toEqual([agentKey("a"), agentKey("b")]);
  });
});

describe("navegador do painel direito no chat", () => {
  const rect = { left: 900, top: 52, width: 540, height: 800 };
  it("aparece no seu espaço; o teclado fica com o terminal se a gaveta está aberta", async () => {
    const { viewKey } = await import("@/features/tabs/layout/layoutTree");
    const both = chatPlacements(slot, "a", { viewId: "b1", rect });
    expect(both.visible.get(viewKey("b1"))).toEqual({ groupId: CHAT_GROUP, rect });
    expect(both.focusedItem).toBe(agentKey("a"));
    const onlyBrowser = chatPlacements(null, "a", { viewId: "b1", rect });
    expect([...onlyBrowser.visible.keys()]).toEqual([viewKey("b1")]);
    expect(onlyBrowser.focusedItem).toBe(viewKey("b1"));
  });
});
