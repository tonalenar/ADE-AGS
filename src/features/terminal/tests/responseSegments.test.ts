import { describe, expect, it } from "vitest";
import { promptText, segmentResponses } from "../responseSegments";

describe("segmentResponses", () => {
  it("Claude Code: del prompt al siguiente, con herramientas dentro de la misma respuesta", () => {
    const lines = [
      "> arruma o bug",
      "",
      "● Vou olhar o arquivo.",
      "",
      "● Read(src/a.ts)",
      "  ⎿  Read 10 lines",
      "",
      "● Pronto, corrigi.",
      "  Segunda linha",
      "",
      "> e os testes?",
      "",
      "● Passaram.",
      "╭──────────╮",
      "│ >        │",
      "╰──────────╯",
    ];
    const r = segmentResponses(lines);
    expect(r).toHaveLength(2);
    expect(r[0].prompt).toBe("arruma o bug");
    expect(r[0].marker).toBe("●");
    expect(r[0].text.startsWith("Vou olhar o arquivo.")).toBe(true);
    expect(r[0].text).toContain("● Read(src/a.ts)");
    expect(r[0].text).toContain("Segunda linha");
    expect(r[0].startLine).toBe(2);
    expect(r[0].endLine).toBe(9);
    expect(r[1]).toMatchObject({ prompt: "e os testes?", text: "Passaram.", index: 1 });
  });

  it("Codex: prompt › e marcador •", () => {
    const r = segmentResponses(["› oi", "", "• Olá!", "  Como ajudo?", "", "› tchau", "• Até."]);
    expect(r.map((s) => s.text)).toEqual(["Olá!\nComo ajudo?", "Até."]);
    expect(r.map((s) => s.marker)).toEqual(["•", "•"]);
  });

  it("Gemini: marcador ✦ e prompt dentro da caja", () => {
    const r = segmentResponses(["│ > explique", "✦ Claro.", "  Aqui."]);
    expect(r).toHaveLength(1);
    expect(r[0].prompt).toBe("explique");
    expect(r[0].text).toBe("Claro.\nAqui.");
  });

  it("la caja de entrada y sus rayas no son parte de la respuesta", () => {
    const r = segmentResponses(["> a", "● b", "────────────", "> c", "──────"]);
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe("b");
  });

  it("respuesta sin prompt visible (se fue del scrollback) queda con prompt nulo", () => {
    const r = segmentResponses(["● cola de una respuesta", "  sigue"]);
    expect(r).toHaveLength(1);
    expect(r[0].prompt).toBeNull();
  });

  it("buffer vacío o sin respuestas", () => {
    expect(segmentResponses([])).toEqual([]);
    expect(segmentResponses(["> solo prompt", "", "texto suelto"])).toEqual([]);
  });

  it("promptText exige la columna 0: una cita indentada dentro de la respuesta no es prompt", () => {
    expect(promptText("> hola")).toBe("hola");
    expect(promptText("  > cita")).toBeNull();
    expect(promptText(">")).toBeNull();
  });
});
