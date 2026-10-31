import { describe, expect, it } from "vitest";

import { groupTweaks, readTweaks, writeTweaks } from "../tweaks";

const html = `<x-dc><script type="text/x-dc" data-dc-script data-props='{"title":{"editor":"text","default":"Olá","section":"Texto"},"count":3,"dark":false,"accent":"#ff0000","size":{"editor":"enum","options":["s","m"],"default":"m"},"$preview":{"width":300},"raw":null}'>class C{}</script></x-dc>`;

describe("tweaks (data-props)", () => {
  it("lê as props com editor e infere as primitivas", () => {
    const t = readTweaks(html);
    expect(t.map((x) => [x.name, x.editor, x.value])).toEqual([
      ["title", "text", "Olá"], ["count", "int", 3], ["dark", "boolean", false], ["accent", "color", "#ff0000"], ["size", "enum", "m"],
    ]);
    expect(t.find((x) => x.name === "size")?.options).toEqual(["s", "m"]);
    expect(groupTweaks(t).map((g) => g.section)).toEqual(["Texto", null]);
  });

  it("sem data-props ou com JSON quebrado não há tweaks", () => {
    expect(readTweaks("<p>oi</p>")).toEqual([]);
    expect(readTweaks(`<div data-props='{quebrado'></div>`)).toEqual([]);
  });

  it("salva como padrão no atributo, com aspas simples escapadas", () => {
    const out = writeTweaks(html, { title: "D'água", count: 5, nada: 1 });
    const t = readTweaks(out);
    expect(t.find((x) => x.name === "title")?.value).toBe("D'água");
    expect(t.find((x) => x.name === "count")?.value).toBe(5);
    expect(out).toContain("class C{}");
    expect(out).not.toContain('"nada"');
    expect(writeTweaks("<p/>", { a: 1 })).toBe("<p/>");
  });
});
