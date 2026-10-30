/**
 * Helpers puros do painel "Memória" com o ai-memory externo (somente leitura). Os formatos vêm do CLI
 * 3.3.0: `search --json` devolve o snippet com `<mark>…</mark>` em volta dos termos achados. Nada aqui
 * usa innerHTML: o snippet vira segmentos de texto, e o React mostra cada um como texto puro.
 */

export interface AiMemorySnippetSegment {
  text: string;
  /** true dentro de um `<mark>`: o painel destaca esse trecho. */
  highlight: boolean;
}

// Qualquer tag, de abertura ou de fechamento; as que não são `<mark>` somem, o texto dentro fica.
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g;

/**
 * Converte o snippet do ai-memory em segmentos. Só `<mark>` vira destaque; as outras tags são
 * descartadas e o texto delas é mantido. Segmentos vizinhos com o mesmo destaque são fundidos.
 */
export function parseSnippet(snippet: string): AiMemorySnippetSegment[] {
  const out: AiMemorySnippetSegment[] = [];
  const push = (text: string, highlight: boolean) => {
    if (!text) return;
    const prev = out[out.length - 1];
    if (prev && prev.highlight === highlight) prev.text += text;
    else out.push({ text, highlight });
  };

  let highlight = false;
  let last = 0;
  for (const m of snippet.matchAll(TAG)) {
    push(snippet.slice(last, m.index), highlight);
    last = m.index + m[0].length;
    if (m[2].toLowerCase() === "mark") highlight = m[1] === "";
  }
  push(snippet.slice(last), highlight);
  return out;
}

/** Data e hora de `created_at_ms` no fuso dado (o padrão é o da máquina). Vazio se o instante for inválido. */
export function formatCreatedAt(ms: number, locale: string, timeZone?: string): string {
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short", timeZone }).format(new Date(ms));
}
