export interface SearchHit {
  path: string;
  line: number;
  excerpt: string;
}

export interface SearchHitsResult {
  hits: SearchHit[];
  /** true se algum arquivo só foi buscado no patch (conteúdo ainda não carregado). */
  partial: boolean;
}

const LIMIT = 500;
const EXCERPT_MAX = 200;
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function clipExcerpt(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.length > EXCERPT_MAX ? `${trimmed.slice(0, EXCERPT_MAX)}…` : trimmed;
}

function hitsInLoaded(path: string, text: string, needle: string, result: SearchHit[]): void {
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
    result.push({ path, line, excerpt: clipExcerpt(text.slice(start, end)) });
    from = match + needle.length;
  }
}

function hitsInPatch(path: string, patch: string, needle: string, result: SearchHit[]): void {
  const lines = patch.split("\n");
  let newLine: number | null = null;
  let inHunk = false;
  for (const raw of lines) {
    if (result.length >= LIMIT) break;
    const hunk = HUNK.exec(raw);
    if (hunk) {
      inHunk = true;
      newLine = Number(hunk[1]);
      continue;
    }
    // `+++`/`---` só são cabeçalho do arquivo; dentro do hunk `++i;` vira `+++i;`.
    if (!inHunk && (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("diff ") || raw.startsWith("index "))) {
      continue;
    }
    if (raw.startsWith("\\")) continue;
    const marker = raw[0];
    if (marker === "-") continue;
    if (marker !== "+" && marker !== " ") continue;
    const body = raw.slice(1);
    if (newLine == null) newLine = 1;
    if (body.toLowerCase().includes(needle)) {
      result.push({ path, line: newLine, excerpt: clipExcerpt(body) });
    }
    newLine += 1;
  }
}

/** Busca no patch da listagem ou no conteúdo já carregado — sem baixar o PR inteiro. */
export function searchHitsFromSources(
  query: string,
  files: { path: string; patch: string | null }[],
  contents: Record<string, { content: string | null }>,
): SearchHitsResult {
  const needle = query.trim().toLowerCase();
  if (!needle) return { hits: [], partial: false };
  const hits: SearchHit[] = [];
  let partial = false;
  for (const file of files) {
    if (hits.length >= LIMIT) break;
    const loaded = contents[file.path]?.content;
    if (loaded) hitsInLoaded(file.path, loaded, needle, hits);
    else if (file.patch) {
      partial = true;
      hitsInPatch(file.path, file.patch, needle, hits);
    } else {
      partial = true;
    }
  }
  return { hits, partial };
}
