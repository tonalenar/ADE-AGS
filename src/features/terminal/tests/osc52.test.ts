import { describe, expect, it } from "vitest";

import { decodeOsc52, OSC52_MAX_BYTES } from "../osc52";

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

describe("OSC 52 (copiar do OpenCode)", () => {
  it("decodifica o texto, com acentos", () => {
    expect(decodeOsc52(`c;${b64("olá, mundo")}`)).toBe("olá, mundo");
    expect(decodeOsc52(`;${b64("sem alvo")}`)).toBe("sem alvo");
  });

  it("a leitura (?) nunca devolve a área de transferência", () => {
    expect(decodeOsc52("c;?")).toBeNull();
  });

  it("vazio, malformado ou grande demais: nada", () => {
    expect(decodeOsc52("c;")).toBeNull();
    expect(decodeOsc52("sem-ponto-e-virgula")).toBeNull();
    expect(decodeOsc52("c;***não é base64***")).toBeNull();
    expect(decodeOsc52(`c;${"A".repeat(OSC52_MAX_BYTES * 2)}`)).toBeNull();
  });
});
