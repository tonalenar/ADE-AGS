import { afterEach, describe, expect, it, vi } from "vitest";

import { bumpedBoards, buildViewState, createDebouncer, fitViewState, sameViewState, versionsOf } from "../viewState";

const boards = Array.from({ length: 25 }, (_, i) => ({ id: `b${i}`, title: `Tela ${i}`, x: i * 10, y: 0, w: 5, h: 5 }));
const base = {
  mode: "canvas" as const, page: { id: "p1", name: "Home" }, boards, camera: { x: 0, y: 0, scale: 1 },
  viewport: { width: 1000, height: 600, top: 0 }, focusedId: null, selectedIds: ["b1"], now: 123,
  picked: Array.from({ length: 7 }, (_, i) => ({ artboardId: "b1", selector: `p:nth-of-type(${i})`, kind: "text" as const, label: "x".repeat(80) })),
};

describe("view state", () => {
  afterEach(() => vi.useRealTimers());

  it("segue o contrato e os limites (20 visíveis, 20 selecionados, 5 na seleção, rótulo ≤60)", () => {
    const s = buildViewState(base);
    expect(s.visibleArtboards).toHaveLength(20);
    expect(s.selectedArtboards).toEqual([{ id: "b1", title: "Tela 1" }]);
    expect(s.selected[0]).toBe("b1#p:nth-of-type(0)");
    expect(s.selection).toHaveLength(5);
    expect(s.selection[0].label).toHaveLength(60);
    expect(s).toMatchObject({ mode: "canvas", pageId: "p1", pageName: "Home", zoom: 1, updatedAt: 123 });
  });

  it("no modo focado só a prancheta aberta é visível", () => {
    const s = buildViewState({ ...base, mode: "focused", focusedId: "b7" });
    expect(s.visibleArtboards).toEqual([{ id: "b7", title: "Tela 7" }]);
  });

  it("cabe em 3072 bytes e ignora o relógio na comparação", () => {
    const big = buildViewState({ ...base, boards: boards.map((b) => ({ ...b, title: "t".repeat(200) })) });
    expect(new TextEncoder().encode(JSON.stringify(fitViewState(big))).length).toBeLessThanOrEqual(3072);
    const s = buildViewState(base);
    expect(sameViewState(s, { ...s, updatedAt: 999 })).toBe(true);
    expect(sameViewState(null, s)).toBe(false);
  });

  it("debounce de 400 ms publica só o último", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = createDebouncer<number>(400, fn);
    d.push(1);
    vi.advanceTimersByTime(300);
    d.push(2);
    vi.advanceTimersByTime(399);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledWith(2);
    d.push(3);
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("acende a prancheta cuja versão subiu (e as novas), nunca na primeira leitura", () => {
    const v1 = [{ id: "a", version: 1 }, { id: "b", version: 2 }];
    expect(bumpedBoards(null, v1)).toEqual([]);
    expect(bumpedBoards(versionsOf(v1), [{ id: "a", version: 2 }, { id: "b", version: 2 }, { id: "c", version: 1 }])).toEqual(["a", "c"]);
  });
});
