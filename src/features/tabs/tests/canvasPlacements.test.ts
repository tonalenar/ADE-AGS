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

  it("alterna entre múltiples vistas (navegador, archivo, diff) ocultando terminales y actualizando el foco", () => {
    const rects = { a: rect, b: { left: 400, top: 20, width: 300, height: 200 } };
    
    // 1. Abre navegador
    const pBrowser = canvasPlacements(rects, "a", "browser-1");
    expect([...pBrowser.visible.keys()]).toEqual([viewKey("browser-1")]);
    expect(pBrowser.visible.get(viewKey("browser-1"))?.rect).toBeNull();
    expect(pBrowser.focusedItem).toBe(viewKey("browser-1"));

    // 2. Cambia a pestaña de archivo
    const pFile = canvasPlacements(rects, "a", "file-app-ts");
    expect([...pFile.visible.keys()]).toEqual([viewKey("file-app-ts")]);
    expect(pFile.visible.get(viewKey("file-app-ts"))?.rect).toBeNull();
    expect(pFile.focusedItem).toBe(viewKey("file-app-ts"));

    // 3. Cambia a pestaña de diff
    const pDiff = canvasPlacements(rects, "a", "diff-review");
    expect([...pDiff.visible.keys()]).toEqual([viewKey("diff-review")]);
    expect(pDiff.visible.get(viewKey("diff-review"))?.rect).toBeNull();
    expect(pDiff.focusedItem).toBe(viewKey("diff-review"));

    // 4. Vuelve al Canvas (activeViewId nulo): restaura todos los nodos con sus coordenadas intactas
    const pCanvas = canvasPlacements(rects, "b", null);
    expect([...pCanvas.visible.keys()].sort()).toEqual([agentKey("a"), agentKey("b")]);
    expect(pCanvas.visible.get(agentKey("a"))?.rect).toEqual(rect);
    expect(pCanvas.visible.get(agentKey("b"))?.rect).toEqual(rects.b);
    expect(pCanvas.focusedItem).toBe(agentKey("b"));
  });

  it("regresión bug ponto 3: sin soporte para activeViewId en modo canvas, la vista no aparecía", () => {
    // Reproducción de la lógica defectuosa anterior (origin/master):
    const buggyPlacements = (liveRects: Record<string, typeof rect>) => {
      const visible = new Map();
      for (const [tabId, r] of Object.entries(liveRects)) visible.set(agentKey(tabId), { groupId: CANVAS_GROUP, rect: r });
      return visible;
    };
    const buggy = buggyPlacements({ a: rect });
    // En la versión con bug, la vista nunca existía en visible
    expect(buggy.has(viewKey("br1"))).toBe(false);
    expect(buggy.has(agentKey("a"))).toBe(true);

    // Con el fix, canvasPlacements sí posiciona la vista y oculta la terminal
    const fixed = canvasPlacements({ a: rect }, "a", "br1");
    expect(fixed.visible.has(viewKey("br1"))).toBe(true);
    expect(fixed.visible.has(agentKey("a"))).toBe(false);
  });

  it("sin agente activo o sin rects vivas, foco se resuelve limpiamente a null", () => {
    expect(canvasPlacements({}, null, null)).toEqual({
      visible: new Map(),
      focusedItem: null,
    });
    expect(canvasPlacements({ a: rect }, null, null).focusedItem).toBeNull();
  });
});

