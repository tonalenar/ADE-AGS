/**
 * Os pedidos de permissão de todos os agentes num formato só (prancheta 14): as aprovações das
 * conversas por protocolo, os diálogos das TUIs e as aprovações da frota. Aqui ficam as regras
 * puras: o tipo do pedido, o risco, o que ele mexe, o padrão do "Sempre permitir" e o casamento
 * com as regras guardadas. Nada aqui toca store, IPC ou DOM.
 */

export type AskSource = "thread" | "tui" | "fleet";
/** Comando, edição de arquivos ou acesso à rede (uma ferramenta web; um comando que baixa algo segue comando, com `network`). */
export type AskKind = "command" | "edit" | "network";
export type Risk = "low" | "medium" | "high";
export type AskFilter = "all" | "command" | "edit";

/** Como responder: o pedido de uma conversa por protocolo, o diálogo de uma TUI ou a aprovação da frota. */
export type AskRef =
  | { source: "thread"; threadId: string; requestId: string }
  | { source: "tui"; tabId: string; signature: string }
  | { source: "fleet"; approvalId: string };

export interface PendingAsk {
  /** Estável enquanto o pedido existe (`thread:<pedido>`, `tui:<aba>:<assinatura>`, `fleet:<id>`). */
  id: string;
  ref: AskRef;
  agentId: string;
  agentLabel: string;
  /** A chave do cartão da conversa (a aba, ou `thread:<id>`); `null` = sem conversa (frota). */
  conversation: string | null;
  /** O nome da conversa ou da tarefa ("ChatView + Composer"). */
  where: string;
  kind: AskKind;
  /** O comando inteiro (comando), os arquivos (edição) ou o endereço (rede). */
  detail: string;
  /** Os arquivos que o pedido mexe, quando se sabe. */
  files: string[];
  /** O comando acessa a rede (instalar, baixar, `git push`…). */
  network: boolean;
  cwd: string | null;
  risk: Risk;
  /** A TUI oferece "permitir nesta sessão" / a conversa aceita `allowSession`. */
  canSession: boolean;
  atMs: number;
}

const OPERATORS = /\s*(?:&&|\|\||;|\|)\s*/;

/** As partes de um comando composto (`a && b | c`), sem as vazias. Pura. */
export function commandParts(command: string): string[] {
  return command.split("\n").flatMap((line) => line.split(OPERATORS)).map((p) => p.trim()).filter(Boolean);
}

const NETWORK_RE = [
  /\b(curl|wget|ssh|scp|rsync|ftp|nc)\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(add|install|i|update|upgrade|publish|x|dlx|create)\b/i,
  /\b(npx|bunx|pnpx)\s+\S/i,
  /\bpip3?\s+(install|download)\b/i,
  /\buv\s+(add|pip|sync)\b/i,
  /\bcargo\s+(add|install|update|fetch|publish)\b/i,
  /\bgit\s+(fetch|pull|push|clone|submodule)\b/i,
  /\bgh\s+\S/i,
  /\b(brew|apt|apt-get|dnf|pacman)\s+(install|upgrade|update)\b/i,
  /\bgo\s+(get|install)\b/i,
  /\bdocker\s+(pull|push|run)\b/i,
];

const HIGH_RE = [
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-\w*f/i,
  /\bgit\s+(rebase|filter-branch)\b/i,
  /\bgit\s+branch\s+-D\b/,
  /\bgit\s+checkout\s+--\s/i,
  /\brm\s+(-\w*\s+)*-\w*[rR]\w*\b/,
  /\bsudo\b/i,
  /\b(chmod|chown)\s+-R\b/i,
  /\b(mkfs|dd|shutdown|reboot|diskutil)\b/i,
  /\b(kill|killall|pkill|taskkill)\b/i,
  /\b(npm|pnpm|yarn|bun|cargo)\s+publish\b/i,
  /\bgh\s+(pr\s+merge|release|repo\s+delete)\b/i,
  /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh|pwsh)\b/i,
  /\bdrop\s+(table|database)\b/i,
  /--force\b|--no-verify\b/i,
  />\s*\/(etc|usr|bin|System)\//,
];

