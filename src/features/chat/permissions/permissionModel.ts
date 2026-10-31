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

/** O comando por dentro: as partes, onde ele escreve e se tem algo que não se sabe interpretar com segurança. */
export interface ShellAnalysis {
  /** As partes de um comando composto (`a && b | c & d`), sem os redirecionamentos e sem as vazias. */
  parts: string[];
  /**
   * Tem um metacaractere que não se interpreta com segurança: crase, `$` (substituição, variável), `<(`, `>(`, heredoc `<<`,
   * barra invertida, aspas vazias ou no meio de uma palavra (`r'm'`). Nunca casa regra e nunca é «só leitura».
   */
  unsafe: boolean;
  /** Os alvos dos redirecionamentos que ESCREVEM (`>`, `>>`, `&>`, `>|`), menos `/dev/null` e os `2>&1`. */
  writes: string[];
}

const UNSAFE_SHELL = /[`$\\]|<\(|>\(|<<|''|""|\w['"]\w/;
const SPLIT_OPERATORS = /\s*(?:&&|\|\||\|&|;|\||&|\r|\n)\s*/;

/** Lê o comando sem executar nada: ver [`ShellAnalysis`]. Pura. */
export function analyzeCommand(command: string): ShellAnalysis {
  const unsafe = UNSAFE_SHELL.test(command);
  const writes: string[] = [];
  const rest = command
    .replace(/\d*>&(?:\d+|-)/g, " ")
    .replace(/(?:&>>?|\d*>>?)\s*\/dev\/null\b/g, " ")
    .replace(/(?:&>>?|>\||\d*>>?)\s*([^\s|&;<>]*)/g, (_m, target: string) => { writes.push(target); return " "; })
    .replace(/<\s*[^\s|&;<>]+/g, " ");
  const parts = rest.split(SPLIT_OPERATORS).map((p) => p.trim()).filter(Boolean);
  return { parts, unsafe, writes };
}

/** As partes de um comando composto, sem as vazias. Pura. */
export function commandParts(command: string): string[] {
  return analyzeCommand(command).parts;
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
  /\b(sudo|doas|pkexec)\b/i,
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

/** O comando acessa a rede? Pura. */
export function isNetworkCommand(command: string): boolean {
  return NETWORK_RE.some((re) => re.test(command));
}

/**
 * Arquivos sensíveis: nunca uma edição de baixo risco, e fora da pasta sobem para alto. Chaves e credenciais,
 * configuração de shell (que roda a cada terminal novo), hooks e workflows de CI, travas de dependência.
 */
const SENSITIVE_RE = /(^|\/)(\.env(\.[\w.-]+)?|\.git\/|\.github\/workflows\/|\.ssh\/|authorized_keys|id_(rsa|ed25519)|\.npmrc|\.netrc|\.aws\/|\.gnupg\/|\.kube\/|\.docker\/config\.json|\.config\/gh\/|\.(zshrc|zshenv|zprofile|bashrc|bash_profile|profile)$|\.claude\/settings|Cargo\.lock$|bun\.lockb?$)/;

function norm(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Um caminho resolvido de forma LÉXICA (sem tocar o disco). */
export interface ResolvedPath {
  /** Provadamente dentro da pasta. Na dúvida, `false`. */
  inside: boolean;
  /** O caminho pôde ser entendido. `false` = tem variável (`$X`, `%X%`), crase ou controle: pode ser qualquer lugar. */
  known: boolean;
  /** Dentro da pasta: o caminho a partir dela, normalizado (`src/a.ts`). Vazio = a própria pasta. */
  rel: string;
  /** O caminho normalizado inteiro (para reconhecer arquivos sensíveis). */
  full: string;
}

const UNKNOWN_PATH = /[$`\0\n\r]|%[^%\s]+%/;

function segmentsOf(path: string): { segs: string[]; escapes: boolean } {
  const segs: string[] = [];
  let escapes = false;
  for (const s of path.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (segs.length > 0) segs.pop();
      else escapes = true;
    } else segs.push(s);
  }
  return { segs, escapes };
}

