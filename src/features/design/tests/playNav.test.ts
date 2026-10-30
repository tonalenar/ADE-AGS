import { describe, expect, it } from "vitest";

import { parentSelector } from "../anchor";
import { chromeInsets } from "../chromeInsets";
import { htmlTitle, nameTokens, resolveNavTarget, stripOrdinal } from "../frameBridge";

const boards = [
  { id: "b1", title: "1 · Nova conversa", html: "<!doctype html><html><head><title>Main</title></head><body></body></html>" },
  { id: "b2", title: "2 · Conversa em andamento + diff", html: "<title>Thread</title><p>x</p>" },
  { id: "b3", title: "3 · Configurações", html: "<p>sem título</p>" },
  { id: "b4", title: "Painel de Design", html: "" },
];

describe("links do Play entre pranchetas", () => {
  it("o <title> do HTML resolve nomes de arquivo como Main.dc.html e Thread.dc.html", () => {
    expect(resolveNavTarget("Main.dc.html", boards)).toBe("b1");
    expect(resolveNavTarget("./Thread.dc.html?x=1#topo", boards)).toBe("b2");
  });

  it("título com ou sem numeração, sem acento e sem caixa", () => {
    expect(resolveNavTarget("nova-conversa.html", boards)).toBe("b1");
    expect(resolveNavTarget("configuracoes.dc.html", boards)).toBe("b3");
    expect(resolveNavTarget("1%20%C2%B7%20Nova%20conversa.dc.html", boards)).toBe("b1");
  });

  it("número da frente e id", () => {
    expect(resolveNavTarget("2.dc.html", boards)).toBe("b2");
    expect(resolveNavTarget("tela-03.html", boards)).toBe("b3");
    expect(resolveNavTarget("b4", boards)).toBe("b4");
  });

  it("palavras do nome (camelCase) contidas no título, e o título que contém o nome", () => {
    expect(resolveNavTarget("ConversaDiff.dc.html", boards)).toBe("b2");
    expect(resolveNavTarget("PainelDesign.dc.html", boards)).toBe("b4");
    expect(resolveNavTarget("andamento.dc.html", boards)).toBe("b2");
  });

  it("sem destino devolve null (o app avisa) e nomes curtos não casam por pedaço", () => {
    expect(resolveNavTarget("Inexistente.dc.html", boards)).toBeNull();
    expect(resolveNavTarget("di.html", boards)).toBeNull();
    expect(resolveNavTarget("", boards)).toBeNull();
  });

  it("auxiliares", () => {
    expect(stripOrdinal("12 - Tela")).toBe("Tela");
    expect(nameTokens("ThreadDiff_2")).toEqual(["thread", "diff", "2"]);
    expect(htmlTitle("<title> A  b </title>")).toBe("A b");
    expect(htmlTitle("<p/>")).toBeNull();
  });
});

describe("Esc sobe para o pai", () => {
  it("tira o último segmento e para no topo", () => {
    expect(parentSelector("div:nth-of-type(1) > header:nth-of-type(1) > p:nth-of-type(2)")).toBe("div:nth-of-type(1) > header:nth-of-type(1)");
    expect(parentSelector("div:nth-of-type(1)")).toBeNull();
  });
});

describe("folga para os controles da janela", () => {
  it("macOS: semáforos à esquerda quando a barra encosta no topo e no canto", () => {
    expect(chromeInsets({ left: 0, top: 0, right: 1200 }, 1200, "macos")).toEqual({ left: 84, right: 0 });
    expect(chromeInsets({ left: 300, top: 0, right: 1200 }, 1200, "macos")).toEqual({ left: 0, right: 0 });
    // No painel do chat a barra fica abaixo do cabeçalho do painel: nada a reservar.
    expect(chromeInsets({ left: 0, top: 52, right: 1200 }, 1200, "macos")).toEqual({ left: 0, right: 0 });
  });

  it("Windows e Linux: botões à direita", () => {
    expect(chromeInsets({ left: 60, top: 0, right: 1200 }, 1200, "windows")).toEqual({ left: 0, right: 140 });
    expect(chromeInsets({ left: 60, top: 0, right: 1000 }, 1200, "windows")).toEqual({ left: 0, right: 0 });
    expect(chromeInsets({ left: 60, top: 0, right: 1200 }, 1200, "linux")).toEqual({ left: 0, right: 108 });
  });
});