const READ_ONLY_RE = [
  /^(ls|ll|cat|head|tail|wc|pwd|echo|which|type|rg|grep|find|fd|tree|stat|file|du|df|less|sort|uniq|diff|date|env|printenv)\b/i,
  /^git\s+(status|diff|log|show|branch|rev-parse|ls-files|blame|remote\s+-v|stash\s+list)\b/i,
  /^(bun|npm|pnpm|yarn)\s+(run\s+)?(test|lint|typecheck|check[:\w-]*|tsc)\b/i,
  /^(bunx|npx)\s+(tsc|vitest|eslint|prettier\s+--check)\b/i,
  /^cargo\s+(test|check|clippy|build|fmt\s+--check|tree|metadata)\b/i,
  /^(tsc|vitest|jest|pytest|go\s+(test|vet|build))\b/i,
  /^ags\s+(test|tab\s+list|chat\s+(list|show)|peer\s+(list|inbox))\b/i,
];

/** O comando acessa a rede? Pura. */
export function isNetworkCommand(command: string): boolean {
  return NETWORK_RE.some((re) => re.test(command));
}

/** Arquivos sensíveis: nunca uma edição de baixo risco, e fora da pasta sobem para alto. */
const SENSITIVE_RE = /(^|\/)(\.env(\.[\w.-]+)?|\.git\/|\.github\/workflows\/|\.ssh\/|id_(rsa|ed25519)|\.npmrc|\.netrc|\.aws\/|\.claude\/settings|Cargo\.lock$|bun\.lockb?$)/;

