import type { Terminal } from "@xterm/xterm";

import { useTabsStore } from "@/features/tabs/store";
import { ptyWrite, ptyWriteComposto } from "@/features/terminal/ipc";

import { markInput } from "./activity";
import { requestPtyLaunch } from "./ptyLaunch";

/**
 * Las terminales vivas, por tab. Es la puerta para escribirle a un agente desde otra parte
 * de la app (hoy, el navegador que le manda elementos marcados).
 *
 * Se pega a través de xterm y no escribiendo directo al PTY: `paste()` sabe si la TUI pidió
 * *bracketed paste* y envuelve el texto como corresponde. Escribiendo crudo, cada salto de
 * línea de un mensaje de varias líneas llegaría como un Enter y lo mandaría a medias.
 */
const terminals = new Map<string, Terminal>();
/** `typed` = o que estava antes do cursor no Enter (a caixa de entrada da TUI), para rotular o envio. */
type SubmittedListener = (tabId: string, at: number, typed: string) => void;
const submittedListeners = new Set<SubmittedListener>();

export function onPromptSubmitted(listener: SubmittedListener): () => void {
  submittedListeners.add(listener);
  return () => { submittedListeners.delete(listener); };
}

/** O último texto que o app colou com Enter em cada aba (o colado grande vira um marcador na tela). */
const lastPaste = new Map<string, { text: string; at: number }>();

/** O texto que o app colou nesta aba há menos de `within` ms, se houve. */
export function recentPaste(tabId: string, now = Date.now(), within = 3000): string | null {
  const paste = lastPaste.get(tabId);
  return paste && now - paste.at <= within ? paste.text : null;
}

/** Mensajes para agentes que todavía no terminaron de arrancar. */
const queued = new Map<string, string>();
/** Cancelamento da espera da aba/PTY, para limpar ao entregar ou substituir a mensagem. */
const ptyWaits = new Map<string, () => void>();

/** Cuánto tiene que estar callada la terminal para dar por hecho que la TUI ya arrancó y
 *  espera que le escriban. Los comandos previos y el arranque imprimen en ráfagas. */
const SETTLE_MS = 2500;
/** Si nunca llega a quedarse quieta (una TUI con reloj en pantalla), se manda igual. */
const GIVE_UP_MS = 45_000;
/** Aba restaurada sem PTY: espera o lançamento e desiste com `onStalled`, sem o timer de 45 s. */
const LAUNCH_WAIT_MS = 8_000;

/** `missing` = a aba ainda não está no store; `idle` = existe sem processo; `live` = tem PTY. */
function tabPtyState(tabId: string): "missing" | "idle" | "live" {
  const tab = useTabsStore.getState().tabs.find((tab) => tab.id === tabId);
  if (!tab) return "missing";
  return tab.ptyId != null ? "live" : "idle";
}

/** Avisos de tiempo de un mensaje con `sendWhenReady`, para el cronómetro de la misión. */
export interface SendTimings {
  /** El mensaje se pegó (la TUI ya había arrancado). */
  onSent?: (at: number) => void;
  /** El agente terminó de contestar: dejó de escribir. `at` es su última salida. */
  onTurnEnd?: (at: number) => void;
  /** Pasaron `START_CHECK_MS` desde el envío y la terminal no mostró actividad: el agente no arrancó. */
  onStalled?: () => void;
  /** Primera salida del agente más allá del eco del pegado: arrancó. `at` es el instante. */
  onActivity?: (at: number) => void;
  /** Se reenvió un Enter porque el briefing seguía pegado sin enviar (o no hubo actividad). */
  onRetry?: (at: number) => void;
  /** Só pega o texto na caixa, sem Enter: a pessoa revisa e envia (a pergunta do guia de revisão). */
  draft?: boolean;
  /**
   * Conferido logo antes de colar (depois da espera da TUI): `false` = não cola, descarta a mensagem
   * e chama `onSkipped`. É onde quem cutuca rechecha o interruptor e se o destino voltou a trabalhar.
   */
  guard?: () => boolean;
  /** O `guard` disse não: nada foi colado. */
  onSkipped?: () => void;
  /**
   * A mensagem não entrou no terminal: a aba não ganhou PTY a tempo, o terminal fechou antes de colar, ou o PTY
   * recusou a escrita. Nada foi enviado, então quem espera a entrega não deve contá-la como enviada.
   */
  onFailed?: (motivo: string) => void;
}

const queuedTimings = new Map<string, SendTimings>();

