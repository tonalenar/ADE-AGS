/** Gramática segura para as condições `when` dos atalhos, sem avaliar JavaScript. */

export const SHORTCUT_WHEN_CONTEXTS = [
  "terminalFocus",
  "terminalOpen",
  "terminalSplitAvailable",
  "terminalToggleAvailable",
  "workspaceAgentAvailable",
  "previewFocus",
  "diffFocus",
  "previewOpen",
  "rightPanelOpen",
  "chatShell",
  "workspaceShell",
  "projectSearchOpen",
  "filePickerAvailable",
  "promptStashAvailable",
  "composerAlternateAvailable",
  "composerBackgroundAvailable",
  "composerSendAndNewThreadAvailable",
  "conversationTimelineOpen",
  "commandPaletteOpen",
  "modelPickerOpen",
  "threadPinAvailable",
  "pullRequestOpen",
  "usagePageOpen",
  "composerFocus",
  "composerDraft",
  "draftThreadRoute",
  "turnRunning",
  "editableFocus",
  "isWeb",
  "isDesktop",
] as const;

export type ShortcutWhenContext = typeof SHORTCUT_WHEN_CONTEXTS[number];
export type ShortcutWhenValues = Record<ShortcutWhenContext, boolean>;
export type ShortcutWhenError = "syntax" | "unknownContext";
export type ShortcutWhenValidation = { ok: true; value: string } | { ok: false; error: ShortcutWhenError };

type Token = { kind: "name"; value: string } | { kind: "operator"; value: "!" | "&&" | "||" | "(" | ")" };
type Expression =
  | { kind: "name"; value: ShortcutWhenContext }
  | { kind: "not"; value: Expression }
  | { kind: "and" | "or"; left: Expression; right: Expression };

const CONTEXTS = new Set<string>(SHORTCUT_WHEN_CONTEXTS);
const MAX_EXPRESSION_LENGTH = 256;
const MAX_TOKENS = 64;

function tokenize(source: string): Token[] | ShortcutWhenError {
  if (source.length > MAX_EXPRESSION_LENGTH) return "syntax";
  const tokens: Token[] = [];
  for (let at = 0; at < source.length;) {
    const char = source[at]!;
    if (/\s/.test(char)) { at += 1; continue; }
    if (char === "!" || char === "(") { tokens.push({ kind: "operator", value: char }); at += 1; continue; }
    if (char === ")") { tokens.push({ kind: "operator", value: char }); at += 1; continue; }
    const pair = source.slice(at, at + 2);
    if (pair === "&&" || pair === "||") { tokens.push({ kind: "operator", value: pair }); at += 2; continue; }
    const name = /^[A-Za-z][A-Za-z0-9]*/.exec(source.slice(at));
    if (!name) return "syntax";
    tokens.push({ kind: "name", value: name[0] });
    at += name[0].length;
    if (tokens.length > MAX_TOKENS) return "syntax";
  }
  return tokens;
}

/** Faz parse com precedência `!`, `&&`, `||`; um contexto desconhecido nunca é aceito. */
function parse(source: string): Expression | ShortcutWhenError | null {
  const tokens = tokenize(source);
  if (!Array.isArray(tokens)) return tokens;
  if (tokens.length === 0) return null;
  let at = 0;
  let error: ShortcutWhenError | null = null;

  const parseOr = (): Expression | null => {
    let left = parseAnd();
    while (tokens[at]?.kind === "operator" && tokens[at]?.value === "||") {
      at += 1;
      const right = parseAnd();
      if (!left || !right) { error ??= "syntax"; return null; }
      left = { kind: "or", left, right };
    }
    return left;
  };

  const parseAnd = (): Expression | null => {
    let left = parseUnary();
    while (tokens[at]?.kind === "operator" && tokens[at]?.value === "&&") {
      at += 1;
      const right = parseUnary();
      if (!left || !right) { error ??= "syntax"; return null; }
      left = { kind: "and", left, right };
    }
    return left;
  };

  const parseUnary = (): Expression | null => {
    const token = tokens[at];
    if (!token) { error ??= "syntax"; return null; }
    if (token.kind === "operator" && token.value === "!") {
      at += 1;
      const value = parseUnary();
      if (!value) { error ??= "syntax"; return null; }
      return { kind: "not", value };
    }
    if (token.kind === "operator" && token.value === "(") {
      at += 1;
      const value = parseOr();
      if (!value || tokens[at]?.kind !== "operator" || tokens[at]?.value !== ")") {
        error ??= "syntax";
        return null;
      }
      at += 1;
      return value;
    }
    if (token.kind !== "name") { error ??= "syntax"; return null; }
    at += 1;
    if (!CONTEXTS.has(token.value)) { error ??= "unknownContext"; return null; }
    return { kind: "name", value: token.value as ShortcutWhenContext };
  };

  const expression = parseOr();
  if (error) return error;
  return expression && at === tokens.length ? expression : "syntax";
}

function evaluate(expression: Expression, values: ShortcutWhenValues): boolean {
  switch (expression.kind) {
    case "name": return values[expression.value];
    case "not": return !evaluate(expression.value, values);
    case "and": return evaluate(expression.left, values) && evaluate(expression.right, values);
    case "or": return evaluate(expression.left, values) || evaluate(expression.right, values);
  }
}

export function validateShortcutWhen(source: string): ShortcutWhenValidation {
  const value = source.trim();
  if (!value) return { ok: true, value: "" };
  const expression = parse(value);
  return typeof expression === "string" ? { ok: false, error: expression } : { ok: true, value };
}

/** Condições inválidas (por exemplo, dados antigos editados fora da ADE) não disparam atalhos. */
export function matchesShortcutWhen(source: string | undefined, values: ShortcutWhenValues): boolean {
  if (!source?.trim()) return true;
  const expression = parse(source.trim());
  return !!expression && typeof expression !== "string" && evaluate(expression, values);
}

/** Diz se duas condições podem ser verdadeiras ao mesmo tempo. A checagem exata só enumera
 *  os contextos citados pelas duas expressões, sem percorrer estados que não influenciam o resultado. */
export function shortcutWhensOverlap(left: string | undefined, right: string | undefined): boolean {
  const a = left?.trim() ? parse(left.trim()) : null;
  const b = right?.trim() ? parse(right.trim()) : null;
  if ((typeof a === "string") || (typeof b === "string")) return false;
  if (!a || !b) return true;

  const used = new Set<ShortcutWhenContext>();
  const collect = (expression: Expression) => {
    if (expression.kind === "name") used.add(expression.value);
    else if (expression.kind === "not") collect(expression.value);
    else { collect(expression.left); collect(expression.right); }
  };
  collect(a);
  collect(b);
  const contexts = SHORTCUT_WHEN_CONTEXTS.filter((context) => used.has(context));
  const values = {} as ShortcutWhenValues;
  for (const context of SHORTCUT_WHEN_CONTEXTS) values[context] = false;
  const combinations = 2 ** contexts.length;
  for (let mask = 0; mask < combinations; mask += 1) {
    contexts.forEach((context, index) => {
      values[context] = (mask & (1 << index)) !== 0;
    });
    if (evaluate(a, values) && evaluate(b, values)) return true;
  }
  return false;
}