function norm(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** O arquivo está dentro da pasta? Caminhos relativos contam como de dentro. Pura. */
export function insideFolder(file: string, cwd: string | null): boolean {
  const f = norm(file);
  if (!/^(\/|~|[A-Za-z]:\/)/.test(f)) return !f.startsWith("../");
  if (!cwd) return false;
  const base = norm(cwd);
  return f === base || f.startsWith(`${base}/`);
}

/** O risco de um pedido (baixo, médio ou alto). Alto nunca é permitido sozinho por uma regra. Pura. */
export function riskOf(ask: Pick<PendingAsk, "kind" | "detail" | "files" | "cwd">): Risk {
  if (ask.kind === "edit") {
    const files = ask.files.length > 0 ? ask.files : [ask.detail].filter(Boolean);
    const outside = files.some((f) => !insideFolder(f, ask.cwd));
    const sensitive = files.some((f) => SENSITIVE_RE.test(norm(f)));
    if (sensitive && outside) return "high";
    return outside || sensitive || files.length === 0 ? "medium" : "low";
  }
  if (ask.kind === "network") return "medium";
  const command = ask.detail.trim();
  if (!command) return "medium";
  if (HIGH_RE.some((re) => re.test(command))) return "high";
  if (/[`]|\$\(/.test(command)) return "medium";
  const parts = commandParts(command);
  if (parts.length > 0 && parts.every((p) => READ_ONLY_RE.some((re) => re.test(p)))) return "low";
  return "medium";
}

/** O que um comando mexe, quando dá para saber pelo próprio comando (instalar uma dependência). Pura. */
export function touchesOf(command: string): string[] {
  const c = command.trim();
  if (/^bun\s+(add|install|i|remove|rm)\b/i.test(c)) return ["package.json", "bun.lock"];
  if (/^npm\s+(add|install|i|uninstall)\b/i.test(c)) return ["package.json", "package-lock.json"];
  if (/^pnpm\s+(add|install|i|remove)\b/i.test(c)) return ["package.json", "pnpm-lock.yaml"];
  if (/^yarn\s+(add|install|remove)\b/i.test(c)) return ["package.json", "yarn.lock"];
  if (/^cargo\s+(add|remove|update)\b/i.test(c)) return ["Cargo.toml", "Cargo.lock"];
  if (/^uv\s+(add|remove)\b/i.test(c)) return ["pyproject.toml", "uv.lock"];
  const redirect = c.match(/>{1,2}\s*([^\s|&;]+)/);
  return redirect ? [redirect[1]!] : [];
}

/** Programas cujo segundo termo também faz parte do padrão (`bun add *`, `git push *`). */
const TWO_WORD = new Set(["git", "bun", "npm", "pnpm", "yarn", "cargo", "gh", "docker", "pip", "pip3", "uv", "go", "make", "ags", "bunx", "npx", "kubectl", "brew"]);

function relative(path: string, cwd: string | null): string {
  const f = norm(path);
  if (cwd) {
    const base = norm(cwd);
    if (f.startsWith(`${base}/`)) return f.slice(base.length + 1);
  }
  return f;
}

/** A pasta comum de vários caminhos (`src/a/x.ts`, `src/a/b/y.ts` → `src/a`). */
function commonDir(paths: string[]): string {
  const dirs = paths.map((p) => p.split("/").slice(0, -1));
  if (dirs.length === 0) return "";
  const first = dirs[0]!;
  let n = first.length;
  for (const d of dirs) {
    let i = 0;
    while (i < n && d[i] === first[i]) i++;
    n = i;
  }
  return first.slice(0, n).join("/");
}

/** O host de um endereço (`https://docs.rs/x` → `docs.rs`); `null` se não for um. */
function hostOf(url: string): string | null {
  try {
    return new URL(url.trim()).host || null;
  } catch {
    return null;
  }
}

/**
 * O padrão do "Sempre permitir <padrão>": para comando, o programa (e o subcomando dos que têm um)
 * mais `*` (`bun add *`); para edição, a pasta dos arquivos mais `**` (`src/features/chat/**`); para
 * rede, o host (`docs.rs/*`). `null` = não há padrão seguro a oferecer. Pura.
 */
export function suggestPattern(ask: Pick<PendingAsk, "kind" | "detail" | "files" | "cwd">): string | null {
  if (ask.kind === "edit") {
    const files = (ask.files.length > 0 ? ask.files : [ask.detail]).filter(Boolean).map((f) => relative(f, ask.cwd));
    if (files.length === 0) return null;
    const dir = commonDir(files);
    return dir ? `${dir}/**` : files.length === 1 ? files[0]! : "*";
  }
  if (ask.kind === "network") {
    const host = hostOf(ask.detail);
    return host ? `${host}/**` : null;
  }
  const first = commandParts(ask.detail)[0];
  if (!first) return null;
  const words = first.split(/\s+/);
  const program = words[0]!;
  const sub = words[1];
  if (TWO_WORD.has(program) && sub && !sub.startsWith("-")) return `${program} ${sub} *`;
  return `${program} *`;
}

/** Uma regra "Sempre permitir": guardada nos settings (`chat.permissions.rules`). */
export interface PermissionRule {
  id: string;
  kind: AskKind;
  pattern: string;
  /** `null` = vale para qualquer agente. */
  agentId: string | null;
  createdAt: number;
}

export const RULES_KEY = "chat.permissions.rules";

/** As regras guardadas, tolerando lixo (versões futuras, texto quebrado). Pura. */
export function parseRules(raw: string | null | undefined): PermissionRule[] {
  if (!raw) return [];
  try {
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.flatMap((r): PermissionRule[] => {
      if (!r || typeof r !== "object") return [];
      const o = r as Record<string, unknown>;
      const kind = o.kind === "command" || o.kind === "edit" || o.kind === "network" ? o.kind : null;
      if (!kind || typeof o.pattern !== "string" || !o.pattern.trim() || typeof o.id !== "string") return [];
      return [{ id: o.id, kind, pattern: o.pattern.trim(), agentId: typeof o.agentId === "string" ? o.agentId : null, createdAt: typeof o.createdAt === "number" ? o.createdAt : 0 }];
    });
  } catch {
    return [];
  }
}

function escape(text: string): string {
  return text.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
}

/** Um padrão de comando em regex: `*` casa com qualquer coisa (espaços inclusive). */
function commandGlob(pattern: string): RegExp {
  const body = pattern.trim().replace(/\s+/g, " ").split("*").map(escape).join(".*");
  // `bun add *` casa também com `bun add` sozinho.
  return new RegExp(`^${body.replace(/ \.\*$/, "(?: .*)?")}$`, "i");
}

/** Um padrão de caminho em regex: `**` atravessa pastas, `*` não. */
function pathGlob(pattern: string): RegExp {
  const body = norm(pattern).split("**").map((part) => part.split("*").map(escape).join("[^/]*")).join(".*");
  return new RegExp(`^${body}$`);
}

/** A regra casa com o pedido? Comando composto só casa se TODAS as partes casarem. Pura. */
export function ruleMatches(rule: PermissionRule, ask: Pick<PendingAsk, "kind" | "detail" | "files" | "cwd" | "agentId">): boolean {
  if (rule.agentId && rule.agentId !== ask.agentId) return false;
  if (rule.kind !== ask.kind) return false;
  if (ask.kind === "command") {
    if (/[`]|\$\(/.test(ask.detail)) return false;
    const parts = commandParts(ask.detail).map((p) => p.replace(/\s+/g, " "));
    const re = commandGlob(rule.pattern);
    return parts.length > 0 && parts.every((p) => re.test(p));
  }
  if (ask.kind === "edit") {
    const files = (ask.files.length > 0 ? ask.files : [ask.detail]).filter(Boolean);
    const re = pathGlob(rule.pattern);
    return files.length > 0 && files.every((f) => re.test(relative(f, ask.cwd)));
  }
  const host = hostOf(ask.detail);
  const target = host ? `${host}${new URL(ask.detail.trim()).pathname}` : ask.detail.trim();
  return pathGlob(rule.pattern).test(target);
}

/**
 * A regra que permite este pedido sozinho, ou `null`. Risco alto nunca: a pessoa decide. Pura.
 */
export function autoAllowRule(rules: PermissionRule[], ask: PendingAsk): PermissionRule | null {
  if (ask.risk === "high") return null;
  return rules.find((r) => ruleMatches(r, ask)) ?? null;
}

/**
 * Quem decide sozinho um pedido: o pedido de uma conversa por protocolo é decidido pelo BACKEND (política do time e
 * regras da pessoa, `conversa::permission`), com a janela aberta ou não; o React só mostra o que sobrou e deixa a
 * pessoa decidir. Os diálogos das TUIs e as aprovações da frota continuam decididos aqui (não passam pelo backend). Pura.
 */
export function decidedByBackend(ask: Pick<PendingAsk, "ref">): boolean {
  return ask.ref.source === "thread";
}

/** Os pedidos de um filtro da caixa: Comandos inclui os de rede (a rede é feita por comando ou ferramenta). Pura. */
export function filterAsks(asks: PendingAsk[], filter: AskFilter): PendingAsk[] {
  if (filter === "all") return asks;
  if (filter === "edit") return asks.filter((a) => a.kind === "edit");
  return asks.filter((a) => a.kind !== "edit");
}

/** As contagens do segmentado ("Todos 3", "Comandos 2", "Edições 1"). Pura. */
export function askCounts(asks: PendingAsk[]): Record<AskFilter, number> {
  return { all: asks.length, command: filterAsks(asks, "command").length, edit: filterAsks(asks, "edit").length };
}

/** Quantas conversas (ou tarefas) estão esperando a pessoa: o "N agentes esperando você". Pura. */
export function waitingAgents(asks: PendingAsk[]): number {
  return new Set(asks.map((a) => a.conversation ?? a.id)).size;
}

/** O pedido J/K a partir do atual, dando a volta nas pontas. Pura. */
export function stepSelection(ids: string[], current: string | null, delta: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const at = current ? ids.indexOf(current) : -1;
  if (at < 0) return delta > 0 ? ids[0]! : ids[ids.length - 1]!;
  return ids[(at + delta + ids.length) % ids.length]!;
}

/** O mais antigo primeiro: é o que está parado há mais tempo. Pura. */
export function sortAsks(asks: PendingAsk[]): PendingAsk[] {
  return [...asks].sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
}

/** Os pedidos que apareceram desde a última vez (para a notificação e as regras). Pura. */
export function freshAsks(seen: ReadonlySet<string>, asks: PendingAsk[]): PendingAsk[] {
  return asks.filter((a) => !seen.has(a.id));
}

/** A pasta encurtada para a linha "em ~/Projects/ADE-AGS". `home` sem barra no fim. Pura. */
export function shortFolder(cwd: string, home: string | null): string {
  const c = norm(cwd);
  const h = home ? norm(home) : null;
  if (h && (c === h || c.startsWith(`${h}/`))) return `~${c.slice(h.length)}`;
  return c;
}

/** O tipo de um pedido a partir da ferramenta (Claude/frota) e do texto. Pura. */
export function kindOfTool(tool: string | null | undefined, fallback: AskKind): AskKind {
  if (!tool) return fallback;
  if (/^(Edit|MultiEdit|Write|NotebookEdit|apply_patch)$/.test(tool)) return "edit";
  if (/^(WebFetch|WebSearch|web_search)$/.test(tool)) return "network";
  return fallback;
}

/** O tipo de um diálogo de TUI (`terminalPrompts`): edição, rede (busca/URL) ou comando. Pura. */
export function kindOfPrompt(kind: string, detail: string): AskKind {
  if (kind === "edit") return "edit";
  if (/^https?:\/\//m.test(detail) && !isNetworkCommand(detail)) return "network";
  return "command";
}