/** Silencio que da por terminado el turno de un agente (el mismo criterio que `peer ask`). */
const TURN_QUIET_MS = 5000;
/** Si un turno no termina nunca (o la terminal se cierra), se deja de mirar. */
const TURN_GIVE_UP_MS = 20 * 60_000;

/** Mira la terminal hasta que el agente se calla y avisa cuándo escribió por última vez. */
export function watchTurn(term: Terminal, onEnd: (at: number) => void): void {
  let quiet: number | undefined;
  let lastOutput = 0;
  const finish = () => {
    sub.dispose();
    window.clearTimeout(giveUp);
    onEnd(lastOutput);
  };
  // Um timer só, reagendado para o fim do silêncio: cada pedaço de saída apenas anota a hora (A087).
  const check = () => {
    quiet = undefined;
    const left = lastOutput + TURN_QUIET_MS - Date.now();
    if (left > 0) quiet = window.setTimeout(check, left);
    else finish();
  };
  const sub = term.onWriteParsed(() => {
    lastOutput = Date.now();
    if (quiet === undefined) quiet = window.setTimeout(check, TURN_QUIET_MS);
  });
  const giveUp = window.setTimeout(() => {
    sub.dispose();
    window.clearTimeout(quiet);
  }, TURN_GIVE_UP_MS);
}

/** Cuánto después de enviar el briefing se verifica que el agente arrancó. */
export const START_CHECK_MS = 25_000;
/**
 * Antes de eso, un Enter si la terminal sigue muda: un Enter sobre la caja vacía no hace nada, y el
 * briefing que quedó pegado sin enviar arranca 15 s antes. En el banco real 26 de 32 arranques
 * "parados" eran del QA, que arrancaba recién a los 25-40 s, después del Enter de `START_CHECK_MS`.
 */
export const EARLY_NUDGE_MS = 10_000;
/** Plazo para que TODOS los agentes arranquen sin Enter manual (lo mide `ags mission startcheck`). */
export const START_DEADLINE_MS = 120_000;
/** Salida dentro de esta ventana tras el envío es el eco del pegado, no trabajo del agente. */
const ECHO_MS = 4000;

/**
 * Verifica que el agente arrancó tras el briefing: si en `START_CHECK_MS` la terminal no escribió
 * nada más allá del eco, se le da un Enter (puede haber quedado sin enviar) y se avisa con `onStalled`.
 * Si arranca después del aviso (hasta `START_DEADLINE_MS`), `onActivity` lo sigue registrando.
 */
function watchStart(tabId: string, term: Terminal, timings: SendTimings): void {
  const sentAt = Date.now();
  let worked = false;
  const sub = term.onWriteParsed(() => {
    const now = Date.now();
    if (worked || now - sentAt <= ECHO_MS) return;
    worked = true;
    timings.onActivity?.(now);
    sub.dispose();
  });
  window.setTimeout(() => {
    if (worked || terminals.get(tabId) !== term) return;
    term.input("\r");
    timings.onRetry?.(Date.now());
  }, EARLY_NUDGE_MS);
  // El Enter ya fue a los `EARLY_NUDGE_MS`: acá solo se avisa que no arrancó.
  window.setTimeout(() => {
    if (worked || terminals.get(tabId) !== term) return;
    timings.onStalled?.();
  }, START_CHECK_MS);
  window.setTimeout(() => sub.dispose(), START_DEADLINE_MS);
}

/** O `guard` de quem manda; se ele falha, não cola (falha fechada). */
function safeGuard(guard: () => boolean): boolean {
  try {
    return guard();
  } catch {
    return false;
  }
}

