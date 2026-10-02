import { describe, expect, it } from "vitest";

import { normalize, rank, score } from "../match";

describe("normalize", () => {
  it("tira acento e maiúscula", () => {
    expect(normalize("  Sessões ")).toBe("sessoes");
  });
});

describe("score", () => {
  it("busca vazia mostra tudo", () => {
    expect(score({ title: "Frota" }, "")).toBeGreaterThan(0);
  });

  it("prefixo do título vale mais que palavra do meio", () => {
    expect(score({ title: "Sessões" }, "ses")).toBeGreaterThan(score({ title: "Abrir sessões" }, "ses"));
  });

  it("acha pelas palavras-chave", () => {
    expect(score({ title: "Frota", keywords: ["fleet"] }, "fleet")).toBeGreaterThan(0);
  });

  it("acha letras em ordem", () => {
    expect(score({ title: "Marketplace" }, "mkt")).toBeGreaterThan(0);
  });

  it("não acha o que não está", () => {
    expect(score({ title: "Marketplace" }, "zzz")).toBe(0);
  });
});

describe("rank", () => {
  const items = [
    { title: "Abrir sessões" },
    { title: "Squads" },
    { title: "Sessões" },
  ];

  it("ordena pela relevância", () => {
    expect(rank(items, "ses").map((i) => i.title)).toEqual(["Sessões", "Abrir sessões"]);
  });

  it("sem busca mantém a ordem original", () => {
    expect(rank(items, "").map((i) => i.title)).toEqual(["Abrir sessões", "Squads", "Sessões"]);
  });
});
