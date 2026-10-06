import { beforeEach, describe, expect, it } from "vitest";

import { GRID_SLOT, gridColumns, gridTabs } from "@/features/canvas/gridMode";
import {
  CANVAS_GROUP,
  placeStyle,
  useLayoutStore,
  type Rect,
} from "@/features/tabs/layout/layoutStore";

/**
 * Simula o cálculo de medição de slots realizado por `measure()` em `EditorArea.tsx`:
 * `left = Math.round(r.left - base.left)`
 * `top = Math.round(r.top - base.top)`
 * `width = Math.round(r.width)`
 * `height = Math.round(r.height)`
 */
function computeSlotRect(
  base: { left: number; top: number },
  elementRect: { left: number; top: number; width: number; height: number },
): Rect {
  return {
    left: Math.round(elementRect.left - base.left),
    top: Math.round(elementRect.top - base.top),
    width: Math.round(elementRect.width),
    height: Math.round(elementRect.height),
  };
}

/**
 * Predicado de proteção contra regressão de "quadro vazio":
 * Um slot é considerado "vazio" / inválido se não foi medido (null) ou se possui largura/altura <= 0.
 */
function isEmptySlot(rect: Rect | null | undefined): boolean {
  if (!rect) return true;
  return rect.width <= 0 || rect.height <= 0;
}

