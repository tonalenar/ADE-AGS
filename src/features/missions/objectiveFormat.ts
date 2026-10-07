/** Uma parte do objetivo: um título em MAIÚSCULAS ("(3) PASTA DE ENXAME:", "REGRAS:") e o texto que o segue. */
export interface ObjectiveSection {
  /** Número do ponto "(n)", se o título o tem. */
  n: number | null;
  /** Título legível (sem o "(n)" nem os dois pontos), em caixa de título. */
  label: string;
  body: string;
}

export interface ObjectiveParts {
  /** O texto antes do primeiro título (ou o objetivo todo quando não há títulos). */
  intro: string;
  sections: ObjectiveSection[];
}

/** Um título é uma corrida de MAIÚSCULAS (letras maiúsculas na maior parte) com pelo menos 5 letras. */
function looksLikeHeading(text: string): boolean {
  const letters = text.replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (letters.length < 5) return false;
  const upper = letters.replace(/[^A-ZÀ-Ý]/g, "").length;
  return upper / letters.length >= 0.8;
}

/** "LEITURA POR INDICE (M3, Fase 2)" -> "Leitura por indice (M3, Fase 2)". */
function toTitleCase(text: string): string {
  // O que está entre parênteses ("M3, Fase 2") fica como veio: são siglas de achados e nomes.
  const lowered = text.split(/(\([^)]*\))/).map((part) => (part.startsWith("(") ? part : part.toLowerCase())).join("");
  return lowered.charAt(0).toUpperCase() + lowered.slice(1);
}

// Título: opcional "(n) " + corrida de maiúsculas/dígitos/pontuação simples, terminada em ":" e seguida de espaço.
// Só vale no início do texto ou depois de um ponto final/dois pontos, para não quebrar frases comuns que tenham ":".
const HEADING = /(?<=^|[.!?:]\s)(?:\((\d+)\)\s+)?([A-ZÀ-Ý0-9](?:[A-ZÀ-Ý0-9Ç /'’,.\-]|\([^)]{0,60}\)){4,100}?):\s/g;

/**
 * Quebra o texto de um objetivo longo (escrito como um parágrafo só) em introdução + partes com título,
 * para a tela poder mostrá-lo como lista em vez de uma parede de texto. Sem títulos devolve só `intro`.
 * Pura: não altera o texto original, só o reparte.
 */
export function splitObjective(objective: string): ObjectiveParts {
  const text = objective.replace(/\r\n/g, "\n").trim();
  const found: Array<{ index: number; end: number; n: number | null; label: string }> = [];
  for (const match of text.matchAll(HEADING)) {
    const label = match[2].trim();
    if (!looksLikeHeading(label)) continue;
    found.push({ index: match.index ?? 0, end: (match.index ?? 0) + match[0].length, n: match[1] ? Number(match[1]) : null, label });
  }
  if (found.length < 2) return { intro: text, sections: [] };
  // "ETAPA 24 - MEMORIA: ..." na abertura é o título da etapa, não um ponto: entra inteiro na introdução.
  if (found[0].index === 0 && found[0].n === null) {
    const [, ...rest] = found;
    const introText = text.slice(0, rest[0].index).trim();
    return {
      intro: introText,
      sections: rest.map((item, i) => ({ n: item.n, label: toTitleCase(item.label), body: text.slice(item.end, i + 1 < rest.length ? rest[i + 1].index : text.length).trim() })).filter(hasBody),
    };
  }
  const intro = text.slice(0, found[0].index).trim();
  const sections = found.map((item, i) => ({
    n: item.n,
    label: toTitleCase(item.label),
    body: text.slice(item.end, i + 1 < found.length ? found[i + 1].index : text.length).trim(),
  }));
  return { intro, sections: sections.filter(hasBody) };
}

/** Um título sem texto próprio ("PONTOS:" logo antes de "(1)") não vira parte. */
const hasBody = (section: ObjectiveSection) => section.body.length > 0;

/** Os pontos numerados, para o resumo recolhido. */
export function numberedPoints(parts: ObjectiveParts): ObjectiveSection[] {
  return parts.sections.filter((section) => section.n !== null);
}
