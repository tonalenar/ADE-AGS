import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import { GRID_SLOT, gridPlacements, usableSlot } from "@/features/canvas/gridMode";
import { CANVAS_GROUP, useLayoutStore, type Placement, type Rect } from "@/features/tabs/layout/layoutStore";
import { agentKey } from "@/features/tabs/layout/layoutTree";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const editorAreaFile = path.resolve(__dirname, "../EditorArea.tsx");
const terminalPanelFile = path.resolve(__dirname, "../../terminal/TerminalPanel.tsx");
const layoutStoreFile = path.resolve(__dirname, "../layout/layoutStore.ts");

describe("gridPlacements integration & regressão de quadro vazio", () => {
  beforeEach(() => {
    useLayoutStore.setState({ slots: {}, layouts: {}, drag: null });
  });

  describe("Contrato estático de fonte: EditorArea & MissionGrid", () => {
    it("MissionGrid não possui classes bg-* no contêiner raiz (evita overlay opaco sobre os terminais)", () => {
      const code = fs.readFileSync(editorAreaFile, "utf-8");
      // Extrai o bloco de retorno de MissionGrid
      const match = code.match(/function MissionGrid\([^)]*\)\s*\{[\s\S]*?return\s*\(\s*<div\s+([^>]+)>/);
      expect(match).not.toBeNull();
      const containerProps = match![1];

      // Garante que o contêiner raiz do grid tem classe 'absolute inset-0 pointer-events-none grid'
      expect(containerProps).toContain("absolute inset-0 pointer-events-none grid");
      // Regressão crítica: não pode ter classe bg-gray-200 ou qualquer bg-* que crie película opaca
      expect(containerProps).not.toMatch(/className="[^"]*\bbg-[^"]*"/);
    });

    it("ResizeObserver em EditorArea observa slots da grade dependendo de gridIds", () => {
      const code = fs.readFileSync(editorAreaFile, "utf-8");
      // Garante que gridIds é derivado de grid e incluído no array de dependências do useEffect do ResizeObserver
      expect(code).toMatch(/const\s+gridIds\s*=\s*grid\s*\?\s*grid\.join\("\|"\)\s*:\s*""/);
      expect(code).toMatch(/\[groupIds,\s*gridIds,\s*measure\]/);
    });
  });

  describe("Contrato estático de fonte: TerminalPanel & Terminal", () => {
    it("TerminalPanel condiciona isVisible e montagem ativa ao placement medido", () => {
      const code = fs.readFileSync(terminalPanelFile, "utf-8");
      // Garante que shown é verdadeiro apenas se houver placement
      expect(code).toContain("const shown = placement !== undefined;");
      // Garante que Terminal recebe isVisible={shown}
      expect(code).toMatch(/<Terminal[\s\S]*?isVisible=\{shown\}/);
    });

    it("layoutStore.usePlacements utiliza gridPlacements para mapear terminais visíveis no grid", () => {
      const code = fs.readFileSync(layoutStoreFile, "utf-8");
      expect(code).toContain("import { gridPlacements, useMissionGrid } from \"@/features/canvas/gridMode\";");
      expect(code).toMatch(/for\s*\(\s*const\s*\[id,\s*rect\]\s*of\s*gridPlacements\(grid,\s*slots\)\s*\)/);
    });
  });

  describe("Lógica de visibilidade e posicionamento com grade ativa", () => {
    const r = (left: number, top: number, width = 400, height = 300): Rect => ({ left, top, width, height });

    it("aba da grade NÃO recebe placement (nem isVisible) quando slot ainda não foi medido", () => {
      const gridIds = ["tab-1", "tab-2"];
      const slots: Record<string, Rect> = {}; // nada medido ainda

      const activePlacements = gridPlacements(gridIds, slots);
      expect(activePlacements.size).toBe(0);

      const visible = new Map<string, Placement>();
      for (const [id, rect] of activePlacements) {
        visible.set(agentKey(id), { groupId: CANVAS_GROUP, rect });
      }

      // Nenhum terminal fica com shown = true nem ocupa inset: 0 indevidamente
      expect(visible.has(agentKey("tab-1"))).toBe(false);
      expect(visible.has(agentKey("tab-2"))).toBe(false);
    });

    it("aba da grade NÃO recebe placement quando o slot é medido como 0x0", () => {
      const gridIds = ["tab-1", "tab-2"];
      const slots: Record<string, Rect> = {
        [GRID_SLOT + "tab-1"]: r(0, 0, 0, 0),
        [GRID_SLOT + "tab-2"]: r(0, 0, 0, 0),
      };

      const activePlacements = gridPlacements(gridIds, slots);
      expect(activePlacements.size).toBe(0);

      const visible = new Map<string, Placement>();
      for (const [id, rect] of activePlacements) {
        visible.set(agentKey(id), { groupId: CANVAS_GROUP, rect });
      }

      expect(visible.size).toBe(0);
      expect(visible.get(agentKey("tab-1"))).toBeUndefined();
    });

    it("aba da grade recebe placement válido apenas quando o slot possui dimensões reais", () => {
      const gridIds = ["tab-1", "tab-2"];
      const slots: Record<string, Rect> = {
        [GRID_SLOT + "tab-1"]: r(0, 24, 400, 300),
        [GRID_SLOT + "tab-2"]: r(401, 24, 400, 300),
      };

      const activePlacements = gridPlacements(gridIds, slots);
      expect(activePlacements.size).toBe(2);

      const visible = new Map<string, Placement>();
      for (const [id, rect] of activePlacements) {
        visible.set(agentKey(id), { groupId: CANVAS_GROUP, rect });
      }

      const p1 = visible.get(agentKey("tab-1"));
      const p2 = visible.get(agentKey("tab-2"));

      expect(p1).toBeDefined();
      expect(p1?.groupId).toBe(CANVAS_GROUP);
      expect(p1?.rect).toEqual(r(0, 24, 400, 300));

      expect(p2).toBeDefined();
      expect(p2?.groupId).toBe(CANVAS_GROUP);
      expect(p2?.rect).toEqual(r(401, 24, 400, 300));
    });

    it("renderização parcial: apenas aba com slot medido e dimensional torna-se visível", () => {
      const gridIds = ["tab-pronta", "tab-pendente"];
      const slots: Record<string, Rect> = {
        [GRID_SLOT + "tab-pronta"]: r(0, 24, 400, 300),
        [GRID_SLOT + "tab-pendente"]: r(401, 24, 0, 300), // largura zero (pendente)
      };

      const activePlacements = gridPlacements(gridIds, slots);
      expect(activePlacements.size).toBe(1);
      expect(activePlacements.has("tab-pronta")).toBe(true);
      expect(activePlacements.has("tab-pendente")).toBe(false);

      const visible = new Map<string, Placement>();
      for (const [id, rect] of activePlacements) {
        visible.set(agentKey(id), { groupId: CANVAS_GROUP, rect });
      }

      // 'tab-pronta' fica visível com placement real
      expect(visible.has(agentKey("tab-pronta"))).toBe(true);
      // 'tab-pendente' fica invisível até que o slot adquira largura > 0
      expect(visible.has(agentKey("tab-pendente"))).toBe(false);
    });

    it("usableSlot rejeita null, undefined, largura <= 0 ou altura <= 0", () => {
      expect(usableSlot(null)).toBe(false);
      expect(usableSlot(undefined)).toBe(false);
      expect(usableSlot(r(0, 0, 0, 100))).toBe(false);
      expect(usableSlot(r(0, 0, 100, 0))).toBe(false);
      expect(usableSlot(r(0, 0, -1, 100))).toBe(false);
      expect(usableSlot(r(0, 0, 100, 100))).toBe(true);
    });
  });
});