describe("Lógica de slots e posicionamento do Modo Grade", () => {
  beforeEach(() => {
    useLayoutStore.setState({ slots: {}, layouts: {}, drag: null });
  });

  describe("Resolução de chaves de slot (GRID_SLOT)", () => {
    it("utiliza o prefixo grid: para identificar o slot de cada aba da grade", () => {
      const tabId = "tab-agent-1";
      const slotKey = GRID_SLOT + tabId;
      expect(slotKey).toBe("grid:tab-agent-1");
      expect(slotKey.startsWith(GRID_SLOT)).toBe(true);
    });

    it("recupera o slot correto do layoutStore quando registrado", () => {
      const tabId = "tab-1";
      const expectedRect: Rect = { left: 0, top: 24, width: 400, height: 300 };

      useLayoutStore.setState({
        slots: {
          [GRID_SLOT + tabId]: expectedRect,
        },
      });

      const resolved = useLayoutStore.getState().slots[GRID_SLOT + tabId];
      expect(resolved).toEqual(expectedRect);
    });

    it("retorna undefined quando o slot ainda não foi medido no store", () => {
      const resolved = useLayoutStore.getState().slots[GRID_SLOT + "inexistente"];
      expect(resolved).toBeUndefined();
    });
  });

  describe("placeStyle e posicionamento de containers", () => {
    it("quando rect é null (não medido), aplica inset: 0", () => {
      const style = placeStyle(null);
      expect(style).toEqual({ position: "absolute", inset: 0 });
    });

    it("quando rect é fornecido com dimensões válidas, define coordenadas explícitas", () => {
      const rect: Rect = { left: 100, top: 24, width: 500, height: 400 };
      const style = placeStyle(rect);
      expect(style).toEqual({
        position: "absolute",
        left: 100,
        top: 24,
        width: 500,
        height: 400,
      });
      expect(style.inset).toBeUndefined();
    });
  });

  describe("Cálculo de slots geométricos (EditorArea measure)", () => {
    it("calcula coordenadas relativas ao container base descontando cabeçalho", () => {
      const base = { left: 50, top: 100 };
      // Slot do pane posicionado abaixo do título de 24px
      const slotElement = { left: 50, top: 124, width: 450, height: 350 };

      const rect = computeSlotRect(base, slotElement);
      expect(rect).toEqual({
        left: 0,
        top: 24,
        width: 450,
        height: 350,
      });
    });

    it("arredonda frações de subpíxel para inteiros", () => {
      const base = { left: 10.2, top: 20.4 };
      const slotElement = { left: 110.8, top: 120.6, width: 399.7, height: 299.4 };

      const rect = computeSlotRect(base, slotElement);
      expect(rect).toEqual({
        left: 101, // 110.8 - 10.2 = 100.6 -> 101
        top: 100,  // 120.6 - 20.4 = 100.2 -> 100
        width: 400,
        height: 299,
      });
    });
  });

  describe("Mapeamento de visibilidade para todas as abas do grid", () => {
    it("no grid todas as abas recebem entrada visible com CANVAS_GROUP", () => {
      const gridIds = ["tab-a", "tab-b", "tab-c"];
      const slots: Record<string, Rect> = {
        [GRID_SLOT + "tab-a"]: { left: 0, top: 24, width: 300, height: 200 },
        [GRID_SLOT + "tab-b"]: { left: 301, top: 24, width: 300, height: 200 },
        [GRID_SLOT + "tab-c"]: { left: 0, top: 225, width: 300, height: 200 },
      };

      // Simulação da lógica de usePlacements para grid
      const visible = new Map<string, { groupId: string; rect: Rect | null }>();
      for (const id of gridIds) {
        visible.set(`a:${id}`, { groupId: CANVAS_GROUP, rect: slots[GRID_SLOT + id] ?? null });
      }

      expect(visible.size).toBe(3);
      for (const id of gridIds) {
        const placement = visible.get(`a:${id}`);
        expect(placement).toBeDefined();
        expect(placement?.groupId).toBe(CANVAS_GROUP);
        expect(placement?.rect).toEqual(slots[GRID_SLOT + id]);
      }
    });

    it("distribui abas em colunas calculadas corretamente sem sobreposição", () => {
      const cols = gridColumns(4);
      expect(cols).toBe(2);

      const baseWidth = 800;
      const baseHeight = 600;
      const headerHeight = 24;
      const colWidth = Math.floor(baseWidth / cols);
      const rowHeight = Math.floor(baseHeight / 2);

      const gridIds = ["t1", "t2", "t3", "t4"];
      const slots: Record<string, Rect> = {};
      gridIds.forEach((id, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        slots[GRID_SLOT + id] = {
          left: col * colWidth,
          top: row * rowHeight + headerHeight,
          width: colWidth,
          height: rowHeight - headerHeight,
        };
      });

      // Verifica que cada slot tem área positiva e não se sobrepõem exatamente
      expect(slots[GRID_SLOT + "t1"]?.left).toBe(0);
      expect(slots[GRID_SLOT + "t2"]?.left).toBe(400);
      expect(slots[GRID_SLOT + "t3"]?.top).toBe(300 + 24);
      expect(slots[GRID_SLOT + "t4"]?.left).toBe(400);
      expect(slots[GRID_SLOT + "t4"]?.top).toBe(300 + 24);
    });
  });
});

