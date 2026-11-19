import { describe, expect, it } from "vitest";

import { formatMemory } from "../memory";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
// O Intl põe espaço fino ou sem quebra entre o número e a unidade, conforme o idioma.
const plain = (s: string) => s.replace(/\s/g, " ");

describe("formatMemory", () => {
  it("mostra a partir de 1 GB com uma casa decimal, no separador do idioma", () => {
    expect(plain(formatMemory(2.6 * GIB, "pt-BR"))).toBe("2,6 GB");
    expect(plain(formatMemory(2.6 * GIB, "en"))).toBe("2.6 GB");
    expect(plain(formatMemory(2.6 * GIB, "es"))).toBe("2,6 GB");
  });

  it("abaixo de 1 GB mostra em MB, sem casas decimais", () => {
    expect(plain(formatMemory(512.4 * MIB, "pt-BR"))).toBe("512 MB");
    expect(plain(formatMemory(0, "en"))).toBe("0 MB");
  });
});