interface Abs { drive: string; segs: string[] }

function absoluteOf(path: string): Abs | null {
  const p = path.replace(/\\/g, "/");
  const drive = /^([A-Za-z]):(?:\/|$)/.exec(p);
  if (drive) return { drive: drive[1]!.toLowerCase(), segs: segmentsOf(p.slice(2)).segs };
  return p.startsWith("/") ? { drive: "", segs: segmentsOf(p).segs } : null;
}

/**
 * Resolve `path` contra `cwd` por regras só de texto: `.` e `..` resolvidos, `//` e `\\` como `/`, letra do disco do
 * Windows sem diferenciar maiúsculas. Um `..` que sobe acima da pasta é FORA; `~` (home), variáveis e o que não se
 * entende também. Links simbólicos não se enxergam sem o disco: o backend os confere à parte. Pura.
 */
export function resolvePath(path: string, cwd: string | null): ResolvedPath {
  const raw = path.trim();
  if (!raw || UNKNOWN_PATH.test(raw)) return { inside: false, known: false, rel: "", full: raw };
  const p = raw.replace(/\\/g, "/");
  if (p.startsWith("~")) {
    const { segs } = segmentsOf(p.slice(1));
    return { inside: false, known: true, rel: "", full: `~/${segs.join("/")}` };
  }
  const abs = absoluteOf(p);
  if (!abs) {
    const { segs, escapes } = segmentsOf(p);
    const rel = segs.join("/");
    return { inside: !escapes, known: true, rel, full: escapes ? `../${rel}` : rel };
  }
  const full = `${abs.drive ? `${abs.drive}:` : ""}/${abs.segs.join("/")}`;
  const base = cwd ? absoluteOf(cwd.trim()) : null;
  if (!base || base.drive !== abs.drive || abs.segs.length < base.segs.length) return { inside: false, known: true, rel: "", full };
  const same = (a: string, b: string) => (abs.drive ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!base.segs.every((seg, i) => same(seg, abs.segs[i]!))) return { inside: false, known: true, rel: "", full };
  return { inside: true, known: true, rel: abs.segs.slice(base.segs.length).join("/"), full };
}

/** O arquivo está dentro da pasta? Provado por texto; na dúvida, não. Pura. */
export function insideFolder(file: string, cwd: string | null): boolean {
  return resolvePath(file, cwd).inside;
}

/** O risco de um pedido (baixo, médio ou alto). Alto nunca é permitido sozinho por uma regra. Pura. */
export function riskOf(ask: Pick<PendingAsk, "kind" | "detail" | "files" | "cwd">): Risk {
  if (ask.kind === "edit") {
    const files = ask.files.length > 0 ? ask.files : [ask.detail].filter(Boolean);
    const resolved = files.map((f) => resolvePath(f, ask.cwd));
    const outside = resolved.some((r) => !r.inside);
    // O que não se entende (variável, crase) conta como sensível: pode ser qualquer lugar.
    const sensitive = resolved.some((r) => !r.known || SENSITIVE_RE.test(r.full));
    if (sensitive && outside) return "high";
    return outside || sensitive || files.length === 0 ? "medium" : "low";
  }
  if (ask.kind === "network") return "medium";
  return commandRisk(ask.detail.trim(), ask.cwd);
}

