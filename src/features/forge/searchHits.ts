export interface SearchHit {
  path: string;
  line: number;
  excerpt: string;
}

const LIMIT = 500;

function hitsInText(path: string, text: string, needle: string, result: SearchHit[]): void {
  const searchText = text.toLowerCase();
  let from = 0;
  let line = 1;
  let lineEnd = text.indexOf("\n");
  while (from < searchText.length && result.length < LIMIT) {
    const match = searchText.indexOf(needle, from);
    if (match < 0) break;
    while (lineEnd >= 0 && lineEnd < match) {
      line += 1;
      lineEnd = text.indexOf("\n", lineEnd + 1);
    }
    const start = text.lastIndexOf("\n", match) + 1;
    const end = lineEnd < 0 ? text.length : lineEnd;
    result.push({ path, line, excerpt: text.slice(start, end).replace(/^\+/, "").trimEnd() });
    from = match + needle.length;
  }
}

/** Busca no patch da listagem ou no conteúdo já carregado — sem baixar o PR inteiro. */
export function searchHitsFromSources(
  query: string,
  files: { path: string; patch: string | null }[],
  contents: Record<string, { content: string | null }>,
): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const result: SearchHit[] = [];
  for (const file of files) {
    if (result.length >= LIMIT) break;
    const loaded = contents[file.path]?.content;
    if (loaded) hitsInText(file.path, loaded, needle, result);
    else if (file.patch) hitsInText(file.path, file.patch, needle, result);
  }
  return result;
}
