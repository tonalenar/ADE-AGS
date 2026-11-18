import { describe, expect, it } from "vitest";

import { diffLines } from "../model";

describe("A570 diffLines", () => {
  it("linha de conteúdo que começa com +++ não é cabeçalho se não for o prefixo de arquivo", () => {
    const lines = diffLines("+++ /dev/null\n+hello\n+++nota do usuário");
    expect(lines[0]?.kind).toBe("meta");
    expect(lines[1]?.kind).toBe("add");
    expect(lines[2]?.kind).toBe("add");
  });
});
