/**
 * O resumo da página que o agente recebe no fim de um `act` (achado O4 do plano v2).
 *
 * Antes era o começo do snapshot cortado em 6.000 caracteres. Numa página real o começo é o menu: a caixa lateral da
 * Wikipedia, o resultado da busca ou o carrinho nem chegavam. Agora, quando a página não cabe, o orçamento vai primeiro
 * para (1) as linhas que se parecem com o OBJETIVO, (2) a camada de cima (um `dialog` aberto) e a região principal
 * (`main`) e só no que sobrar (3) o resto, com o menu, o cabeçalho e o rodapé por último. As linhas escolhidas voltam à
 * ordem da página, com um «… N linhas omitidas» onde se pulou. Uma página que cabe inteira sai exatamente como veio.
 */
import { words } from "./jevPilot";

export const SUMMARY_BUDGET = 6000;

/** Quanto do orçamento pode ir só para as linhas parecidas com o objetivo (o resto fica para a estrutura). */
const MATCH_SHARE = 0.55;
/** Teto de avisos «… N linhas omitidas» (cada um custa ~40 caracteres). */
const MAX_GAP_MARKS = 14;
const GAP_COST = 44;
/** O aviso final de «não couberam» (com a contagem do menu). */
const TAIL_RESERVE = 140;

/** Prioridade da região: menor = mais cedo. */
const REGION_PRIORITY: Record<string, number> = {
  dialog: 0, alertdialog: 0, main: 1, form: 2, complementary: 3, search: 3, banner: 4, navigation: 4, contentinfo: 5,
};
const LOOSE_PRIORITY = 2;
const LANDMARKS = new Set(Object.keys(REGION_PRIORITY));
/** As regiões que são o menu e o resto da casca: o resumo as deixa por último e avisa quantas linhas pulou delas. */
const CHROME = new Set(["banner", "navigation", "contentinfo"]);

const NODE = /^(\s*)- (\S+)/;

interface Line {
  index: number;
  text: string;
  /** Nível de indentação (2 espaços = 1). */
  depth: number;
  role: string;
  priority: number;
  chrome: boolean;
}

/** Marca cada linha com a região a que pertence (o landmark mais próximo acima dela). Pura. */
function classify(lines: string[]): Line[] {
  const out: Line[] = [];
  // Pilha de landmarks abertos: cada um vale enquanto as linhas seguintes forem mais fundas.
  const stack: { depth: number; role: string }[] = [];
  lines.forEach((text, index) => {
    const m = NODE.exec(text);
    const depth = m ? Math.floor(m[1].length / 2) : 0;
    const role = m ? m[2] : "";
    while (stack.length > 0 && depth <= stack[stack.length - 1].depth) stack.pop();
    if (m && LANDMARKS.has(role)) stack.push({ depth, role });
    // O landmark mais PRIORITÁRIO (menor número) entre os abertos: um `main` dentro de um `dialog` conta como `dialog`.
    let region: string | null = null;
    for (const open of stack) {
      if (region === null || REGION_PRIORITY[open.role] < REGION_PRIORITY[region]) region = open.role;
    }
    const chromeOnly = stack.length > 0 && stack.every((open) => CHROME.has(open.role));
    out.push({
      index, text, depth, role,
      priority: region === null ? LOOSE_PRIORITY : REGION_PRIORITY[region],
      chrome: chromeOnly,
    });
  });
  return out;
}

const overlap = (wanted: Set<string>, text: string): number => {
  let n = 0;
  for (const w of words(text)) if (wanted.has(w)) n += 1;
  return n;
};

/**
 * Cabe o snapshot no orçamento sem cortar o que importa. `goal` é o objetivo do `act`. Pura.
 */
export function summarizeSnapshot(snapshot: string, goal: string, budget = SUMMARY_BUDGET): string {
  if (snapshot.length <= budget) return snapshot;

  const all = snapshot.split("\n");
  // O cabeçalho (page:, viewport:) até a primeira linha em branco: sempre fica.
  const blank = all.indexOf("");
  const header = blank >= 0 ? all.slice(0, blank) : [];
  const body = blank >= 0 ? all.slice(blank + 1) : all;
  const lines = classify(body);

  const wanted = words(goal);
  const kept = new Set<number>();
  const note = "(resumo: a página é grande; vêm primeiro as linhas do objetivo, a camada de cima e a região principal)";
  let bytes = header.reduce((n, l) => n + l.length + 1, 0) + note.length + 1 + 2 + TAIL_RESERVE + MAX_GAP_MARKS * GAP_COST;
  const room = (line: Line) => bytes + line.text.length + 1 <= budget;
  const take = (line: Line): boolean => {
    if (kept.has(line.index)) return true;
    if (!room(line)) return false;
    kept.add(line.index);
    bytes += line.text.length + 1;
    return true;
  };

  // 1. As linhas que falam do objetivo, as que mais se parecem primeiro (até uma fatia do orçamento).
  const matchLimit = bytes + (budget - bytes) * MATCH_SHARE;
  const scored = lines
    .map((line) => ({ line, score: NODE.test(line.text) ? overlap(wanted, line.text) : 0 }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.line.priority - b.line.priority || a.line.index - b.line.index);
  for (const { line } of scored) {
    if (bytes + line.text.length + 1 > matchLimit) continue;
    take(line);
  }

  // 2. A estrutura por região: a camada de cima e a principal inteiras antes do menu, cada região na ordem da página.
  const byPriority = [...lines].sort((a, b) => a.priority - b.priority || a.index - b.index);
  for (const line of byPriority) {
    if (!take(line)) {
      // Não coube: linhas curtas depois desta ainda podem caber, mas a região deve ser lida em ordem; segue para a próxima região.
      continue;
    }
  }

  // 3. Volta à ordem da página, avisando onde se pulou.
  const out: string[] = [];
  let gaps = 0;
  let skipped = 0;
  let skippedChrome = 0;
  let previous = -1;
  for (const line of lines) {
    if (!kept.has(line.index)) {
      skipped += 1;
      if (line.chrome) skippedChrome += 1;
      continue;
    }
    if (line.index - previous > 1 && previous >= 0 && gaps < MAX_GAP_MARKS) {
      out.push(`${"  ".repeat(Math.min(line.depth, 4))}… ${line.index - previous - 1} linhas omitidas`);
      gaps += 1;
    } else if (previous < 0 && line.index > 0 && gaps < MAX_GAP_MARKS) {
      out.push(`… ${line.index} linhas omitidas`);
      gaps += 1;
    }
    out.push(line.text);
    previous = line.index;
  }
  if (previous >= 0 && previous < lines.length - 1) out.push(`… ${lines.length - 1 - previous} linhas omitidas`);

  const tail = skipped > 0
    ? `… ${skipped} linhas não couberam${skippedChrome > 0 ? ` (${skippedChrome} do menu, cabeçalho ou rodapé)` : ""}; peça o snapshot para ver tudo`
    : null;
  return [...header, note, "", ...out, ...(tail ? [tail] : [])].join("\n");
}
