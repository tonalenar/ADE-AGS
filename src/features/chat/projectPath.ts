/** Normaliza separadores e barras finais sem alterar a grafia real do caminho. */
export function normalizeProjectPath(cwd: string): string {
  const path = cwd.replace(/\\/g, "/");
  if (/^[A-Za-z]:\/$/.test(path)) return path;
  const withoutTrailingSlashes = path.replace(/\/+$/, "");
  return withoutTrailingSlashes || (path.startsWith("/") ? "/" : "");
}
