/**
 * Detecta um PEDIDO DE PERMISSÃO ativo num TUI de agente (Codex, Claude Code,
 * Gemini/Antigravity) a partir do texto da tela de um terminal.
 *
 * Função pura: não toca em DOM, PTY nem estado global.
 * Entrada típica: `screenOf(tabId, ...)?.lines` (terminalRegistry.ts).
 */

export type PermissionChoiceId = "allow" | "allowSession" | "deny";

export interface PermissionChoice {
  id: PermissionChoiceId;
  label: string;
  /** Sequência a enviar ao PTY (ex.: "1", "2", "\u001b" para Esc). */
  keys: string;
}

export interface PermissionPrompt {
  kind: "command" | "tool" | "edit" | "execution" | "permission";
  /** A pergunta do TUI, ex.: "Would you like to run the following command?" */
  title: string;
  /** Até 6 linhas relevantes (comando, query, razão), limpas e com no máximo 400 chars. */
  detail: string;
  choices: PermissionChoice[];
  /** String estável do prompt, para não notificar duas vezes o mesmo pedido. */
  signature: string;
}

/** Só olhamos as últimas linhas da tela: prompt acima disso não conta. */
const TAIL_LINES = 25;
/** Distância máxima (linhas) entre a pergunta e o menu numerado. */
const QUESTION_WINDOW = 12;
const DETAIL_MAX = 400;
const DETAIL_LINES = 6;
const ESC = "\u001b";

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const CTRL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
/** "› 1. Yes", "❯ 1. Yes", "● 1. Allow once", "  2. Allow for this session" */
const OPTION_RE = /^(?:[›❯●>❱]\s*)?(\d{1,2})[.)]\s+(\S.*)$/;
const EXPLICIT_QUESTION_RE = /^(?:would you like to|do you want to|allow\b)/i;
const HINT_RE = /esc|enter|to (?:submit|confirm|cancel|select)|press|shift\+tab|tab to|↑|↓/i;
const ALLOW_LABEL_RE = /\b(?:yes|allow|proceed|approve|continue|sim|permitir|aprovar)\b/i;
const SESSION_LABEL_RE = /session|don[’']t ask again|sessão|não perguntar/i;
const DENY_LABEL_RE = /^(?:no\b|cancel|deny|negar|não)/i;

interface Option {
  num: number;
  label: string;
  index: number;
}

interface Menu {
  start: number;
  options: Option[];
  end: number;
}

function clean(s: string): string {
  return s.replace(ANSI_RE, "").replace(CTRL_RE, "").replace(/\s+/g, " ").trim();
}

function parseOption(line: string, index: number): Option | null {
  const m = OPTION_RE.exec(clean(line));
  if (!m) return null;
  const label = (m[2] ?? "").replace(/\s*\((?:[a-zA-Z]{1,5}|esc)\)\s*$/, "").trim();
  return { num: Number(m[1]), label, index };
}

/** Só linhas em branco ou dicas de teclado (ex.: "enter to submit | esc to cancel") depois do menu. */
function onlyHintsAfter(lines: string[], from: number): boolean {
  const rest: string[] = [];
  for (let i = from; i < lines.length; i++) {
    const t = clean(lines[i] ?? "");
    if (t) rest.push(t);
  }
  return rest.length <= 2 && rest.every((t) => HINT_RE.test(t));
}

/** Acha o último menu numerado 1..N (consecutivo) que termina perto do fim da janela. */
function findMenu(lines: string[]): Menu | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const first = parseOption(lines[i] ?? "", i);
    if (!first || first.num !== 1) continue;
    const options: Option[] = [first];
    for (let j = i + 1; j < lines.length; j++) {
      const opt = parseOption(lines[j] ?? "", j);
      if (!opt || opt.num !== options.length + 1) break;
      options.push(opt);
    }
    const last = options[options.length - 1];
    if (!last) continue;
    if (!onlyHintsAfter(lines, last.index + 1)) continue;
    return { start: i, options, end: last.index };
  }
  return null;
}

/** Pergunta do TUI: primeiro uma linha que começa com a frase típica, senão uma que termina em "?". */
function findQuestion(lines: string[], menuStart: number): number {
  const from = Math.max(0, menuStart - QUESTION_WINDOW);
  for (let i = menuStart - 1; i >= from; i--) {
    if (EXPLICIT_QUESTION_RE.test(clean(lines[i] ?? ""))) return i;
  }
  for (let i = menuStart - 1; i >= from; i--) {
    if (/\?$/.test(clean(lines[i] ?? ""))) return i;
  }
  return -1;
}

function kindOf(question: string): PermissionPrompt["kind"] {
  if (/allow execution/i.test(question)) return "execution";
  if (/\bedit\b/i.test(question)) return "edit";
  if (/\btool\b/i.test(question)) return "tool";
  if (/\bcommand\b/i.test(question)) return "command";
  return "permission";
}

function detailOf(lines: string[], from: number, to: number): string {
  const out: string[] = [];
  for (let i = from; i < to && out.length < DETAIL_LINES; i++) {
    const t = clean(lines[i] ?? "")
      .replace(/^[│|]\s*/, "")
      .replace(/\s*[│|]$/, "")
      .trim();
    if (!t || /^field \d+\/\d+$/i.test(t)) continue;
    out.push(t);
  }
  const s = out.join("\n");
  return s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX - 1)}…` : s;
}

/**
 * Devolve o pedido de permissão ativo na tela, ou null.
 * `lines` é a tela do terminal (uma string por linha, da mais antiga à mais recente).
 */
export function detectPermissionPrompt(lines: readonly string[] | null | undefined): PermissionPrompt | null {
  if (!lines || lines.length === 0) return null;
  const window = lines.slice(Math.max(0, lines.length - TAIL_LINES));

  const menu = findMenu(window);
  if (!menu) return null;
  const { options } = menu;
  const first = options[0];
  if (!first || !ALLOW_LABEL_RE.test(first.label)) return null;

  const q = findQuestion(window, menu.start);
  if (q < 0) return null;
  const title = clean(window[q] ?? "").slice(0, 200);

  const choices: PermissionChoice[] = [{ id: "allow", label: first.label, keys: "1" }];
  const session = options.find((o) => o.num !== 1 && SESSION_LABEL_RE.test(o.label));
  if (session) choices.push({ id: "allowSession", label: session.label, keys: String(session.num) });
  const deny = options.find((o) => DENY_LABEL_RE.test(o.label));
  choices.push({ id: "deny", label: deny ? deny.label : "Negar", keys: ESC });

  const detail = detailOf(window, q + 1, menu.start);
  const kind = kindOf(title);
  const signature = [kind, title, choices.map((c) => c.label).join("|"), detail]
    .join("\u0001")
    .toLowerCase();

  return { kind, title, detail, choices, signature };
}
