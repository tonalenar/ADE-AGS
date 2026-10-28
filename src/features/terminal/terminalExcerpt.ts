/**
 * "Trecho de terminal como contexto": o que a pessoa seleciona num terminal vira um bloco com a origem
 * (`[Trecho de «Claude Code — app», linhas 30–42]` + o texto num bloco de código) para colar na entrada de
 * outro agente ou no rascunho do chat. Tudo aqui é puro; quem lê o xterm e cola é o `ExcerptAction.tsx`.
 */

/** Teto do trecho: uma seleção de milhares de linhas não cabe numa pergunta. */
export const EXCERPT_MAX_LINES = 400;
export const EXCERPT_MAX_BYTES = 40 * 1024;

/** O `i18n.t` (ou um falso nos testes). */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** A seleção como o xterm devolve (`getSelectionPosition`): coluna e linha absoluta no buffer, as duas a
 *  partir de 0 (a tipagem diz 1, a implementação não), com o fim exclusivo na coluna. */
export interface SelectionRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

/**
 * As linhas (1-based, absolutas no buffer: não mudam ao rolar) que a seleção cobre. Uma seleção que termina
 * na coluna 0 não pega nada da última linha; as linhas em branco do fim não contam. Pura.
 */
export function selectionLines(range: SelectionRange, rowText: (y: number) => string): { from: number; to: number } {
  const [a, b] = range.start.y <= range.end.y ? [range.start, range.end] : [range.end, range.start];
  let last = b.y;
  if (last > a.y && b.x === 0) last -= 1;
  while (last > a.y && rowText(last).trim() === "") last -= 1;
  return { from: a.y + 1, to: last + 1 };
}

/** As linhas do texto selecionado, sem CRLF (o xterm junta com `\r\n` no Windows) e sem as em branco do
 *  fim. O resto fica como está na tela. Pura. */
export function selectionTextLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

/** Uma cerca que o próprio trecho não fecha: uma a mais que a maior sequência de crases dele. Pura. */
export function fenceFor(body: string): string {
  const longest = Math.max(0, ...Array.from(body.matchAll(/`+/g), (m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

const utf8 = new TextEncoder();
const bytesOf = (text: string) => utf8.encode(text).length;

/** Corta `text` para caber em `max` bytes UTF-8 sem partir um caractere. Pura. */
function cutToBytes(text: string, max: number): string {
  let out = "";
  let used = 0;
  for (const ch of text) {
    const size = bytesOf(ch);
    if (used + size > max) break;
    out += ch;
    used += size;
  }
  return out;
}

export interface Excerpt {
  /** O cabeçalho, o bloco de código e, se cortou, o aviso. */
  text: string;
  truncated: boolean;
}

/**
 * O bloco que vai para o outro agente ou para o chat. `null` se a seleção é só espaço. Passou do teto,
 * ficam as primeiras linhas e o texto diz que foi cortado (o cabeçalho continua dizendo o que foi
 * selecionado). Pura.
 */
export function buildExcerpt(
  input: { source: string; text: string; from: number; to: number },
  t: Translate,
  limits: { maxLines: number; maxBytes: number } = { maxLines: EXCERPT_MAX_LINES, maxBytes: EXCERPT_MAX_BYTES },
): Excerpt | null {
  const lines = selectionTextLines(input.text);
  if (lines.every((line) => line.trim() === "")) return null;
  let kept = lines.slice(0, limits.maxLines);
  let truncated = kept.length < lines.length;
  while (bytesOf(kept.join("\n")) > limits.maxBytes) {
    truncated = true;
    if (kept.length > 1) kept = kept.slice(0, -1);
    else kept = [cutToBytes(kept[0], limits.maxBytes)];
  }
  const body = kept.join("\n");
  const fence = fenceFor(body);
  const header = input.from === input.to
    ? t("terminal.excerpt.headerLine", { source: input.source, line: input.from })
    : t("terminal.excerpt.header", { source: input.source, from: input.from, to: input.to });
  const parts = [header, fence, body, fence];
  if (truncated) parts.push(t("terminal.excerpt.truncated", { lines: limits.maxLines, kb: Math.round(limits.maxBytes / 1024) }));
  return { text: parts.join("\n"), truncated };
}

/** O trecho no fim do rascunho do chat, com uma linha em branco antes e uma depois para a pergunta. Pura. */
export function appendToDraft(draft: string, block: string): string {
  const head = draft.trimEnd();
  return `${head ? `${head}\n\n` : ""}${block}\n\n`;
}

/** Como um destino aparece na lista: o título, e o agente na frente quando o título não o diz. Pura. */
export function destinationLabel(tab: { title: string; agentLabel?: string }): string {
  const agent = tab.agentLabel?.trim();
  if (!agent || tab.title.toLowerCase().includes(agent.toLowerCase())) return tab.title;
  return `${agent} · ${tab.title}`;
}

/** Tamanho do botão flutuante, para não sair da terminal. */
export const PILL = { width: 132, height: 24, gap: 4 };

/**
 * Onde fica o botão "Enviar trecho…", em pixels do próprio terminal (sem a escala do canvas): logo abaixo
 * do fim da seleção; sem espaço embaixo, acima do começo. `null` se a seleção saiu da tela. Pura.
 */
export function excerptPillPosition(input: {
  /** Linhas da seleção relativas ao topo da tela (podem ser negativas ou passar de `rows`). */
  startRow: number;
  endRow: number;
  endCol: number;
  rows: number;
  cols: number;
  cell: { width: number; height: number };
  /** Onde começa a grade do xterm dentro da caixa, e o tamanho da caixa. */
  origin: { left: number; top: number };
  box: { width: number; height: number };
}): { left: number; top: number } | null {
  const { startRow, endRow, rows, cell, origin, box } = input;
  if (endRow < 0 || startRow >= rows) return null;
  const col = Math.min(Math.max(0, input.endCol), input.cols);
  const maxLeft = Math.max(0, box.width - PILL.width - PILL.gap);
  const left = Math.min(Math.max(PILL.gap, origin.left + col * cell.width), maxLeft);
  const below = origin.top + (Math.min(endRow, rows - 1) + 1) * cell.height + PILL.gap;
  if (below + PILL.height <= box.height - PILL.gap) return { left, top: below };
  const above = origin.top + Math.max(0, startRow) * cell.height - PILL.height - PILL.gap;
  return { left, top: Math.max(PILL.gap, Math.min(above, box.height - PILL.height - PILL.gap)) };
}