/** Sem aspas e sem barra invertida: `r'm' -rf` e `\rm -rf` são `rm -rf` para o shell. */
const dequote = (text: string) => text.replace(/['"\\]/g, "");
const baseName = (word: string) => word.replace(/^.*[\\/]/, "").toLowerCase();
const isFlag = (token: string) => token.startsWith("-");
const words = (part: string) => part.split(/\s+/).filter(Boolean);

/** O caminho cai fora da pasta E é sensível (ou não se entende)? Escrever aí é risco alto. */
function sensitiveOutside(path: string, cwd: string | null): boolean {
  const r = resolvePath(path, cwd);
  return !r.inside && (!r.known || SENSITIVE_RE.test(r.full));
}

const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);

/** O subcomando do git, pulando as opções globais (`git -C x -c k=v push`): `{sub, args, globals}`. Pura. */
function gitCall(tokens: string[]): { sub: string; args: string[]; globals: string[] } {
  const globals: string[] = [];
  let i = 0;
  while (i < tokens.length && isFlag(tokens[i]!)) {
    const option = tokens[i]!;
    globals.push(option);
    i += GIT_VALUE_OPTIONS.has(option) ? 2 : 1;
  }
  return { sub: tokens[i] ?? "", args: tokens.slice(i + 1), globals };
}

const forceFlag = (t: string) => t === "--force" || /^-[A-Za-z]*f[A-Za-z]*$/.test(t);

function gitIsHigh(tokens: string[]): boolean {
  const { sub, args } = gitCall(tokens);
  switch (sub) {
    case "push": case "filter-branch": case "filter-repo": case "rebase": case "update-ref": return true;
    case "reset": return args.includes("--hard");
    case "clean": return args.some(forceFlag);
    case "branch": return args.includes("-D");
    case "checkout": return args.includes("--");
    case "gc": return args.some((a) => a.startsWith("--prune"));
    case "reflog": return args.some((a) => a === "expire" || a === "delete");
    case "stash": return args.some((a) => a === "drop" || a === "clear");
    default: return false;
  }
}

const DANGEROUS_MODE = /^(0?777|0?666|[2467][0-7]{3}|[ugoa]*[+=][rwxXst]*s[rwxXst]*|[ugoa]*\+rwx|a[+=]rwx|o\+w|a\+w)$/;

/** O destino de `sort -o`/`--output`. */
function sortOutputs(args: string[]): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === "-o" || a === "--output") out.push(args[i + 1] ?? "");
    else if (a.startsWith("--output=")) out.push(a.slice("--output=".length));
    else if (/^-o./.test(a)) out.push(a.slice(2));
  });
  return out;
}

/** Uma parte do comando (já sem aspas) é de risco ALTO? Qualquer palavra pode ser o comando: `xargs rm -rf`, `sudo`, `find -exec`. */
function partIsHigh(tokens: string[], cwd: string | null): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const word = baseName(tokens[i]!);
    const rest = tokens.slice(i + 1);
    const operands = rest.filter((t) => !isFlag(t));
    if (word === "rm" && rest.some((t) => t === "--recursive" || t === "--no-preserve-root" || forceFlag(t) || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(t))) return true;
    if ((word === "chmod" || word === "chown" || word === "chgrp") && rest.some((t) => t === "--recursive" || /^-[A-Za-z]*R[A-Za-z]*$/.test(t))) return true;
    if (word === "chmod" && operands.some((t) => DANGEROUS_MODE.test(t))) return true;
    if (word === "git" && gitIsHigh(rest)) return true;
    if (word === "find" && rest.includes("-delete")) return true;
    if (word === "sudo" || word === "doas" || word === "pkexec") return true;
    if (["mv", "cp", "install", "ln", "tee"].includes(word) && operands.some((t) => sensitiveOutside(t, cwd))) return true;
    if (word === "sort" && sortOutputs(rest).some((t) => sensitiveOutside(t, cwd))) return true;
  }
  return false;
}

const noFlags = (...bad: string[]) => (args: string[]) => !args.some((a) => bad.includes(a));

function gitIsReadOnly(tokens: string[]): boolean {
  const { sub, args, globals } = gitCall(tokens);
  // Opção global além de `--no-pager` pode rodar programa (`-c core.pager=…`, `--exec-path`): não é só leitura.
  if (globals.some((g) => g !== "--no-pager" && g !== "-P")) return false;
  if (args.some((a) => a.startsWith("--output"))) return false;
  switch (sub) {
    case "status": case "diff": case "log": case "show": case "rev-parse": case "ls-files": case "blame": case "shortlog": case "describe": return true;
    case "branch": return args.every((a) => ["-a", "-r", "-v", "-vv", "--list", "--all", "--remotes"].includes(a));
    case "remote": return args.length === 1 && args[0] === "-v";
    case "stash": return args[0] === "list";
    default: return false;
  }
}

