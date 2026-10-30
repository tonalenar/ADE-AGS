import { describe, expect, it } from "vitest";
import { parseSnippet } from "../aiMemory";

describe("parseSnippet (snippet do ai-memory search --json)", () => {
  it("destaca o <mark> do fixture real e mantém o resto como texto", () => {
    // Fixture real: search-populated.stdout do adendo (ai-memory 3.3.0).
    const segs = parseSnippet("A <mark>fixtureunique</mark> local test page.");
    expect(segs).toEqual([
      { text: "A ", highlight: false },
      { text: "fixtureunique", highlight: true },
      { text: " local test page.", highlight: false },
    ]);
  });

  it("snippet sem <mark> vira um único segmento sem destaque", () => {
    expect(parseSnippet("A fixtureunique local test page.")).toEqual([
      { text: "A fixtureunique local test page.", highlight: false },
    ]);
  });

  it("descarta outras tags e mantém o texto de dentro", () => {
    const segs = parseSnippet("<b>negrito</b> e <script>x()</script>");
    expect(segs).toEqual([{ text: "negrito e x()", highlight: false }]);
    expect(JSON.stringify(segs)).not.toContain("<");
  });

  it("funde marks vizinhos e aceita mark no início e no fim", () => {
    expect(parseSnippet("<mark>a</mark><mark>b</mark>")).toEqual([{ text: "ab", highlight: true }]);
    expect(parseSnippet("<mark>início</mark> meio <mark>fim</mark>")).toEqual([
      { text: "início", highlight: true },
      { text: " meio ", highlight: false },
      { text: "fim", highlight: true },
    ]);
  });

  it("mark não fechado segue destacado até o fim, sem quebrar", () => {
    expect(parseSnippet("x <mark>y")).toEqual([
      { text: "x ", highlight: false },
      { text: "y", highlight: true },
    ]);
  });

  it("mantém < solto que não é tag", () => {
    expect(parseSnippet("a < b e 2 > 1")).toEqual([{ text: "a < b e 2 > 1", highlight: false }]);
  });

  it("snippet vazio não gera segmentos", () => {
    expect(parseSnippet("")).toEqual([]);
  });
});