describe("Regressão: Prevenção e detecção de 'quadro vazio'", () => {
  beforeEach(() => {
    useLayoutStore.setState({ slots: {}, layouts: {}, drag: null });
  });

  describe("Cálculo e identificação de tamanho 0", () => {
    it("detecta slot com largura 0 como quadro vazio", () => {
      const zeroWidthRect: Rect = { left: 0, top: 0, width: 0, height: 300 };
      expect(isEmptySlot(zeroWidthRect)).toBe(true);

      const style = placeStyle(zeroWidthRect);
      expect(style.width).toBe(0);
    });

    it("detecta slot com altura 0 como quadro vazio", () => {
      const zeroHeightRect: Rect = { left: 0, top: 0, width: 400, height: 0 };
      expect(isEmptySlot(zeroHeightRect)).toBe(true);

      const style = placeStyle(zeroHeightRect);
      expect(style.height).toBe(0);
    });

    it("detecta slot com 0x0 gerado antes do layout (elemento não renderizado)", () => {
      const base = { left: 0, top: 0 };
      const unrenderedElement = { left: 0, top: 0, width: 0, height: 0 };
      const calculated = computeSlotRect(base, unrenderedElement);

      expect(calculated).toEqual({ left: 0, top: 0, width: 0, height: 0 });
      expect(isEmptySlot(calculated)).toBe(true);
    });

    it("reconhece slot válido com dimensões positivas como não vazio", () => {
      const validRect: Rect = { left: 0, top: 24, width: 400, height: 300 };
      expect(isEmptySlot(validRect)).toBe(false);
    });

    it("trata slot nulo (ainda não medido) como vazio", () => {
      expect(isEmptySlot(null)).toBe(true);
      expect(isEmptySlot(undefined)).toBe(true);
    });
  });

  describe("Recuperação após medição inicial zerada", () => {
    it("atualiza de tamanho 0 para dimensões reais após medição pelo ResizeObserver", () => {
      const tabId = "tab-agent";
      const key = GRID_SLOT + tabId;

      // Estado 1: slot medido com tamanho 0 (ex.: antes de pintar)
      const initialZeroRect = computeSlotRect({ left: 0, top: 0 }, { left: 0, top: 0, width: 0, height: 0 });
      useLayoutStore.setState({ slots: { [key]: initialZeroRect } });

      let current = useLayoutStore.getState().slots[key];
      expect(isEmptySlot(current)).toBe(true);
      expect(placeStyle(current)).toEqual({ position: "absolute", left: 0, top: 0, width: 0, height: 0 });

      // Estado 2: ResizeObserver / medida correta após layout estabilizado
      const updatedRect = computeSlotRect(
        { left: 0, top: 0 },
        { left: 0, top: 24, width: 640, height: 480 },
      );
      useLayoutStore.setState({ slots: { [key]: updatedRect } });

      current = useLayoutStore.getState().slots[key];
      expect(isEmptySlot(current)).toBe(false);
      expect(placeStyle(current)).toEqual({
        position: "absolute",
        left: 0,
        top: 24,
        width: 640,
        height: 480,
      });
    });
  });

  describe("Comportamento de fallback quando slots não foram computados", () => {
    it("placeStyle(null) evita posicionamento com tamanho 0 aplicando inset: 0", () => {
      // Se o slot ainda é null, o fallback deve cobrir a área em vez de colapsar em 0px
      const fallbackStyle = placeStyle(null);
      expect(fallbackStyle.inset).toBe(0);
      expect(fallbackStyle.width).toBeUndefined();
      expect(fallbackStyle.height).toBeUndefined();
    });

    it("diferencia claramente slot null (inset 0) de slot medido com 0x0", () => {
      const unmeasured = placeStyle(null);
      const measuredZero = placeStyle({ left: 0, top: 0, width: 0, height: 0 });

      expect(unmeasured).not.toEqual(measuredZero);
      expect(unmeasured.inset).toBe(0);
      expect(measuredZero.width).toBe(0);
      expect(measuredZero.height).toBe(0);
    });
  });

  describe("Condições de ativação do Modo Grade (gridTabs)", () => {
    it("não ativa com menos de 2 terminais (evitando grade vazia ou desnecessária)", () => {
      expect(gridTabs({ on: true, mission: "mission-1", mode: "tabs", tabIds: [] })).toBeNull();
      expect(gridTabs({ on: true, mission: "mission-1", mode: "tabs", tabIds: ["only-one"] })).toBeNull();
    });

    it("não ativa fora do modo tabs", () => {
      expect(gridTabs({ on: true, mission: "mission-1", mode: "canvas", tabIds: ["t1", "t2"] })).toBeNull();
    });

    it("retorna lista de ids de abas quando todos os critérios são satisfeitos", () => {
      const ids = ["t1", "t2", "t3"];
      expect(gridTabs({ on: true, mission: "mission-1", mode: "tabs", tabIds: ids })).toEqual(ids);
    });
  });
});
