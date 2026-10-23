import { describe, expect, it } from "vitest";

import { emptyBoard } from "@/features/canvas/board";
import { CMP_GAP, CMP_NODE, CMP_TITLE_H, buildComparisonBoard, comparisonColumns, comparisonLayout, comparisonOrigin, comparisonViewport } from "../layout";

const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("layout da comparação", () => {
  it("até 3 numa linha, depois duas linhas", () => {
    expect([1, 2, 3, 4, 5, 6].map(comparisonColumns)).toEqual([1, 2, 3, 2, 3, 3]);
  });

  it("os terminais ficam lado a lado sob o título, sem se sobrepor", () => {
    for (let n = 2; n <= 6; n++) {
      const { title, nodes } = comparisonLayout(n, { x: 100, y: 200 });
      expect(nodes).toHaveLength(n);
      expect(nodes[0]).toEqual({ x: 100, y: 200 + CMP_TITLE_H, ...CMP_NODE });
      expect(title.y).toBe(200);
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) expect(overlap(nodes[i], nodes[j])).toBe(false);
      expect(nodes.every((b) => b.y >= title.y + title.h)).toBe(true);
    }
    const { nodes } = comparisonLayout(3, { x: 0, y: 0 });
    expect(nodes.map((b) => b.y)).toEqual([CMP_TITLE_H, CMP_TITLE_H, CMP_TITLE_H]);
    expect(nodes[1].x).toBe(CMP_NODE.w + CMP_GAP);
  });

  it("um canvas com coisas recebe o grupo embaixo de tudo", () => {
    expect(comparisonOrigin(emptyBoard())).toEqual({ x: 40, y: 40 });
    const board = { ...emptyBoard(), nodes: { old: { x: 10, y: 0, w: 500, h: 300 } } };
    expect(comparisonOrigin(board)).toEqual({ x: 10, y: 300 + CMP_GAP * 2 });
    expect(comparisonOrigin(board, new Set(["old"]))).toEqual({ x: 40, y: 40 });
  });

  it("a vista cabe o grupo e nunca fica abaixo do zoom em que o terminal ainda vive", () => {
    expect(comparisonViewport(2, { x: 40, y: 40 }).zoom).toBe(1);
    const six = comparisonViewport(6, { x: 40, y: 40 });
    expect(six.zoom).toBeGreaterThanOrEqual(0.45);
    expect(six.zoom).toBeLessThan(1);
  });

  it("monta nós, rótulos e o título", () => {
    const board = buildComparisonBoard(emptyBoard(), "text-cmp-1", "Comparação: login", [
      { tabId: "t1", label: "Claude Code · opus" },
      { tabId: "t2", label: "Codex · gpt-5.1" },
    ]);
    expect(Object.keys(board.nodes)).toEqual(["t1", "t2"]);
    expect(board.roles).toEqual({ t1: "Claude Code · opus", t2: "Codex · gpt-5.1" });
    expect(board.texts["text-cmp-1"].text).toBe("Comparação: login");
    expect(board.edges).toEqual([]);
    expect(board.orchestrators).toEqual([]);
  });
});
