import { describe, expect, it } from "vitest";

import { canvasKeyFor } from "../shellModeModel";

const keyOf = (cwd: string) => `main|${cwd}`;

describe("a chave do canvas no seletor de modo", () => {
  it("a aba ativa manda quando não há conversa por protocolo na tela", () => {
    expect(canvasKeyFor("main|/a", null, keyOf)).toBe("main|/a");
  });
  it("a conversa por protocolo preserva a chave ativa dela", () => {
    expect(canvasKeyFor("main|/b#s:thread:b", "/b", keyOf, "thread:b")).toBe("main|/b#s:thread:b");
  });
  it("a conversa por protocolo preserva um canvas especial", () => {
    expect(canvasKeyFor("main|/repo#m:m1", "/repo", keyOf, "thread:a")).toBe("main|/repo#m:m1");
  });
  it("sem chave pronta, a conversa por protocolo usa a própria sessão", () => {
    expect(canvasKeyFor(null, "/repo", keyOf, "thread:a")).toBe("main|/repo#s:thread:a");
  });
  it("sem aba nem conversa não há canvas", () => {
    expect(canvasKeyFor(null, null, keyOf)).toBeNull();
  });
});
