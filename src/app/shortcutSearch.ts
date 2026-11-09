/** Busca sem diferença entre maiúsculas, acentos ou espaços repetidos. */
export function normalizeShortcutSearch(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

export function shortcutMatches(label: string, display: string, query: string): boolean {
  const normalized = normalizeShortcutSearch(query);
  if (!normalized) return true;
  return normalizeShortcutSearch(`${label} ${display}`).includes(normalized);
}
