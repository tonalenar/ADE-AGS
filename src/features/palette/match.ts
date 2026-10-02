/**
 * A busca da paleta de comandos.
 *
 * Sem biblioteca de fuzzy: a lista tem dezenas de itens, não milhares, e o que importa é
 * que o resultado seja previsível. As regras, em ordem de peso:
 *
 * 1. O título começa com a busca.
 * 2. Uma palavra do título começa com a busca ("ses" acha "Abrir sessões").
 * 3. A busca aparece inteira em algum lugar do título ou das palavras-chave.
 * 4. As letras da busca aparecem em ordem no título ("mkt" acha "Marketplace").
 *
 * Acento e maiúscula não contam: quem digita "sessoes" quer "Sessões".
 */

export interface Searchable {
  title: string;
  /** Sinônimos e termos em outros idiomas que também devem achar o item. */
  keywords?: string[];
}

export function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Pontuação de um item para a busca. `0` = não aparece. */
export function score(item: Searchable, query: string): number {
  const q = normalize(query);
  if (!q) return 1;
  const title = normalize(item.title);
  if (title.startsWith(q)) return 100;
  if (title.split(/[\s/·-]+/).some((word) => word.startsWith(q))) return 80;
  if (title.includes(q)) return 60;
  const keywords = (item.keywords ?? []).map(normalize);
  if (keywords.some((k) => k.startsWith(q))) return 50;
  if (keywords.some((k) => k.includes(q))) return 40;
  if (isSubsequence(q.replace(/\s+/g, ""), title)) return 20;
  return 0;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

/**
 * Os itens que batem com a busca, do mais relevante ao menos. Empates mantêm a ordem
 * original: é ela que diz o que vem primeiro quando a busca está vazia.
 */
export function rank<T extends Searchable>(items: T[], query: string): T[] {
  return items
    .map((item, index) => ({ item, index, s: score(item, query) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.index - b.index)
    .map((r) => r.item);
}
