/**
 * As citações do chat («Comentar» um trecho de uma fala): o modelo puro. Uma citação é um trecho selecionado numa
 * fala e o comentário da pessoa sobre ele. Vai na mensagem como um bloco de texto claro para QUALQUER motor
 * (`> trecho` e `| comentário`, depois do texto da pessoa e antes do bloco de anexos); a bolha lê o bloco de volta e
 * mostra cartões, sem o texto cru. Nada disto muda o que o backend guarda: é só texto da mensagem. Sem React.
 */

/** Quantas citações cabem numa mensagem. */
export const MAX_QUOTES = 10;
/** O tamanho máximo do trecho citado (em caracteres); passando, é cortado com «…». */
export const MAX_QUOTE_CHARS = 1_500;

export interface Quote {
  id: string;
  text: string;
  comment: string;
}

export interface ParsedQuote {
  text: string;
  comment: string;
}

const HEADER = "[Citação]";

/** O trecho como vai na mensagem: sem o espaço de sobra nas pontas e nas linhas em branco repetidas, cortado no limite. Pura. */
export function clipQuote(raw: string): string {
  const text = raw.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > MAX_QUOTE_CHARS ? `${text.slice(0, MAX_QUOTE_CHARS).trimEnd()}…` : text;
}

/** Junta uma citação à lista: sem repetir a mesma, sem vazio, até o máximo. Pura. */
export function addQuote(list: Quote[], input: { text: string; comment: string }): Quote[] {
  const text = clipQuote(input.text);
  const comment = input.comment.trim();
  if (!text || !comment || list.length >= MAX_QUOTES) return list;
  if (list.some((q) => q.text === text && q.comment === comment)) return list;
  return [...list, { id: `q-${Date.now().toString(36)}-${list.length}-${Math.random().toString(36).slice(2, 6)}`, text, comment }];
}

const lines = (text: string, prefix: string) => text.split("\n").map((line) => `${prefix}${line}`);

/** O bloco das citações. Vazio sem citações. Pura. */
export function quoteBlock(list: { text: string; comment: string }[]): string {
  return list.flatMap((q) => [HEADER, ...lines(q.text, "> "), ...lines(q.comment, "| ")]).join("\n");
}

/** O texto da pessoa com as citações depois dele (ou só elas, sem texto). Pura. */
export function withQuotes(text: string, list: { text: string; comment: string }[]): string {
  const block = quoteBlock(list);
  if (!block) return text;
  return text.trim() ? `${text.trimEnd()}\n\n${block}` : block;
}

const isQuoteLine = (line: string) => line === HEADER || line.startsWith("> ") || line.startsWith("| ") || line === ">" || line === "|";

/**
 * Separa as citações do fim da mensagem: o bloco contíguo que começa em `[Citação]` e vai até o fim. Linhas `>`
 * antes dele (um `>` de markdown) continuam sendo texto. Sem o cabeçalho não é nosso: passa intacto. Pura.
 */
export function splitQuotes(raw: string): { text: string; quotes: ParsedQuote[] } {
  const all = raw.replace(/\s+$/, "").split("\n");
  let start = all.length;
  while (start > 0 && isQuoteLine(all[start - 1]!)) start--;
  const run = all.slice(start);
  const first = run.indexOf(HEADER);
  if (first < 0) return { text: raw, quotes: [] };
  const quotes: ParsedQuote[] = [];
  let current: { quote: string[]; comment: string[] } | null = null;
  for (const line of run.slice(first)) {
    if (line === HEADER) {
      if (current) quotes.push({ text: current.quote.join("\n"), comment: current.comment.join("\n") });
      current = { quote: [], comment: [] };
    } else if (current) {
      (line.startsWith(">") ? current.quote : current.comment).push(line.slice(2));
    }
  }
  if (current) quotes.push({ text: current.quote.join("\n"), comment: current.comment.join("\n") });
  const valid = quotes.filter((q) => q.text.length > 0);
  if (valid.length === 0) return { text: raw, quotes: [] };
  return { text: all.slice(0, start + first).join("\n").trim(), quotes: valid };
}
