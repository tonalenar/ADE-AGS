import type { Terminal } from "@xterm/xterm";

/**
 * Las terminales vivas, por tab. Es la puerta para escribirle a un agente desde otra parte
 * de la app (hoy, el navegador que le manda elementos marcados).
 *
 * Se pega a través de xterm y no escribiendo directo al PTY: `paste()` sabe si la TUI pidió
 * *bracketed paste* y envuelve el texto como corresponde. Escribiendo crudo, cada salto de
 * línea de un mensaje de varias líneas llegaría como un Enter y lo mandaría a medias.
 */
const terminals = new Map<string, Terminal>();

/** Mensajes para agentes que todavía no terminaron de arrancar. */
const queued = new Map<string, string>();

/** Cuánto tiene que estar callada la terminal para dar por hecho que la TUI ya arrancó y
 *  espera que le escriban. Los comandos previos y el arranque imprimen en ráfagas. */
const SETTLE_MS = 2500;
/** Si nunca llega a quedarse quieta (una TUI con reloj en pantalla), se manda igual. */
const GIVE_UP_MS = 45_000;

/** Avisos de tiempo de un mensaje con `sendWhenReady`, para el cronómetro de la misión. */
export interface SendTimings {
  /** El mensaje se pegó (la TUI ya había arrancado). */
  onSent?: (at: number) => void;
  /** El agente terminó de contestar: dejó de escribir. `at` es su última salida. */
  onTurnEnd?: (at: number) => void;
}

const queuedTimings = new Map<string, SendTimings>();

/** Silencio que da por terminado el turno de un agente (el mismo criterio que `peer ask`). */
const TURN_QUIET_MS = 5000;
/** Si un turno no termina nunca (o la terminal se cierra), se deja de mirar. */
const TURN_GIVE_UP_MS = 20 * 60_000;

/** Mira la terminal hasta que el agente se calla y avisa cuándo escribió por última vez. */
function watchTurn(term: Terminal, onEnd: (at: number) => void): void {
  let quiet: number | undefined;
  let lastOutput = 0;
  const finish = () => {
    sub.dispose();
    window.clearTimeout(quiet);
    window.clearTimeout(giveUp);
    onEnd(lastOutput);
  };
  const sub = term.onWriteParsed(() => {
    lastOutput = Date.now();
    window.clearTimeout(quiet);
    quiet = window.setTimeout(finish, TURN_QUIET_MS);
  });
  const giveUp = window.setTimeout(() => {
    sub.dispose();
    window.clearTimeout(quiet);
  }, TURN_GIVE_UP_MS);
}

/** Espera a que la TUI termine de arrancar y le manda `text`. */
function sendWhenSettled(tabId: string, term: Terminal, text: string): void {
  let timer: number | undefined;
  let sawOutput = false;
  const timings = queuedTimings.get(tabId);
  const send = () => {
    sub.dispose();
    window.clearTimeout(timer);
    window.clearTimeout(giveUp);
    if (terminals.get(tabId) !== term) return;
    queued.delete(tabId);
    queuedTimings.delete(tabId);
    pasteIntoTab(tabId, text, true);
    timings?.onSent?.(Date.now());
    if (timings?.onTurnEnd) watchTurn(term, timings.onTurnEnd);
  };
  const sub = term.onWriteParsed(() => {
    sawOutput = true;
    window.clearTimeout(timer);
    timer = window.setTimeout(send, SETTLE_MS);
  });
  const giveUp = window.setTimeout(() => { if (sawOutput) send(); else sub.dispose(); }, GIVE_UP_MS);
}

/**
 * Deja un mensaje para el agente de `tabId`, que se envía cuando su TUI termina de
 * arrancar. Es para una tab recién abierta: pegar antes le escribiría al shell de los
 * comandos previos, o a una TUI que todavía no dibujó su entrada y lo tira.
 *
 * Ninguna de las TUIs tiene un flag común para "arrancá con este mensaje", así que se
 * espera a que la terminal se quede quieta, que es cuando la persona empezaría a escribir.
 */
export function sendWhenReady(tabId: string, text: string, timings?: SendTimings): void {
  queued.set(tabId, text);
  if (timings) queuedTimings.set(tabId, timings);
  const term = terminals.get(tabId);
  if (term) sendWhenSettled(tabId, term, text);
}

export function registerTerminal(tabId: string, term: Terminal): () => void {
  terminals.set(tabId, term);
  const pending = queued.get(tabId);
  if (pending !== undefined) sendWhenSettled(tabId, term, pending);
  return () => {
    if (terminals.get(tabId) === term) terminals.delete(tabId);
  };
}

/** Pega `text` en la terminal de la tab y, con `submit`, lo manda. `false` si la tab no
 *  tiene una terminal viva. */
export function pasteIntoTab(tabId: string, text: string, submit: boolean): boolean {
  const term = terminals.get(tabId);
  if (!term) return false;
  term.paste(text);
  // El Enter va aparte y un momento después: algunas TUIs todavía están procesando el
  // pegado cuando llega, y lo toman como parte de él en vez de como "enviar".
  if (submit) setTimeout(() => term.input("\r"), 80);
  return true;
}

export interface ScreenText {
  lines: string[];
  /** La línea siguiente a la última escrita: la marca para leer "desde acá" después. */
  end: number;
  /** Pantalla alternativa (TUIs a pantalla completa): no hay historial, solo lo visible. */
  alt: boolean;
}

/**
 * El texto de la terminal de una tab, ya dibujado por xterm — sin escapes ni repintados,
 * que es lo que hace legible la respuesta de una TUI para otro agente.
 *
 * Con `from` devuelve desde esa línea hasta el cursor (lo que la TUI escribió después de la
 * marca); sin él, lo que se ve ahora. En pantalla alternativa no hay "desde": lo que había
 * se repintó encima, así que se devuelve lo visible. Las líneas vacías del final se cortan
 * y se devuelven a lo sumo `max` (las últimas).
 */
export function screenOf(tabId: string, from?: number | null, max = 200): ScreenText | null {
  const term = terminals.get(tabId);
  if (!term) return null;
  const buf = term.buffer.active;
  const alt = buf.type === "alternate";
  const end = buf.baseY + buf.cursorY + 1;
  const start = alt || from == null ? buf.viewportY : Math.min(Math.max(0, from), end);
  const stop = alt || from == null ? Math.min(buf.length, buf.viewportY + term.rows) : end;

  const lines: string[] = [];
  for (let y = start; y < stop; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? "");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return { lines: lines.slice(-max), end, alt };
}

/** Le da el foco a la terminal de la tab, para seguir escribiendo en lo que se pegó. */
export function focusTab(tabId: string): void {
  terminals.get(tabId)?.focus();
}
