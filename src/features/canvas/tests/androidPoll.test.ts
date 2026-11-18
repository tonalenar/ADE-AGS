import { describe, expect, it } from "vitest";

import { androidFrameShouldPoll } from "../androidPoll";

describe("quadro Android", () => {
  it("não pede PNG com a janela oculta, o chat por cima ou o nó fora da tela", () => {
    expect(androidFrameShouldPoll({ hidden: true, surfaceOpen: true, onScreen: true })).toBe(false);
    expect(androidFrameShouldPoll({ hidden: false, surfaceOpen: false, onScreen: true })).toBe(false);
    expect(androidFrameShouldPoll({ hidden: false, surfaceOpen: true, onScreen: false })).toBe(false);
    expect(androidFrameShouldPoll({ hidden: false, surfaceOpen: true, onScreen: true })).toBe(true);
  });
});
