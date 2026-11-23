/**
 * Sugestão do próximo prompt (texto fantasma do composer, como o Claude Code). Heurística local: lê o último
 * turno e não chama nenhum modelo, então não gasta token. Pura: os itens e os rótulos entram como dados.
 *
 * Em ordem de prioridade:
 * 1. a primeira linha da lista «Próximos passos» que o agente deixou no fim da resposta;
 * 2. uma pergunta de oferta no fim («Quer que eu…?») vira «Sim, pode fazer»;
 * 3. o agente editou arquivos neste turno e não mencionou testes: «Rode os testes».
 * Sem nenhum desses sinais, não sugere nada.
 */

export interface SuggestItem {
  kind: string;
  text?: string;
  tool?: string;
  status?: string;
}

export interface SuggestLabels {
  /** Resposta curta a uma oferta do agente. */
  yes: string;
  /** Pedido para validar o que o agente alterou. */
  runTests: string;
}

const MAX_LENGTH = 140;

const NEXT_STEPS_HEADING = /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:pr[oó]ximos?\s+passos?|next\s+steps?|siguientes?\s+pasos?|pr[oó]ximos?\s+pasos?)\s*:?\s*(?:\*\*)?\s*:?\s*$/i;
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/;
const OFFER_QUESTION = /(?:quer\s+que\s+eu|posso\s+(?:também\s+)?|deseja\s+que\s+eu|want\s+me\s+to|shall\s+i|should\s+i|would\s+you\s+like\s+me\s+to|do\s+you\s+want\s+me\s+to|quieres\s+que|¿?\s*(?:puedo|debo)\s)[^?]*\?\s*$/i;
const MENTIONS_TESTS = /\b(?:testes?|tests?|vitest|cargo\s+test|pytest|jest|tsc|typecheck)\b/i;

function clean(raw: string): string {
  return raw
    .replace(/[`*_]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function nextStepsLine(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!NEXT_STEPS_HEADING.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (!lines[j].trim()) continue;
      const item = LIST_ITEM.exec(lines[j]);
      if (!item) return null;
      const line = clean(item[1]);
      return line && line.length <= MAX_LENGTH ? line : null;
    }
    return null;
  }
  return null;
}

/** O que sugerir depois que o agente terminou o turno, ou `null`. */
export function suggestNextPrompt(items: readonly SuggestItem[], labels: SuggestLabels): string | null {
  let lastUser = -1;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].kind === "user") { lastUser = i; break; }
  }
  const turn = items.slice(lastUser + 1);
  let reply: string | null = null;
  for (let i = turn.length - 1; i >= 0; i -= 1) {
    const item = turn[i];
    if (item.kind === "assistant" && item.text?.trim()) { reply = item.text.trim(); break; }
  }
  if (!reply) return null;

  const step = nextStepsLine(reply);
  if (step) return step;
  if (OFFER_QUESTION.test(reply)) return labels.yes;
  const edited = turn.some((item) => item.kind === "tool" && (item.tool === "edit" || item.tool === "write") && item.status !== "error" && item.status !== "denied");
  if (edited && !MENTIONS_TESTS.test(reply)) return labels.runTests;
  return null;
}
