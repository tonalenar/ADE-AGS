import { describe, expect, it } from "vitest";

import { asciiTag } from "../ipc";

describe("rótulo da foto no cabeçalho", () => {
  it("só ASCII: um título com travessão ou reticências derrubava a foto", () => {
    expect(asciiTag("Amazon.com.br — fone…")).toBe("Amazon.com.br  fone");
    expect(asciiTag("Pré-visualização")).toBe("Pre-visualizacao");
  });

  it("sem nada aproveitável, um nome fixo", () => {
    expect(asciiTag("—…")).toBe("captura");
  });
});
