import { describe, expect, it } from "vitest";

import { scrollbackEnd } from "../scrollbackEnd";

describe("scrollbackEnd", () => {
  it("sai da tela alternativa, solta o mouse e deixa a tela livre", () => {
    const end = scrollbackEnd(30);
    expect(end).toContain("\u001b[?1049l");
    expect(end).toContain("\u001b[?1000l");
    expect(end).toContain("\u001b[0m");
    expect(end.split("\r\n").length - 1).toBe(40);
  });

  it("numa terminal alta, empurra tantas linhas quanto ela tem", () => {
    expect(scrollbackEnd(100).split("\r\n").length - 1).toBe(100);
  });
});
