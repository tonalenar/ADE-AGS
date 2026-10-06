/**
 * Fusión de conflictos de integración (`merge origin/master` en la rama de la misión), pura.
 *
 * Un archivo con conflicto trae bloques `<<<<<<<` (lo mío) / `=======` / `>>>>>>>` (lo del
 * master), y con `merge.conflictStyle=diff3` también `|||||||` (la base). Acá se parsea y se
 * resuelve cada bloque con «mantener lo mío», «mantener lo del master» o «mantener los dos».
 * «Los dos» es el patrón del proyecto para docs/ROADMAP y los locales JSON: se queda con las
 * líneas de ambos lados, sin repetir las idénticas, y en JSON arregla las comas para que el
 * archivo siga siendo válido. El código no trivial NO se resuelve acá: queda para el agente.
 */

export type ConflictChoice = "ours" | "theirs" | "both";

export type Segment =
  | { kind: "text"; lines: string[] }
  | { kind: "conflict"; ours: string[]; base: string[] | null; theirs: string[]; oursLabel: string; theirsLabel: string };

const START = /^<{7}(?: (.*))?$/;
const BASE = /^\|{7}(?: .*)?$/;
const MID = /^={7}$/;
const END = /^>{7}(?: (.*))?$/;

export interface ParsedConflicts {
  segments: Segment[];
  /** Fin de línea original, para reescribir el archivo igual que estaba. */
  eol: "\n" | "\r\n";
  /** Un bloque abierto sin cerrar: el archivo no se puede resolver acá. */
  malformed: boolean;
}

export function parseConflicts(content: string): ParsedConflicts {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const segments: Segment[] = [];
  let text: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const start = START.exec(lines[i]!);
    if (!start) {
      text.push(lines[i]!);
      i++;
      continue;
    }
    const ours: string[] = [];
    let base: string[] | null = null;
    const theirs: string[] = [];
    let part: "ours" | "base" | "theirs" = "ours";
    let closed = false;
    let theirsLabel = "";
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j]!;
      if (part === "ours" && BASE.test(line)) { part = "base"; base = []; continue; }
      if (part !== "theirs" && MID.test(line)) { part = "theirs"; continue; }
      const end = END.exec(line);
      if (part === "theirs" && end) { theirsLabel = end[1] ?? ""; closed = true; break; }
      (part === "ours" ? ours : part === "base" ? base! : theirs).push(line);
    }
    if (!closed) {
      // Bloque sin cerrar: el resto queda como texto y se avisa.
      return { segments: [...segments, { kind: "text", lines: [...text, ...lines.slice(i)] }], eol, malformed: true };
    }
    if (text.length) segments.push({ kind: "text", lines: text });
    text = [];
    segments.push({ kind: "conflict", ours, base, theirs, oursLabel: start[1] ?? "", theirsLabel });
    i = j + 1;
  }
  if (text.length) segments.push({ kind: "text", lines: text });
  return { segments, eol, malformed: false };
}

export const conflictCount = (parsed: ParsedConflicts): number => parsed.segments.filter((s) => s.kind === "conflict").length;

/** Las líneas de los dos lados, ours primero, sin repetir las que ya están. Pura. */
export function bothSides(ours: string[], theirs: string[]): string[] {
  const seen = new Set(ours.filter((l) => l.trim() !== ""));
  return [...ours, ...theirs.filter((l) => l.trim() === "" || !seen.has(l))];
}

const withoutTrailingComma = (l: string) => l.replace(/,(\s*)$/, "$1");
const withTrailingComma = (l: string) => (/,\s*$/.test(l) ? l : `${l},`);

/**
 * Los dos lados de un bloque dentro de un objeto/arreglo JSON: cada línea con contenido sale con
 * coma salvo la última del bloque, y esa conserva la coma solo si lo que sigue no cierra el
 * objeto (`}` o `]`). Así «los dos» no rompe el JSON. Pura.
 */
export function bothSidesJson(ours: string[], theirs: string[], nextLine: string | undefined): string[] {
  const merged = bothSides(ours, theirs);
  const lastIdx = merged.map((l) => l.trim() !== "").lastIndexOf(true);
  if (lastIdx < 0) return merged;
  const closes = nextLine !== undefined && /^\s*[}\]]/.test(nextLine);
  return merged.map((l, idx) => {
    if (l.trim() === "") return l;
    if (idx < lastIdx) return withTrailingComma(l);
    return closes ? withoutTrailingComma(l) : withTrailingComma(l);
  });
}

export interface Resolution {
  content: string;
  /** Para JSON: el resultado se parseó bien; para el resto, siempre `true`. */
  valid: boolean;
}

/** `true` para los archivos donde «mantener los dos» es lo esperado (docs y locales). */
export function bothIsSafe(path: string): boolean {
  return /\.(md|mdx|json)$/i.test(path);
}

/**
 * Resuelve TODOS los bloques de un archivo con la misma elección. `choices` (por índice de
 * bloque) permite mezclar; lo que no esté ahí usa `fallback`. Pura.
 */
export function resolveConflicts(
  path: string,
  content: string,
  fallback: ConflictChoice,
  choices: Readonly<Record<number, ConflictChoice>> = {},
): Resolution | null {
  const parsed = parseConflicts(content);
  if (parsed.malformed) return null;
  const json = /\.json$/i.test(path);
  const out: string[] = [];
  let index = 0;
  parsed.segments.forEach((seg, s) => {
    if (seg.kind === "text") {
      out.push(...seg.lines);
      return;
    }
    const choice = choices[index++] ?? fallback;
    if (choice === "ours") out.push(...seg.ours);
    else if (choice === "theirs") out.push(...seg.theirs);
    else {
      const next = parsed.segments[s + 1];
      const nextLine = next?.kind === "text" ? next.lines[0] : undefined;
      out.push(...(json ? bothSidesJson(seg.ours, seg.theirs, nextLine) : bothSides(seg.ours, seg.theirs)));
    }
  });
  const result = out.join(parsed.eol);
  let valid = true;
  if (json) {
    try { JSON.parse(result); } catch { valid = false; }
  }
  return { content: result, valid };
}