/** Espera a que la TUI termine de arrancar y le manda `text`. */
function sendWhenSettled(tabId: string, term: Terminal, text: string): void {
  ptyWaits.get(tabId)?.();
  let timer: number | undefined;
  let sawOutput = false;
  const timings = queuedTimings.get(tabId);
  const send = () => {
    sub.dispose();
    window.clearTimeout(timer);
    window.clearTimeout(giveUp);
    if (terminals.get(tabId) !== term) {
      queued.delete(tabId);
      queuedTimings.delete(tabId);
      timings?.onFailed?.("o terminal foi fechado antes da entrada");
      return;
    }
    queued.delete(tabId);
    queuedTimings.delete(tabId);
    if (timings?.guard && !safeGuard(timings.guard)) {
      timings.onSkipped?.();
      return;
    }
    // Só conta como enviada quando o PTY aceita a escrita da colagem (A074), não quando ela entra na fila do xterm.
    if (tabPtyState(tabId) === "missing") {
      // Aba fora do store (um chamador ou um teste): cola pelo xterm, como sempre, e conta como enviada na hora.
      if (pasteIntoTab(tabId, text, !timings?.draft, timings?.onRetry)) timings?.onSent?.(Date.now());
      else timings?.onFailed?.("a aba não tem terminal vivo");
    } else {
      // Com PTY, só conta como enviada quando o PTY aceita a colagem e o Enter (A074).
      sendPasteToPty(tabId, term, text, !timings?.draft, timings?.onRetry).then(
        () => timings?.onSent?.(Date.now()),
        (erro: unknown) => timings?.onFailed?.(erro instanceof Error ? erro.message : String(erro)),
      );
    }
    if (timings?.onTurnEnd) watchTurn(term, timings.onTurnEnd);
    if (timings?.onStalled || timings?.onActivity) watchStart(tabId, term, timings);
  };
  const sub = term.onWriteParsed(() => {
    sawOutput = true;
    window.clearTimeout(timer);
    timer = window.setTimeout(send, SETTLE_MS);
  });
  // Sem saída nenhuma em GIVE_UP_MS: a TUI já estava pronta e simplesmente não repintou (um
  // terminal vivo e quieto). Antes a mensagem era descartada em silêncio, sem reenvio nem aviso.
  // Agora é enviada assim mesmo e o aviso de "não mostrou atividade" continua pelo watchStart.
  const giveUp = window.setTimeout(() => {
    if (terminals.get(tabId) !== term) {
      sub.dispose();
      queued.delete(tabId);
      const timings = queuedTimings.get(tabId);
      queuedTimings.delete(tabId);
      timings?.onFailed?.("o terminal foi fechado antes da entrada");
      return;
    }
    if (!sawOutput) timings?.onStalled?.();
    send();
  }, GIVE_UP_MS);
}

/** Aguarda a aba e o PTY aparecerem; sem aba no store, ainda não há destino para lançar. */
function waitForPty(tabId: string, text: string, expectedTerm = terminals.get(tabId)): void {
  ptyWaits.get(tabId)?.();
  let done = false;
  let launchRequested = false;
  let unsub: () => void = () => undefined;
  let prazo = 0;
  const parar = () => {
    if (done) return;
    done = true;
    unsub();
    window.clearTimeout(prazo);
    if (ptyWaits.get(tabId) === parar) ptyWaits.delete(tabId);
  };
  const falhar = (motivo: string) => {
    if (queued.get(tabId) !== text) {
      parar();
      return;
    }
    parar();
    queued.delete(tabId);
    const timings = queuedTimings.get(tabId);
    queuedTimings.delete(tabId);
    timings?.onStalled?.();
    timings?.onFailed?.(motivo);
  };
  const conferir = () => {
    if (queued.get(tabId) !== text) {
      parar();
      return;
    }
    if (expectedTerm && terminals.get(tabId) !== expectedTerm) {
      falhar("o terminal foi fechado antes da entrada");
      return;
    }
    const tab = useTabsStore.getState().tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    if (tab.ptyId == null) {
      if (!launchRequested) {
        launchRequested = true;
        requestPtyLaunch(tabId);
      }
      return;
    }
    const term = terminals.get(tabId);
    // A aba pode ganhar o PTY antes de o componente montar o xterm. registerTerminal
    // retoma a entrega quando esse terminal estiver pronto.
    if (!term) return;
    parar();
    sendWhenSettled(tabId, term, text);
  };
  ptyWaits.set(tabId, parar);
  unsub = useTabsStore.subscribe(conferir);
  prazo = window.setTimeout(() => falhar("a aba não ganhou um terminal a tempo"), LAUNCH_WAIT_MS);
  conferir();
}

export function sendWhenReady(tabId: string, text: string, timings?: SendTimings): void {
  ptyWaits.get(tabId)?.();
  queued.set(tabId, text);
  if (timings) queuedTimings.set(tabId, timings);
  const term = terminals.get(tabId);
  if (!term || tabPtyState(tabId) !== "live") {
    waitForPty(tabId, text, term);
    return;
  }
  sendWhenSettled(tabId, term, text);
}

export function registerTerminal(tabId: string, term: Terminal): () => void {
  terminals.set(tabId, term);
  const input = term.onData((data) => {
    if ((data === "\r" || data === "\n") && submittedListeners.size > 0) {
      let typed = "";
      try { typed = beforeCursor(term, 3); } catch { /* buffer em troca: sem rótulo */ }
      const at = Date.now();
      for (const listener of submittedListeners) listener(tabId, at, typed);
    }
  });
  const pending = queued.get(tabId);
  if (pending !== undefined) {
    if (tabPtyState(tabId) === "live") sendWhenSettled(tabId, term, pending);
    else if (!ptyWaits.has(tabId)) waitForPty(tabId, pending, term);
  }
  return () => {
    input.dispose();
    if (terminals.get(tabId) === term) terminals.delete(tabId);
  };
}

