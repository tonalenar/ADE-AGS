/** Um `git diff` em texto, dividido por arquivo para o painel Diff do modo chat. Puro. */

export type DiffLineKind = "hunk" | "add" | "del" | "ctx";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface FileDiff {
  path: string;
  added: number;
  removed: number;
  /** Arquivo binário ou só de modo/renome: sem linhas. */
  lines: DiffLine[];
}

/** O caminho de `diff --git a/x b/y` (o de destino; num renome, o novo). */
function pathOf(header: string): string {
  const m = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
  return m ? m[2]! : header.replace(/^diff --git /, "");
}

export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = { path: pathOf(line), added: 0, removed: 0, lines: [] };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;
    if (line.startsWith("@@")) {
      inHunk = true;
      file.lines.push({ kind: "hunk", text: line });
    } else if (!inHunk) {
      // Cabeçalho do arquivo (index, ---, +++, new file mode…): fora das linhas.
      continue;
    } else if (line.startsWith("+")) {
      file.added += 1;
      file.lines.push({ kind: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      file.removed += 1;
      file.lines.push({ kind: "del", text: line.slice(1) });
    } else if (line.startsWith("\\")) {
      continue;
    } else {
      file.lines.push({ kind: "ctx", text: line.startsWith(" ") ? line.slice(1) : line });
    }
  }
  return files;
}
