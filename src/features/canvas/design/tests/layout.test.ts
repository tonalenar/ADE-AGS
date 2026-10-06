import { describe, expect, it } from "vitest";

import { BOARD_GAP, spreadOverlapping } from "../layout";

const board = (id: string, x: number, y: number, width = 400, height = 300) => ({ id, x, y, width, height });

describe("spreadOverlapping", () => {
  it("separa pranchetas empilhadas em (0, 0), lado a lado e na ordem", () => {
    const out = spreadOverlapping([board("a", 0, 0), board("b", 0, 0, 200), board("c", 0, 0)]);
    expect(out.map((b) => [b.id, b.x, b.y])).toEqual([["a", 0, 0], ["b", 400 + BOARD_GAP, 0], ["c", 400 + BOARD_GAP + 200 + BOARD_GAP, 0]]);
  });

  it("mantém posições que não se sobrepõem (o usuário pode ter arrumado à mão)", () => {
    const boards = [board("a", 0, 0), board("b", 500, 0), board("c", 0, 400)];
    expect(spreadOverlapping(boards)).toBe(boards);
  });

  it("não altera as originais e aceita lista vazia ou uma só", () => {
    const stacked = [board("a", 0, 0), board("b", 10, 10)];
    spreadOverlapping(stacked);
    expect(stacked[1].x).toBe(10);
    expect(spreadOverlapping([])).toEqual([]);
    const one = [board("a", 0, 0)];
    expect(spreadOverlapping(one)).toBe(one);
  });
});

import { CHOOSER_SCRIPT, PICKER_SCRIPT, PICK_MESSAGE, buildSrcdoc, parsePick } from "../srcdoc";

describe("modo ESCOLHER (proposta dentro de uma prancheta)", () => {
  it("só injeta o script de escolha quando pedido, e nunca junto do seletor do EDIT", () => {
    expect(buildSrcdoc("<p>x</p>")).not.toContain(CHOOSER_SCRIPT);
    const chooser = buildSrcdoc("<p>x</p>", { chooser: true });
    expect(chooser).toContain(CHOOSER_SCRIPT);
    expect(chooser).not.toContain(PICKER_SCRIPT);
    expect(buildSrcdoc("<p>x</p>", { picker: true })).not.toContain(CHOOSER_SCRIPT);
  });

  it("a CSP continua cortando a rede no modo escolher", () => {
    expect(buildSrcdoc("<p>x</p>", { chooser: true })).toContain("default-src 'none'");
  });

  it("o script manda a escolha pela mesma mensagem validada pelo app", () => {
    expect(CHOOSER_SCRIPT).toContain(PICK_MESSAGE);
    expect(parsePick({ type: PICK_MESSAGE, selector: "body > div:nth-of-type(1)", text: "C · Arcade" })).toEqual({ selector: "body > div:nth-of-type(1)", text: "C · Arcade" });
    expect(parsePick({ type: "outra", selector: "x" })).toBeNull();
  });
});