/**
 * Os comandos que só leem. Lista curta e de propósito: o que roda outro programa (`env x`, `xargs`, `sh -c`, `time`), abre um
 * shell (`less`, `man`), escreve (`sort -o`, `tee`) ou executa código do repositório (`bun run test`, `cargo test|build|clippy`,
 * `vitest`: scripts, `build.rs` e testes do projeto, que o agente acabou de editar) NÃO entra, nem como «baixo risco».
 */
const READ_ONLY: Record<string, (args: string[]) => boolean> = {
  ls: () => true, ll: () => true, cat: () => true, head: () => true, tail: () => true, wc: () => true, pwd: () => true, echo: () => true,
  which: () => true, type: () => true, grep: () => true, stat: () => true, du: () => true, df: () => true, diff: () => true, printenv: () => true,
  rg: noFlags("--pre", "--hostname-bin"),
  date: noFlags("-s", "--set"),
  file: noFlags("-C"),
  tree: noFlags("-o"),
  fd: noFlags("-x", "--exec", "-X", "--exec-batch"),
  env: (args) => args.length === 0,
  find: noFlags("-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"),
  sort: (args) => sortOutputs(args).length === 0 && !args.some((a) => a.startsWith("--compress-program")),
  uniq: (args) => args.filter((a) => !isFlag(a)).length <= 1,
};

function partIsReadOnly(part: string): boolean {
  const tokens = words(dequote(part));
  const head = tokens[0];
  if (!head || /^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) return false;
  const args = tokens.slice(1);
  if (head === "git") return gitIsReadOnly(args);
  if (head === "ags") return ["tab list", "chat list", "chat show", "peer list", "peer inbox"].includes(args.slice(0, 2).join(" "));
  return READ_ONLY[head]?.(args) ?? false;
}

function commandRisk(command: string, cwd: string | null): Risk {
  if (!command) return "medium";
  const analysis = analyzeCommand(command);
  const plain = dequote(command);
  const partsPlain = analyzeCommand(plain).parts;
  const high =
    [command, plain].some((form) => HIGH_RE.some((re) => re.test(form))) ||
    partsPlain.some((part) => partIsHigh(words(part), cwd)) ||
    // Redirecionar para um arquivo sensível fora da pasta (`echo x > ~/.zshrc`).
    analysis.writes.some((target) => sensitiveOutside(dequote(target), cwd));
  if (high) return "high";
  if (analysis.unsafe || analysis.writes.length > 0 || analysis.parts.length === 0) return "medium";
  return analysis.parts.every(partIsReadOnly) ? "low" : "medium";
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
  const r = resolvePath(path, cwd);
  return r.known && r.inside ? r.rel : norm(path);
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
    // Metacaractere que não se interpreta com segurança (`$`, crase, `<(`, heredoc, barra) ou redirecionamento que
    // escreve: a regra não decide, a pessoa decide.
    const analysis = analyzeCommand(ask.detail);
    if (analysis.unsafe || analysis.writes.length > 0) return false;
    const parts = analysis.parts.map((p) => p.replace(/\s+/g, " "));
    const re = commandGlob(rule.pattern);
    return parts.length > 0 && parts.every((p) => re.test(p));
  }
  if (ask.kind === "edit") {
    const files = (ask.files.length > 0 ? ask.files : [ask.detail]).filter(Boolean);
    // Um padrão com `..` não vale; e só casa o que está PROVADAMENTE dentro da pasta, pelo caminho normalizado
    // (`src/../../.ssh/x` não é `src/**`).
    if (rule.pattern.split(/[\\/]/).includes("..")) return false;
    const re = pathGlob(rule.pattern);
    const resolved = files.map((f) => resolvePath(f, ask.cwd));
    return resolved.length > 0 && resolved.every((r) => r.known && r.inside && r.rel !== "" && re.test(r.rel));
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