/**
 * Roda um comando num shell vivo (o «Rodar» de um bloco de código do chat): cola e dá um Enter, e o foco vai ao
 * terminal. Sem as novas tentativas de Enter do `pasteIntoTab`: elas são para TUIs que engolem o Enter, e num shell
 * um Enter a mais poderia responder sozinho a uma pergunta do próprio comando. `false` sem terminal viva.
 */
export function runInTerminal(tabId: string, text: string): boolean {
  const term = terminals.get(tabId);
  if (!term || tabPtyState(tabId) !== "live") return false;
  term.paste(text);
  setTimeout(() => term.input("\r"), 80);
  term.focus();
  return true;
}

/** Pega `text` en la terminal de la tab y, con `submit`, lo manda. `false` si la tab no
 *  tiene una terminal viva. */
/**
 * O texto de uma colagem como o xterm o mandaria: quebra de linha vira CR, e com bracketed paste ligado o texto vem
 * entre `ESC[200~` e `ESC[201~`. Pura. O envelope é montado aqui, e não pelo `paste` do xterm, para não depender de o
 * `onData` disparar síncrono.
 */
export function pasteEnvelope(text: string, bracketed: boolean): string {
  const body = text.replace(/\r?\n/g, "\r");
  return bracketed ? `\x1b[200~${body}\x1b[201~` : body;
}

/** Pausa entre a colagem e o Enter: algumas TUIs ainda processam o pegado, e tomariam o Enter como parte dele. */
const ENTER_PAUSE_MS = 80;

/** O PTY da aba agora (ou `null`). */
function ptyIdOf(tabId: string): number | null {
  return useTabsStore.getState().tabs.find((tab) => tab.id === tabId)?.ptyId ?? null;
}

/**
 * Manda a colagem pela fila do PTY e, se `submit`, o Enter depois da pausa. A promessa resolve quando o último envio
 * (o Enter, se houver) foi aceito pelo PTY, e rejeita se algum foi recusado. Quem espera sabe que a mensagem entrou.
 */
export function sendPasteToPty(
  tabId: string,
  term: Terminal,
  text: string,
  submit: boolean,
  onRetry?: (at: number) => void,
): Promise<void> {
  const id = ptyIdOf(tabId);
  if (id == null) return Promise.reject(new Error("a aba não tem terminal vivo"));
  markInput(tabId);
  if (submit) lastPaste.set(tabId, { text, at: Date.now() });
  const colada = pasteEnvelope(text, term.modes.bracketedPasteMode);
  if (!submit) return ptyWrite(id, colada);
  // A colagem, a pausa e o Enter vão como um pedido só: entram juntos, ou nenhum entra (A074). A pausa roda na thread de
  // escrita, e a promessa só resolve quando o Enter é aceito.
  const envio = ptyWriteComposto(id, [
    { tipo: "texto", dados: colada },
    { tipo: "pausa", ms: ENTER_PAUSE_MS },
    { tipo: "texto", dados: "\r" },
  ]);
  // Os retries também pela fila do PTY, e não por `term.input`, para não misturar os dois canais de entrada.
  scheduleSubmitRetries(tabId, term, text, onRetry, () => {
    ptyWrite(id, "\r").catch(() => undefined);
  });
  return envio;
}

/**
 * Um pegado grande (Codex: "[Pasted Content 3904 chars]") puede tragarse el Enter y dejar el briefing escrito sin
 * enviar. Se mira la pantalla y se reintenta. Hermes y OpenCode no cambian el pegado por un marcador: el texto queda
 * entero en la caja, con el cursor al final (`typedTextPending`). Si todavía dice "starting agent…", también se
 * tragan el Enter.
 */
function scheduleSubmitRetries(
  tabId: string,
  term: Terminal,
  text: string,
  onRetry: ((at: number) => void) | undefined,
  enviarEnter: () => void,
): void {
  SUBMIT_RETRY_MS.forEach((delay) =>
    setTimeout(() => {
      if (terminals.get(tabId) !== term) return;
      const screen = screenOf(tabId, null, 12);
      if ((screen && pasteStillPending(screen.lines)) || typedTextPending(beforeCursor(term), text)) {
        enviarEnter();
        onRetry?.(Date.now());
      }
    }, delay),
  );
}

