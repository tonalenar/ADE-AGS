import { describe, expect, it } from "vitest";

import { canvasKeyFor } from "../shellModeModel";

const keyOf = (cwd: string) => `main|${cwd}`;

describe("a chave do canvas no seletor de modo", () => {
  it("a aba ativa manda quando não há conversa por protocolo na tela", () => {
    expect(canvasKeyFor("main|/a", null, keyOf)).toBe("main|/a");
  });
  it("com uma conversa por protocolo na tela, vale a pasta dela", () => {
    expect(canvasKeyFor("main|/a", "/b", keyOf)).toBe("main|/b");
  });
  it("sem aba (conversa por protocolo), vale a pasta da conversa: o Canvas não some do seletor", () => {
    expect(canvasKeyFor(null, "/repo", keyOf)).toBe("main|/repo");
  });
  it("sem aba nem conversa não há canvas", () => {
    expect(canvasKeyFor(null, null, keyOf)).toBeNull();
  });
});
