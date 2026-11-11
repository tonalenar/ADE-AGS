import { describe, expect, it } from "vitest";
import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";

import { diffConfigFor, ignoreWhitespaceDiff, MAX_DISTINCT_LINES } from "@/features/editor/ignoreWhitespace";

/** Os trechos que o CodeMirror mostra para dois textos, com a mesma configuração que a aba de diff usa. */
function chunksOf(a: string, b: string, ignoreWhitespace: boolean) {
  return Chunk.build(Text.of(a.split("\n")), Text.of(b.split("\n")), diffConfigFor(ignoreWhitespace));
}

describe("ignorar espaços em branco no diff", () => {
  it("troca de indentação não aparece como mudança; sem a opção, aparece (controle)", () => {
    const before = "function f() {\n  return 1;\n}\n";
    const after = "function f() {\n\treturn 1;\n}\n";
    expect(chunksOf(before, after, true)).toEqual([]);
    expect(chunksOf(before, after, false)).toHaveLength(1);
  });

  it("fim de linha CRLF contra LF não é mudança", () => {
    expect(chunksOf("a\nb\nc\n", "a\r\nb\r\nc\r\n", true)).toEqual([]);
    expect(chunksOf("a\nb\nc\n", "a\r\nb\r\nc\r\n", false)).not.toEqual([]);
  });

  it("uma mudança real ao lado de uma de espaço: só a real aparece", () => {
    const chunks = chunksOf("  a\nb\nc\n", "a\nB\nc\n", true);
    expect(chunks).toHaveLength(1);
    // O trecho cai na segunda linha (o `b` virou `B`), não na primeira, que só mudou de indentação.
    expect(chunks[0].fromA).toBe("  a\n".length);
  });

  it("dentro de uma linha que mudou de verdade, o destaque fino continua no trecho trocado", () => {
    const chunks = chunksOf("x = a + b\n", "x = a - b\n", true);
    expect(chunks).toHaveLength(1);
    // O `+` virou `-`: a mudança fina aponta para ele (offset 6), e não para a linha inteira.
    expect(chunks[0].changes[0].fromA).toBe("x = a ".length);
    expect(chunks[0].changes[0].toA).toBe("x = a +".length);
  });

  it("uma linha em branco que some continua sendo mudança: é linha, não espaço", () => {
    expect(chunksOf("a\n\nb\n", "a\nb\n", true)).toHaveLength(1);
  });

  it("as mudanças do algoritmo caem dentro dos dois textos, nos offsets originais", () => {
    const a = "x = 1\n  y  = 2\nz\n";
    const b = "x=1\ny = 3\nw\nz\n";
    const changes = ignoreWhitespaceDiff(a, b);
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      expect(change.fromA).toBeGreaterThanOrEqual(0);
      expect(change.toA).toBeLessThanOrEqual(a.length);
      expect(change.fromB).toBeGreaterThanOrEqual(0);
      expect(change.toB).toBeLessThanOrEqual(b.length);
    }
  });

  it("acima do limite de linhas distintas, o diff compara o texto inteiro e o espaço aparece", () => {
    const lines = Array.from({ length: MAX_DISTINCT_LINES + 2 }, (_, i) => `linha ${i}`);
    const a = lines.join("\n");
    const b = lines.map((line) => `${line} `).join("\n");
    expect(ignoreWhitespaceDiff(a, b).length).toBeGreaterThan(0);
  });
});

describe("configuração de diff da aba", () => {
  it("ligada, traz o algoritmo que ignora espaços; desligada, é a varredura padrão do merge", () => {
    expect(diffConfigFor(true)).toMatchObject({ scanLimit: 500 });
    expect(diffConfigFor(true).override).toBe(ignoreWhitespaceDiff);
    expect(diffConfigFor(false)).toEqual({ scanLimit: 500 });
  });
});
