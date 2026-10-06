/**
 * Segmenta el buffer de la terminal de un agente en RESPUESTAS, para poder mandar al chat solo
 * una de ellas (y no toda la pantalla).
 *
 * ## Cómo se reconoce
 *
 * Desde afuera no hay «mensajes»: lo decide la TUI. Lo que sí es estable es su convención visual:
 *
 * - El **prompt del usuario** empieza en la columna 0 con `>`, `›` o `❯` (Claude Code, Codex,
 *   Gemini CLI), a veces dentro de la caja de entrada (`│ > …`).
 * - La **respuesta** abre con un marcador en la columna 0: `●`/`⏺` (Claude Code), `•` (Codex),
 *   `✦` (Gemini CLI), `◆`/`◇` (Antigravity y similares). Los siguientes marcadores (llamadas a
 *   herramientas, más texto) pertenecen a la MISMA respuesta hasta el próximo prompt.
 * - La caja de entrada y sus rayas (`╭─…`, `────`) cierran la respuesta: no son contenido.
 *
 * Es una heurística: una línea de código que empiece con `>` pegada a la izquierda se leería como
 * prompt. Por eso el usuario siempre puede caer a la selección libre. Pura y sin xterm.
 */
export interface ResponseSegment {
  /** Orden en el buffer, desde 0. */
  index: number;
  /** Primera y última línea del buffer (inclusive) que ocupa la respuesta. */
  startLine: number;
  endLine: number;
  /** El prompt del usuario que la provocó (primera línea), o `null` si quedó fuera del buffer. */
  prompt: string | null;
  /** El marcador con que abrió: `●`, `•`, `✦`… */
  marker: string;
  /** El texto limpio: sin el marcador de apertura y sin la sangría de la TUI. */
  text: string;
}

const PROMPT = /^(?:│\s*)?[>›❯]\s+(.*?)(?:\s*│)?$/;
const MARKER = /^([●⏺•✦◆◇])\s+/;
const BORDER = /^\s*[╭╰┌└├]|^\s*[─━═]{3,}\s*$/;

/** ¿La línea abre un prompt del usuario? Devuelve su texto. */
export function promptText(line: string): string | null {
  const m = PROMPT.exec(line.trimEnd());
  if (!m) return null;
  const text = m[1].trim();
  return text.length > 0 ? text : null;
}

/** Quita la sangría común de las líneas de continuación (la TUI las pone con 2 espacios). */
function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(Math.min(cut, /^ */.exec(l)![0].length)).trimEnd());
}

export function segmentResponses(lines: readonly string[]): ResponseSegment[] {
  const out: ResponseSegment[] = [];
  let prompt: string | null = null;
  let cur: { start: number; end: number; marker: string; body: string[] } | null = null;
  // Tras la caja de entrada no se lee nada hasta el próximo prompt.
  let sealed = false;

  const close = () => {
    if (!cur) return;
    // La primera línea ya perdió su marcador: la sangría común se calcula con el resto.
    const body = [cur.body[0] ?? "", ...dedent(cur.body.slice(1))];
    while (body.length && !body[body.length - 1].trim()) body.pop();
    while (body.length && !body[0].trim()) body.shift();
    if (body.length) {
      out.push({ index: out.length, startLine: cur.start, endLine: cur.start + cur.body.length - 1, prompt, marker: cur.marker, text: body.join("\n") });
    }
    cur = null;
  };

  lines.forEach((raw, y) => {
    const line = raw.replace(/\s+$/, "");
    const p = promptText(line);
    if (p !== null) {
      close();
      prompt = p;
      sealed = false;
      return;
    }
    if (BORDER.test(line)) {
      if (cur) {
        close();
        sealed = true;
      }
      return;
    }
    if (sealed) return;
    const m = MARKER.exec(line);
    if (m) {
      if (!cur) cur = { start: y, end: y, marker: m[1], body: [] };
      // El marcador de apertura sale del texto; los siguientes (herramientas) se dejan: son contenido.
      cur.body.push(cur.body.length === 0 ? line.slice(m[0].length) : line);
      return;
    }
    if (cur) cur.body.push(line);
  });
  close();
  return out;
}
