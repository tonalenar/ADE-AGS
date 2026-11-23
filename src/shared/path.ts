/** Último segmento de um caminho POSIX ou Windows (sem barras finais). Devolve `""` para vazio ou raiz. */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/** Como [`basename`], devolvendo o próprio caminho quando for raiz ou vazio. */
export function basenameOrSelf(path: string): string {
  return basename(path) || path;
}
