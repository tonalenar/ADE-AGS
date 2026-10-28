import { describe, expect, it } from "vitest";
import { virtualKeyCode } from "../page/keys";

describe("Chrome real: código de tecla virtual", () => {
  it("letras e dígitos pelo próprio caractere", () => {
    expect(virtualKeyCode("a")).toBe(65);
    expect(virtualKeyCode("Z")).toBe(90);
    expect(virtualKeyCode("7")).toBe(55);
  });

  it("teclas com nome", () => {
    expect(virtualKeyCode("Enter")).toBe(13);
    expect(virtualKeyCode("Tab")).toBe(9);
    expect(virtualKeyCode("ArrowDown")).toBe(40);
    expect(virtualKeyCode(" ")).toBe(32);
  });

  it("o resto fica sem código (o CDP usa o key/text)", () => {
    expect(virtualKeyCode("ç")).toBe(0);
  });
});