export function pasteIntoTab(tabId: string, text: string, submit: boolean, onRetry?: (at: number) => void): boolean {
  const term = terminals.get(tabId);
  if (!term) return false;
  if (tabPtyState(tabId) === "idle") {
    requestPtyLaunch(tabId);
    return false;
  }
  term.paste(text);
  if (submit) lastPaste.set(tabId, { text, at: Date.now() });
  // El Enter va aparte y un momento después: algunas TUIs todavía están procesando el
  // pegado cuando llega, y lo toman como parte de él en vez de como "enviar".
  if (submit) {
    setTimeout(() => term.input("\r"), ENTER_PAUSE_MS);
    scheduleSubmitRetries(tabId, term, text, onRetry, () => term.input("\r"));
  }
  return true;
}

/**
 * Cola `text` na entrada da TUI da tab SEM Enter, para a pessoa completar e enviar ela mesma (o trecho de
 * terminal). Texto de várias linhas só vai com *bracketed paste* ligado: sem ele o xterm troca cada quebra
 * por um Enter, e o trecho seria enviado aos pedaços. `offline` = sem terminal viva (pede o lançamento).
 */
export function insertIntoTab(tabId: string, text: string): "ok" | "offline" | "no-multiline" {
  const term = terminals.get(tabId);
  if (!term) return "offline";
  if (tabPtyState(tabId) === "idle") {
    requestPtyLaunch(tabId);
    return "offline";
  }
  if (/[\r\n]/.test(text) && !term.modes.bracketedPasteMode) return "no-multiline";
  term.paste(text);
  return "ok";
}

/** Escribe teclas cruas na terminal da tab (ex.: "1" ou Esc para responder a um menu do TUI). `false` se não há terminal viva. */
export function sendKeysToTab(tabId: string, keys: string): boolean {
  const term = terminals.get(tabId);
  if (!term) return false;
  term.input(keys);
  return true;
}

/** O texto até o cursor: as `rows` linhas que acabam na do cursor, esta só até ele. É onde está a caixa de
 *  entrada de uma TUI esperando o Enter. */
export function beforeCursor(term: Terminal, rows = 4): string {
  const buf = term.buffer.active;
  const y = buf.baseY + buf.cursorY;
  const lines: string[] = [];
  for (let at = Math.max(0, y - rows + 1); at < y; at++) lines.push(buf.getLine(at)?.translateToString(true) ?? "");
  lines.push((buf.getLine(y)?.translateToString(true) ?? "").slice(0, buf.cursorX));
  return lines.join("");
}

/** Bordas de caixa e espaços: o mesmo texto quebrado em linhas dentro de uma caixa ainda é o mesmo texto. */
const LAYOUT = /[\s│┃║|▌▐]/g;
/** Quantos caracteres do fim do texto o cursor tem de ter logo antes dele. */
const TAIL = 16;

/**
 * O texto colado continua na caixa de entrada, sem enviar? Sim quando o que vem logo antes do cursor é o fim
 * dele: depois do envio a caixa fica vazia, e se a pessoa já digitou algo o cursor não está mais ali (um Enter
 * a mais mandaria o que ela escreveu). Pura.
 */
export function typedTextPending(beforeCursorText: string, text: string): boolean {
  const sent = text.replace(LAYOUT, "");
  if (sent.length === 0) return false;
  return beforeCursorText.replace(LAYOUT, "").endsWith(sent.slice(-TAIL));
}

/** Cuándo (ms tras pegar) se vuelve a mirar si el pegado quedó sin enviar. */
export const SUBMIT_RETRY_MS = [900, 2200, 4500, 8000, 12_000, 18_000, 25_000, 35_000, 50_000];

/**
 * ¿Sigue el texto pegado en la caja de entrada, sin enviar? Las TUIs reemplazan un pegado grande
 * por un marcador ("[Pasted Content 3904 chars]", "[Pasted text #1 +30 lines]") que desaparece
 * de la caja al enviar. Un Enter extra sobre una caja vacía no hace nada. Pura.
 */
export function pasteStillPending(lines: readonly string[]): boolean {
  const input = lines.slice(-6);
  // A borda da caixa de entrada ("│ › [Pasted…]") não é o prompt: sai antes de olhar.
  const prompt = (line: string) => line.replace(/^[\s│┃║|]+/, "");
  return input.some((line) => /\[Pasted (?:Content|text)[^\]]*\]/i.test(line) && /^[›>❯]/.test(prompt(line)));
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

/** Lo que el usuario tiene seleccionado en la terminal de la tab (vacío si nada). */
export function selectionOf(tabId: string): string {
  return terminals.get(tabId)?.getSelection() ?? "";
}
