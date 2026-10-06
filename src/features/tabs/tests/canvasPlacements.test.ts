import { describe, expect, it } from "vitest";
import { CANVAS_GROUP, canvasPlacements } from "@/features/tabs/layout/layoutStore";
import { agentKey, viewKey } from "@/features/tabs/layout/layoutTree";

const rect = { left: 10, top: 20, width: 300, height: 200 };

describe("canvasPlacements (modo Canvas + navegador/archivo en otra aba)", () => {
  it("sin vista activa, cada terminal viva va sobre su nodo y el teclado al agente activo", () => {
    const p = canvasPlacements({ a: rect, b: rect }, "a", null);
    expect([...p.visible.keys()].sort()).toEqual([agentKey("a"), agentKey("b")]);
    expect(p.visible.get(agentKey("a"))).toEqual({ groupId: CANVAS_GROUP, rect });
    expect(p.focusedItem).toBe(agentKey("a"));
  });

  it("el agente activo sin nodo vivo no recibe el foco", () => {
    expect(canvasPlacements({ a: rect }, "z", null).focusedItem).toBeNull();
  });

  it("con un navegador activo, este ocupa toda el area y las terminales se esconden", () => {
    const p = canvasPlacements({ a: rect }, "a", "br1");
    expect([...p.visible.keys()]).toEqual([viewKey("br1")]);
    expect(p.visible.get(viewKey("br1"))?.rect).toBeNull();
    expect(p.focusedItem).toBe(viewKey("br1"));
  });

  it("volver al canvas (sin vista activa) restaura las terminales sin tocar los rects", () => {
    const rects = { a: rect };
    const withView = canvasPlacements(rects, "a", "br1");
    const back = canvasPlacements(rects, "a", null);
    expect(withView.visible.has(agentKey("a"))).toBe(false);
    expect(back.visible.get(agentKey("a"))?.rect).toBe(rect);
  });
});
