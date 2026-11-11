import { Change, diff, type DiffConfig } from "@codemirror/merge";

/**
 * Ignorar espaços em branco no diff (Configurações → Diffs e o botão da barra), como no T3 Code
 * (`diffIgnoreWhitespace`, que vem ligado por padrão).
 *
 * O `@codemirror/merge` não tem essa opção, mas aceita trocar o algoritmo: `DiffConfig.override` recebe
 * os dois textos inteiros e devolve as mudanças nos offsets deles. Este módulo é esse algoritmo:
 *
 * 1. Cada linha vira a chave dela sem espaço nenhum (espaço, tab, `\r` do CRLF). Duas linhas com a mesma
 *    chave não são mudança, e o diff de linhas do próprio CodeMirror faz o alinhamento.
 * 2. Cada trecho de linhas que realmente mudou é comparado de novo, por caractere, nos offsets originais.
 *    O destaque fino (a palavra trocada) continua igual ao do diff normal.
 *
 * O texto que aparece nos dois lados não muda: só some do diff a mudança que é só de espaço. Limite:
 * acima de `MAX_DISTINCT_LINES` linhas diferentes, o diff volta a comparar o texto inteiro, sem ignorar.
 */

/** Quantas chaves de linha distintas cabem no diff por linha (um caractere cada, fora da faixa de surrogates). */
export const MAX_DISTINCT_LINES = 60_000;

/**
 * O diff de linhas e o de cada trecho são precisos, sem o `scanLimit` do merge: com ele, qualquer região
 * com mais de uns 8 mil caracteres cai num bloco só e as mudanças pequenas e espalhadas se perdem (medido
 * num arquivo de 20 mil linhas). Mas a soma das passagens tem um orçamento de tempo, para que um arquivo
 * reescrito por inteiro não trave a aba: estourado, o resto usa o diff aproximado do merge.
 */
const BUDGET_MS = 300;

/** Um diff de caracteres com o tempo que ainda sobra do orçamento; sem tempo, o aproximado do merge. */
function budgetedDiff(x: string, y: string, deadline: number): readonly Change[] {
  const left = deadline - Date.now();
  return left > 0 ? diff(x, y, { timeout: left }) : diff(x, y, { scanLimit: 0 });
}

interface Line {
  /** A linha sem nenhum espaço em branco: é o que se compara. */
  key: string;
  /** Onde a linha começa no texto original. */
  from: number;
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let from = 0;
  for (;;) {
    const end = text.indexOf("\n", from);
    lines.push({ key: text.slice(from, end === -1 ? text.length : end).replace(/\s/g, ""), from });
    if (end === -1) return lines;
    from = end + 1;
  }
}

/** O offset onde começa a linha `index`; depois da última, é o fim do texto. */
function lineStart(text: string, lines: Line[], index: number): number {
  return index < lines.length ? lines[index].from : text.length;
}

/**
 * Cada chave distinta vira um caractere, em ordem de aparição; a string resultante tem uma letra por
 * linha, então os índices do diff dela são números de linha. Devolve `null` se passar do limite.
 */
function encodeLines(lines: Line[], codes: Map<string, number>): string | null {
  let encoded = "";
  for (const line of lines) {
    let index = codes.get(line.key);
    if (index === undefined) {
      if (codes.size >= MAX_DISTINCT_LINES) return null;
      index = codes.size;
      codes.set(line.key, index);
    }
    // Pula a faixa de surrogates (U+D800 a U+DFFF), que não é um caractere sozinho.
    encoded += String.fromCharCode(index < 0xd7ff ? index + 1 : index + 0x801);
  }
  return encoded;
}

/**
 * O algoritmo de diff que o `DiffConfig.override` do merge chama. Pura: dados dois textos, devolve as
 * mudanças em offsets desses textos, em ordem, sem sobreposição.
 */
export function ignoreWhitespaceDiff(a: string, b: string): readonly Change[] {
  const linesA = splitLines(a);
  const linesB = splitLines(b);
  const codes = new Map<string, number>();
  const encodedA = encodeLines(linesA, codes);
  const encodedB = encodeLines(linesB, codes);
  const deadline = Date.now() + BUDGET_MS;
  if (encodedA === null || encodedB === null) return budgetedDiff(a, b, deadline);

  const changes: Change[] = [];
  for (const block of budgetedDiff(encodedA, encodedB, deadline)) {
    const fromA = lineStart(a, linesA, block.fromA);
    const toA = lineStart(a, linesA, block.toA);
    const fromB = lineStart(b, linesB, block.fromB);
    const toB = lineStart(b, linesB, block.toB);
    for (const change of budgetedDiff(a.slice(fromA, toA), b.slice(fromB, toB), deadline)) {
      changes.push(new Change(change.fromA + fromA, change.toA + fromA, change.fromB + fromB, change.toB + fromB));
    }
  }
  return changes;
}

/**
 * A configuração de diff do merge: a mesma varredura que ele já usa, trocando o algoritmo quando espaços
 * não contam. É o que a aba de diff passa ao `MergeView` e ao `unifiedMergeView`. Pura.
 */
export function diffConfigFor(ignoreWhitespace: boolean): DiffConfig {
  return ignoreWhitespace ? { scanLimit: 500, override: ignoreWhitespaceDiff } : { scanLimit: 500 };
}
