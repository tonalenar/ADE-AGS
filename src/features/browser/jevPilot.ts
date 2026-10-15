/**
 * O piloto do navegador: `ags portal act <portal> "objetivo"`.
 *
 * Um agente que navega com `snapshot` + `click` gasta um turno de um modelo grande por clique: ler a árvore da
 * página inteira, pensar, tocar, repetir. Quase todo clique é uma ESCOLHA entre elementos ("qual destes leva ao
 * objetivo?"), e é para isso que serve o Jev (decisões tipadas, centenas de milissegundos). O desenho vem do
 * `browser-use/jev-ultrafast` (MIT): operação + elemento numa só consulta.
 *
 * O laço, a cada passo:
 *
 *   1. `snapshot` da página → elementos tocáveis (cada um com seu ref, seu estado e se está preenchido);
 *   2. os campos cujo nome casa com um `--fill` são preenchidos direto, sem o Jev (digitar o nome em "Customer
 *      name" não é uma escolha);
 *   3. UMA consulta ao Jev leva a pergunta da OPERAÇÃO (clicar, digitar, escolher numa lista, rolar, esperar,
 *      concluir…) e uma de ALVO por operação que precisa de um elemento; só vale o alvo da operação escolhida;
 *   4. abaixo da probabilidade mínima, PARA e devolve a página ao agente;
 *   5. a escolha vira uma ação (`click`, `type` com o valor de `--fill`, `select`, `scroll`).
 *
 * O Jev só escolhe ONDE tocar. O texto digitado vem sempre de `--fill` (campo=valor) — nunca vai ao provedor, só
 * os nomes dos campos e se estão preenchidos — e quem pediu confere o resultado na página que volta no fim.
 *
 * Tudo aqui é puro (a página, o Jev e as ações entram por `PilotDeps`), então o laço é testável sem navegador.
 */

export interface PageElement {
  ref: string;
  role: string;
  name: string;
  states: string[];
  /** Só nos campos: tem valor? (O valor em si nunca é lido.) `null` = não é um campo com valor. */
  filled: boolean | null;
  /** Só nos links: para onde vão, sem consulta nem fragmento (`/cart.html`). Diz o que um ícone sem nome é. */
  href?: string;
  /** Só nas listas nativas: o que se pode escolher. Cada opção vira um alvo (`e12_3` = a 4ª opção do elemento e12). */
  options?: string[];
}

export interface ParsedPage {
  title: string;
  url: string;
  elements: PageElement[];
  /** O texto visível, em linhas curtas, na ordem da página. */
  text: string[];
  /** O tamanho da janela da página em px CSS (do cabeçalho do snapshot): converte as frações de uma foto em pontos. */
  viewport?: { width: number; height: number };
}

const NODE = /^\s*- (\S+)(?: ("(?:[^"\\]|\\.)*"))?(.*)$/;
const REF = /\[ref=(e\d+)\]/;
const STATE = /\[([^\]=]+)\]/g;
const HEADER = /^page: (?:("(?:[^"\\]|\\.)*") )?(\S+)/;
const VIEWPORT = /^viewport: (\d+)×(\d+)/;
const VALUE = / value=("(?:[^"\\]|\\.)*")/;
const OPTIONS = / options=(\[.*\])\s*$/;

function unquote(raw: string | undefined): string {
  if (!raw) return "";
  try { return JSON.parse(raw) as string; } catch { return raw.slice(1, -1); }
}

/** Lê o texto do `snapshot` (ver `page/snapshotFormat.ts`) de volta em elementos e texto. Pura. */
export function parseSnapshot(snapshot: string): ParsedPage {
  const page: ParsedPage = { title: "", url: "", elements: [], text: [] };
  for (const line of snapshot.split("\n")) {
    const header = HEADER.exec(line);
    if (header && !page.url) {
      page.title = unquote(header[1]);
      page.url = header[2];
      continue;
    }
    const size = VIEWPORT.exec(line);
    if (size && !page.viewport) {
      page.viewport = { width: Number(size[1]), height: Number(size[2]) };
      continue;
    }
    const node = NODE.exec(line);
    if (!node) continue;
    const [, role, quoted, rest] = node;
    const name = unquote(quoted);
    const ref = REF.exec(rest)?.[1];
    if (ref) {
      // O valor e o destino de um link vêm depois dos estados: cortá-los evita ler um `[` de dentro de um valor.
      const flags = rest.replace(REF, "").split(" value=")[0].split(" → ")[0];
      const states = [...flags.matchAll(STATE)].map((m) => m[1]);
      const value = VALUE.exec(rest);
      const target = rest.split(" → ")[1]?.trim().split(/[?#]/)[0].slice(0, 80);
      let options: string[] | undefined;
      const listed = OPTIONS.exec(rest);
      if (listed) {
        try {
          const parsed: unknown = JSON.parse(listed[1]);
          if (Array.isArray(parsed)) options = parsed.filter((o): o is string => typeof o === "string");
        } catch { /* sem opções legíveis: a lista fica como um elemento só */ }
      }
      page.elements.push({
        ref, role, name, states, filled: value ? unquote(value[1]).length > 0 : null,
        ...(target ? { href: target } : {}),
        ...(options?.length ? { options } : {}),
      });
    } else if (role === "text" && name) {
      page.text.push(name);
    }
  }
  return page;
}

// ── Operações e elementos ───────────────────────────────────────────

export interface StepOption {
  id: string;
  label: string;
}

/** O que o `decision_pick_step` recebe: o estado, as operações e os elementos de cada uma. */
export interface StepQuery {
  state: string;
  operations: StepOption[];
  targets: Record<string, StepOption[]>;
}

const ROLE_LABEL: Record<string, string> = {
  button: "button", link: "link", textbox: "text field", searchbox: "search field", textarea: "text area",
  combobox: "dropdown", listbox: "list", checkbox: "checkbox", radio: "radio option", switch: "switch",
  tab: "tab", menuitem: "menu item", option: "option", clickable: "clickable element", slider: "slider", spinbutton: "number field",
};

const TYPING = new Set(["textbox", "searchbox", "textarea", "spinbutton"]);
const CHOOSING = new Set(["combobox", "listbox"]);

type Operation = "click" | "type" | "select";

function operationOf(el: PageElement): Operation {
  if (TYPING.has(el.role)) return "type";
  if (CHOOSING.has(el.role)) return "select";
  return "click";
}

/** Quantos elementos entram em cada pergunta de alvo. O Jev acertou 15 de 15 até 80 opções; fica folga. */
export const MAX_PER_HEAD = 100;

const OPERATION_LABEL: Record<string, string> = {
  click: "Click an element, button, menu option, autocomplete suggestion, radio or calendar day.",
  type: "Enter or replace text in an editable field. The caller supplies the value.",
  select: "Choose a value in a dropdown.",
  scroll: "Scroll down to reveal more of the page.",
  wait: "Wait: the needed control is absent or the results are still loading.",
  done: "Every requirement of the goal is visibly satisfied on the page.",
  stuck: "No offered operation can make progress.",
};

/** Palavras que servem para comparar: minúsculas, sem acento, só as de 3+ letras. Pura. */
export function words(text: string): Set<string> {
  const flat = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return new Set(flat.split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

/** Sem acento, sem pontuação nem espaço: "E-mail" e "email" ficam iguais. */
function squash(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** O quanto dois nomes se parecem: palavras em comum, e um contendo o outro quando juntos ("E-mail" ⊇ "email"). */
function similarity(a: string, b: string): number {
  const x = squash(a);
  const y = squash(b);
  const contains = x.length >= 3 && y.length >= 3 && (x.includes(y) || y.includes(x)) ? 2 : 0;
  return overlap(words(a), words(b)) + contains;
}

/** O que já foi feito neste laço, para o Jev não repetir e ver se a página mudou. */
export interface Done {
  /** "clicou button "Entrar"" — nunca o valor digitado. */
  what: string;
  /** A página mudou depois da ação? `null` = ainda não se sabe. */
  changed: boolean | null;
  /** Foi um campo preenchido pelo nome (sem o Jev), não uma escolha dele. */
  auto?: boolean;
}

/** O que o Jev lê de um elemento: o papel, o nome e o estado (marcado, expandido, preenchido), nunca o valor. */
function labelOf(el: PageElement): string {
  const role = ROLE_LABEL[el.role] ?? el.role;
  const marks = [
    el.states.includes("checked") ? "checked" : null,
    el.states.includes("expanded") ? "expanded" : null,
    el.states.includes("selected") ? "selected" : null,
    el.states.includes("pressed") ? "pressed" : null,
    el.filled === null ? null : el.filled ? "filled" : "empty",
  ].filter((mark): mark is string => mark !== null);
  // Um link mostra para onde vai: é o que identifica o ícone do carrinho, que não tem nome.
  const where = el.href ? ` → ${el.href}` : "";
  return `${role}${el.name ? ` "${el.name}"` : ""}${where}${marks.length > 0 ? ` (${marks.join(", ")})` : ""}`;
}

/** O elemento como se conta o que se fez: o papel e o nome, sem o estado de antes da ação. */
function plain(el: PageElement): string {
  return `${ROLE_LABEL[el.role] ?? el.role}${el.name ? ` "${el.name}"` : ""}`;
}

/** O endereço sem consulta nem fragmento: é onde costumam ir tokens e códigos. Pura. */
export function bareUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

/** Uma impressão da página: muda quando muda o endereço, os elementos ou o texto. Serve para saber se uma ação teve efeito. Pura. */
export function fingerprint(page: ParsedPage): string {
  const body = `${bareUrl(page.url)}|${page.elements.map((e) => `${e.role}:${e.name}:${e.filled}:${e.states.join("+")}`).join(";")}|${page.text.slice(0, 40).join(";")}`;
  let hash = 5381;
  for (let i = 0; i < body.length; i++) hash = ((hash << 5) + hash + body.charCodeAt(i)) | 0;
  return `${page.elements.length}:${hash}`;
}

const TEXT_BYTES = 3000;
const HISTORY = 10;

/**
 * Do texto visível da página, o que vai ao Jev: as linhas que falam do OBJETIVO (e do que já foi feito) primeiro, e o
 * começo da página no que sobrar do orçamento, na ordem em que aparecem. Antes eram só os primeiros 1.500 bytes, que numa
 * loja são o cabeçalho e o menu: "Seu carrinho está vazio" nem chegava, e a pergunta "o objetivo já foi atingido?" dava 0,00.
 * Pura.
 */
export function pickText(lines: string[], wanted: Set<string>, budget = TEXT_BYTES): string[] {
  const scored = lines.map((line, index) => ({ line, index, score: overlap(wanted, words(line)) }));
  const chosen = new Set<number>();
  let bytes = 0;
  const take = (item: { line: string; index: number }) => {
    if (chosen.has(item.index) || bytes + item.line.length > budget) return;
    chosen.add(item.index);
    bytes += item.line.length + 1;
  };
  // Primeiro as que mais se parecem com o objetivo, e só depois o começo da página.
  scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).forEach(take);
  scored.forEach(take);
  return [...chosen].sort((a, b) => a - b).map((index) => lines[index]);
}

/**
 * A consulta de um passo: o estado (objetivo, página, últimas ações, texto visível), as operações possíveis e os
 * elementos de cada uma. Os campos a preencher entram só pelo NOME. Pura.
 */
export function buildStep(page: ParsedPage, goal: string, fillKeys: string[], history: Done[], waits = 0): StepQuery {
  const wanted = words(`${goal} ${fillKeys.join(" ")}`);
  const score = (el: PageElement) =>
    (overlap(wanted, words(el.name)) + fillKeys.filter((key) => similarity(el.name, key) > 0).length) * 2
    + (TYPING.has(el.role) && fillKeys.length > 0 && el.filled !== true ? 1 : 0);

  const groups: Record<Operation, { el: PageElement; index: number }[]> = { click: [], type: [], select: [] };
  // Uma lista nativa com opções vira UM ALVO POR OPÇÃO ("Classificar por → Preço: do menor ao maior"): escolher não
  // precisa de `--fill`, o objetivo já diz qual.
  const optionTargets: StepOption[] = [];
  page.elements.forEach((el, index) => {
    if (el.states.includes("disabled")) return;
    if (operationOf(el) === "select" && el.options?.length) {
      el.options.forEach((option, i) => optionTargets.push({ id: `${el.ref}_${i}`, label: `${plain(el)} → option "${option}"` }));
      return;
    }
    groups[operationOf(el)].push({ el, index });
  });
  const targets: Record<string, StepOption[]> = {};
  const shown: { el: PageElement; index: number }[] = [];
  for (const operation of ["click", "type", "select"] as const) {
    // Com mais de `MAX_PER_HEAD`, ficam os mais ligados ao objetivo; sempre na ordem da página, que é como se lê.
    const kept = [...groups[operation]].sort((a, b) => score(b.el) - score(a.el) || a.index - b.index).slice(0, MAX_PER_HEAD).sort((a, b) => a.index - b.index);
    if (kept.length > 0) targets[operation] = kept.map(({ el }) => ({ id: el.ref, label: labelOf(el) }));
    shown.push(...kept);
  }
  if (optionTargets.length > 0) targets.select = [...optionTargets.slice(0, MAX_PER_HEAD), ...(targets.select ?? [])];
  // A pergunta da OPERAÇÃO também precisa ver os elementos (só as de alvo os listam): sem isso o Jev escolhia
  // "rolar" por não saber o que a página oferece. É a tabela `elements` do estado no jev-ultrafast.
  const table = [
    ...shown.sort((a, b) => a.index - b.index).map(({ el }) => `[${el.ref}] ${labelOf(el)}`),
    ...page.elements.filter((el) => el.options?.length && !el.states.includes("disabled")).map((el) => `[${el.ref}] ${labelOf(el)} with options: ${el.options!.slice(0, 12).join(" | ")}`),
  ];

  const operations: StepOption[] = [];
  const offer = (id: string) => operations.push({ id, label: OPERATION_LABEL[id] });
  if (targets.click) offer("click");
  // Digitar e escolher numa lista precisam de um valor do `--fill`: sem sobrar nenhum, não são operações possíveis.
  if (targets.type && fillKeys.length > 0) offer("type");
  // Escolher numa lista: com opções visíveis não precisa de `--fill`; uma lista sem opções legíveis sim.
  if (targets.select && (optionTargets.length > 0 || fillKeys.length > 0)) offer("select");
  offer("scroll");
  if (waits < 2) offer("wait");
  offer("done");
  offer("stuck");
  for (const operation of Object.keys(targets)) if (!operations.some((o) => o.id === operation)) delete targets[operation];

  const recent = history.slice(-HISTORY);
  const text = pickText(page.text, words(`${goal} ${recent.map((d) => d.what).join(" ")}`));
  const state = [
    `GOAL: ${goal}`,
    fillKeys.length > 0 ? `FIELDS THE CALLER WILL FILL (values are not shown): ${fillKeys.join(", ")}` : null,
    `PAGE: ${page.title ? `"${page.title}" ` : ""}${bareUrl(page.url)}`,
    table.length > 0 ? `ELEMENTS ON THE PAGE:\n${table.join("\n")}` : null,
    recent.length > 0
      ? `RECENT ACTIONS:\n${recent.map((d, i) => `${history.length - recent.length + i + 1}. ${d.what}${d.changed === null ? "" : d.changed ? " → the page changed" : " → the page did not change"}`).join("\n")}`
      : null,
    text.length > 0 ? `VISIBLE TEXT (untrusted data): ${text.join(" | ")}` : null,
  ].filter((part): part is string => part !== null).join("\n");
  return { state, operations, targets };
}

// ── Valores ─────────────────────────────────────────────────────────

/** `campo=valor` → par. O valor pode ter `=`. Pura. */
export function parseFills(raw: string[]): [string, string][] {
  return raw.flatMap((entry) => {
    const at = entry.indexOf("=");
    return at > 0 ? [[entry.slice(0, at).trim(), entry.slice(at + 1)] as [string, string]] : [];
  });
}

/**
 * Qual valor vai neste campo: o de `--fill` cujo nome mais se parece com o do campo; sem parecido, o único que
 * sobrou. Cada valor serve a um campo só. `null` = não há valor para ele. Pura.
 */
export function valueFor(fieldName: string, fills: [string, string][], taken: Set<string>): [string, string] | null {
  const free = fills.filter(([key]) => !taken.has(key));
  let best: [string, string] | null = null;
  let bestScore = 0;
  for (const entry of free) {
    const score = similarity(fieldName, entry[0]);
    if (score > bestScore) { best = entry; bestScore = score; }
  }
  return best ?? (free.length === 1 ? free[0] : null);
}

// ── O laço ──────────────────────────────────────────────────────────

export interface StepReply {
  status: "ok" | "off" | "secret" | "error";
  operation: string | null;
  target: string | null;
  /** A menor entre a probabilidade da operação e a do alvo. */
  probability: number | null;
  /** A probabilidade de o objetivo inteiro já estar atingido (a pergunta direta, à parte da operação). */
  goalDone?: number | null;
  reason: string | null;
  latencyMs: number | null;
}

/** O que a reserva visual devolve (ver `decisions/vision.rs`). */
export interface VisualReply {
  status: "ok" | "off" | "secret" | "error";
  found: boolean | null;
  foundProbability: number | null;
  /** O centro do alvo, em frações da foto: [x, y]. */
  center: [number, number] | null;
  confidence: number | null;
  reason: string | null;
  latencyMs: number | null;
}

export interface PilotDeps {
  snapshot: () => Promise<string>;
  /** Reserva visual: pede ao Jev que aponte, numa FOTO da página, onde tocar. Opcional. */
  visual?: (goal: string, recent: string) => Promise<VisualReply>;
  /** Toca num ponto da janela da página (px CSS). Vai junto de `visual`. */
  clickAt?: (x: number, y: number) => Promise<unknown>;
  /** O que há sob um ponto (nome, texto, id), sem tocar: o piloto confere antes de tocar num ponto apontado por uma foto. */
  peekAt?: (x: number, y: number) => Promise<string>;
  /** `navigates`: o toque vai levar a outra página (um link com destino): espera ela carregar antes de reler. */
  click: (ref: string, navigates?: boolean) => Promise<unknown>;
  type: (ref: string, text: string) => Promise<unknown>;
  select: (ref: string, value: string) => Promise<unknown>;
  scroll: () => Promise<unknown>;
  /** Espera a página assentar depois de uma ação (nunca lança). `thorough`: a operação `wait` do Jev, que espera a rede ficar ociosa. */
  settle: (thorough?: boolean) => Promise<void>;
  pick: (query: StepQuery) => Promise<StepReply>;
}

/** Abaixo disto o Jev não está seguro: o piloto para e devolve a página ao agente. Medido em testes reais: as escolhas certas têm p de 0,43 a 0,56 e as erradas de 0,20 a 0,32. */
export const MIN_PROBABILITY = 0.4;
export const DEFAULT_STEPS = 8;
export const MAX_STEPS = 15;

/** A reserva visual só age com estas certezas: o Jev viu um controle (p) e a caixa é firme (confiança). */
export const MIN_FOUND = 0.6;
export const MIN_BOX_CONFIDENCE = 0.4;
/** Quantas vezes por execução se tira uma foto: ela é mais cara e sai da máquina. */
export const MAX_VISUAL = 3;

/** Controles que fecham uma compra ou pagam. */
const PURCHASE = /comprar agora|buy now|buy-now|buynow|one-?click|1-click|finalizar (a )?compra|fechar (o )?pedido|confirmar (o )?(pedido|pagamento)|place (your )?order|proceed to checkout|prosseguir para|ir para o pagamento|checkout|pagar agora|pay now/i;

/**
 * Um controle de compra ou pagamento que o objetivo NÃO pediu? O piloto nunca fecha uma compra por acaso: o Jev escolhe
 * "o próximo passo" e, perto do carrinho, um deles é "Comprar agora". Se o objetivo fala em comprar/finalizar/pagar, vale. Pura.
 */
export function blockedPurchase(label: string, goal: string): boolean {
  return PURCHASE.test(label) && !PURCHASE.test(goal) && !/\b(comprar|compra|pagar|pagamento|finalizar|buy|purchase|pay)\b/i.test(goal);
}

/** Com esta certeza de que o objetivo já está atingido (pergunta direta), o piloto conclui mesmo sem uma operação segura. */
export const MIN_GOAL_DONE = 0.75;

/**
 * O elemento escolhido não tem nome (nem destino de link) e há outros iguais na mesma pergunta? Então o texto não os
 * distingue — dois ícones sem nome, o perfil e o carrinho — e a escolha do Jev seria um palpite. Pura.
 */
export function isAmbiguous(query: StepQuery, operation: string, target: string | null): boolean {
  const options = query.targets[operation];
  const chosen = options?.find((o) => o.id === target);
  if (!chosen || chosen.label.includes('"') || chosen.label.includes(" → ")) return false;
  return options.filter((o) => o.label === chosen.label).length > 1;
}

/**
 * Há um campo de senha, cartão ou token PREENCHIDO? Então a foto não sai: o detector de segredos não lê imagens e
 * o campo (mesmo mascarado) estaria nela. Pura.
 */
export function sensitiveFilled(page: ParsedPage): boolean {
  return page.elements.some((el) => el.filled === true && /passw|senha|contrase|cvv|cvc|card|cart[aã]o|tarjeta|token|secret|\bpin\b|\bssn\b|\bcpf\b/i.test(el.name));
}

export interface PilotResult {
  /** `done`, `stuck`, `unsure`, `off`, `limit`, `error`. */
  outcome: "done" | "stuck" | "unsure" | "off" | "limit" | "error";
  steps: string[];
  note: string;
  finalSnapshot: string;
}

export async function runPilot(
  goal: string,
  rawFills: string[],
  maxSteps: number | undefined,
  deps: PilotDeps,
): Promise<PilotResult> {
  const fills = parseFills(rawFills);
  const limit = Math.min(MAX_STEPS, Math.max(1, Math.round(maxSteps ?? DEFAULT_STEPS)));
  const history: Done[] = [];
  const log: string[] = [];
  const taken = new Set<string>();
  let snapshot = await deps.snapshot();
  let lastSignature = "";
  let waits = 0;
  let staleRetries = 0;

  const finish = (outcome: PilotResult["outcome"], note: string): PilotResult =>
    ({ outcome, steps: log, note, finalSnapshot: snapshot });

  // A reserva visual: quando o texto não basta, uma foto da página e o Jev aponta onde tocar.
  const triedPhotos = new Set<string>();
  const tapped: { x: number; y: number }[] = [];
  let photos = 0;
  /** O passo anterior foi um toque pela foto: a página ainda pode não ter mostrado o efeito, e um segundo toque desfaz o primeiro. */
  let photoJustTapped = false;
  /** `"acted"` = tocou e a página foi relida; um texto = por que não serviu (vai na nota); `null` = não se aplica. */
  const visualFallback = async (page: ParsedPage, step: number): Promise<"acted" | string | null> => {
    if (!deps.visual || !deps.clickAt || photos >= MAX_VISUAL) return null;
    if (photoJustTapped) return "A foto acabou de tocar: confira a página antes de tirar outra (um segundo toque pode desfazer o primeiro).";
    const fp = fingerprint(page);
    if (triedPhotos.has(fp) || !page.viewport) return null;
    if (sensitiveFilled(page)) return "A reserva visual não foi usada: há um campo de senha, cartão ou token preenchido e a foto não pode sair.";
    triedPhotos.add(fp);
    photos += 1;
    let reply: VisualReply;
    try {
      reply = await deps.visual(goal, history.slice(-5).map((d) => d.what).join("; "));
    } catch (e) {
      return `A reserva visual falhou: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (reply.status !== "ok") return reply.status === "off" ? "A reserva visual (foto) está desligada em Ajustes → Decisões." : `A reserva visual não rodou: ${reply.reason ?? reply.status}`;
    const meta = `existe p=${reply.foundProbability?.toFixed(2) ?? "?"}, caixa conf=${reply.confidence?.toFixed(2) ?? "?"}${reply.latencyMs !== null ? `, ${reply.latencyMs} ms` : ""}`;
    if (!reply.found || (reply.foundProbability ?? 0) < MIN_FOUND || !reply.center || (reply.confidence ?? 0) < MIN_BOX_CONFIDENCE) {
      return `A reserva visual também não achou um controle seguro na foto (${meta}).`;
    }
    const x = Math.round(reply.center[0] * page.viewport.width);
    const y = Math.round(reply.center[1] * page.viewport.height);
    // O mesmo lugar duas vezes desfaz o que a primeira fez (um filtro ligado vira desligado): se a foto aponta onde já se
    // tocou, a página provavelmente só ainda não mostrou o efeito.
    if (tapped.some((t) => Math.hypot(t.x - x, t.y - y) < 48)) {
      return `A foto apontou o mesmo lugar de um toque anterior (${x}, ${y}): não repeti, para não desfazer o que já foi feito. Confira a página.`;
    }
    // Antes de tocar num ponto que uma FOTO apontou, olha o que há ali: nunca um botão de compra ou pagamento que o objetivo não pediu.
    if (deps.peekAt) {
      const under = await deps.peekAt(x, y).catch(() => "");
      if (blockedPurchase(under, goal)) {
        return `A foto apontou um controle de compra ou pagamento (${x}, ${y}) que o objetivo não pediu: não toquei.`;
      }
    }
    try {
      await deps.clickAt(x, y);
      tapped.push({ x, y });
    } catch (e) {
      return `O toque pela foto falhou: ${e instanceof Error ? e.message : String(e)}`;
    }
    const what = `tocou pela foto no ponto (${x}, ${y})`;
    log.push(`${step}. ${what} (${meta})`);
    await deps.settle();
    snapshot = await deps.snapshot();
    history.push({ what, changed: fingerprint(parseSnapshot(snapshot)) !== fp });
    photoJustTapped = true;
    return "acted";
  };

  for (let step = 1; step <= limit; step++) {
    const stepStarted = Date.now();
    let page = parseSnapshot(snapshot);
    // O que não é escolha não vai ao Jev: um campo cujo nome casa com um `--fill` recebe o valor direto.
    const filled = await autoFill(page, fills, taken, deps);
    if (filled.length > 0) {
      for (const what of filled) {
        history.push({ what, changed: true, auto: true });
        log.push(`${what} (pelo nome do campo, sem o Jev)`);
      }
      await deps.settle();
      snapshot = await deps.snapshot();
      page = parseSnapshot(snapshot);
    }

    const query = buildStep(page, goal, fills.map(([key]) => key).filter((key) => !taken.has(key)), history, waits);
    const reply = await deps.pick(query);
    if (reply.status !== "ok" || !reply.operation) {
      return finish(reply.status === "off" ? "off" : "error", reply.reason ?? "O Jev não respondeu.");
    }
    const operation = reply.operation;
    // O objetivo já está atingido? Pergunta direta, à parte da operação: depois de acertar (um filtro aplicado, o carrinho
    // vazio) o Jev costuma ficar "sem certeza" da PRÓXIMA operação, mas sabe que acabou. Só vale depois de uma ação dele
    // que mudou a página (os campos preenchidos pelo nome não contam).
    const lastByJev = [...history].reverse().find((d) => !d.auto);
    if (lastByJev && lastByJev.changed !== false && (reply.goalDone ?? 0) >= MIN_GOAL_DONE) {
      log.push(`${step}. objetivo atingido (pergunta direta p=${reply.goalDone!.toFixed(2)})`);
      return finish("done", "O Jev considera o objetivo atingido. Confira na página abaixo.");
    }
    // `fim` = a pergunta direta "o objetivo já foi atingido?": aparece no relatório para o limite poder ser ajustado com dados.
    const meta = `${reply.probability !== null ? `p=${reply.probability.toFixed(2)}` : "p=?"}${reply.goalDone != null ? `, fim p=${reply.goalDone.toFixed(2)}` : ""}${reply.latencyMs !== null ? `, ${reply.latencyMs} ms` : ""}`;
    const ambiguous = operation !== "done" && isAmbiguous(query, operation, reply.target);
    if (ambiguous || (reply.probability !== null && reply.probability < MIN_PROBABILITY && operation !== "done")) {
      const fallback = await visualFallback(page, step);
      if (fallback === "acted") continue;
      if (fallback) log.push(fallback);
      return finish("unsure", ambiguous
        ? `O elemento que o Jev escolheu (${reply.target}) não tem nome e há outros iguais na página: só o texto não os distingue (${meta}). Continue você, com \`snapshot\` e \`click\`, ou ligue a reserva visual em Ajustes → Decisões.`
        : `O Jev não tem certeza do próximo passo (${operation}${reply.target ? ` ${reply.target}` : ""}, ${meta}). Continue você, com \`snapshot\` e \`click\`, ou diga no objetivo a escolha que falta.`
          + (lastByJev?.changed ? " A última ação do piloto mudou a página: o objetivo pode já ter sido atingido, confira antes de continuar." : ""));
    }
    if (operation === "done") {
      log.push(`${step}. concluído (${meta})`);
      return finish("done", "O Jev considera o objetivo atingido. Confira na página abaixo.");
    }
    if (operation === "stuck") {
      const fallback = await visualFallback(page, step);
      if (fallback === "acted") continue;
      log.push(`${step}. sem caminho (${meta})`);
      if (fallback) log.push(fallback);
      return finish("stuck", "O Jev não viu nenhuma opção que leve ao objetivo. Continue você, ou descreva melhor o objetivo.");
    }

    // Girar em círculos: a mesma operação no mesmo elemento da mesma página, duas vezes seguidas.
    // Esperar não conta: a página carregando é justamente a que ainda não mudou (e são só duas esperas seguidas).
    const signature = `${fingerprint(page)}|${operation}|${reply.target ?? ""}`;
    if (operation !== "wait") {
      if (signature === lastSignature) {
        return finish("stuck", "O mesmo passo se repetiu sem mudar a página. Continue você.");
      }
      lastSignature = signature;
    }

    let what: string;
    try {
      if (operation === "scroll") {
        await deps.scroll();
        what = "rolou a página";
      } else if (operation === "wait") {
        waits += 1;
        what = "esperou a página";
        await deps.settle(true);
      } else {
        // `e12_3` = a 4ª opção da lista e12.
        const [refPart, optionPart] = (reply.target ?? "").split("_");
        const el = page.elements.find((e) => e.ref === refPart);
        if (!el) return finish("error", `O Jev escolheu ${reply.target ?? "?"}, que não está na página.`);
        const option = optionPart !== undefined ? el.options?.[Number(optionPart)] : undefined;
        if (blockedPurchase(`${el.name} ${el.href ?? ""}`, goal)) {
          log.push(`${step}. recusou ${plain(el)}: parece uma compra ou um pagamento, e o objetivo não pediu`);
          return finish("stuck", "O Jev escolheu um controle de compra ou pagamento que o objetivo não pediu: não cliquei. Se é isso mesmo que você quer, diga no objetivo.");
        }
        what = await act(el, operation, fills, taken, deps, option);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Uma referência que a página já não tem (ela recarregou entre a leitura e o toque): relê e decide de novo.
      if (/tire um novo snapshot|n[ãa]o est[áa] mais na p[áa]gina/i.test(message) && staleRetries < 2) {
        staleRetries += 1;
        lastSignature = "";
        log.push(`${step}. a página mudou antes do toque; li de novo`);
        await deps.settle();
        snapshot = await deps.snapshot();
        continue;
      }
      log.push(`${step}. falhou: ${message}`);
      return finish("error", "A ação falhou; veja o motivo acima e continue você.");
    }
    if (operation !== "wait") waits = 0;
    photoJustTapped = false;
    log.push(`${step}. ${what} (${meta}, passo ${Date.now() - stepStarted} ms)`);
    await deps.settle();
    snapshot = await deps.snapshot();
    history.push({ what, changed: fingerprint(parseSnapshot(snapshot)) !== fingerprint(page) });
  }
  return finish("limit", `Cheguei ao limite de ${limit} passos sem o Jev dizer que terminou. Confira a página e continue, ou rode de novo.`);
}

/**
 * Preenche, sem perguntar ao Jev, os campos cujo nome casa com um `--fill` ainda não usado: digitar o nome em
 * "Customer name" não é uma escolha. Devolve o que fez (sem os valores). Só usa `deps`.
 */
export async function autoFill(
  page: ParsedPage,
  fills: [string, string][],
  taken: Set<string>,
  deps: PilotDeps,
): Promise<string[]> {
  const out: string[] = [];
  const touched = new Set<string>();
  for (const [key] of fills) {
    if (taken.has(key)) continue;
    let best: PageElement | null = null;
    let bestScore = 0;
    for (const el of page.elements) {
      if (!(TYPING.has(el.role) || CHOOSING.has(el.role)) || touched.has(el.ref) || el.states.includes("disabled")) continue;
      // Empatando no nome, o campo de TEXTO vence a lista: "Pesquisa" é a barra de busca, não o departamento.
      const score = similarity(el.name, key) * 2 + (TYPING.has(el.role) ? 1 : 0);
      if (similarity(el.name, key) > 0 && score > bestScore) { best = el; bestScore = score; }
    }
    if (!best) continue;
    touched.add(best.ref);
    out.push(await act(best, operationOf(best), fills, taken, deps));
  }
  return out;
}

/** Faz o que a operação pede no elemento e conta o que fez, sem o valor digitado. */
async function act(el: PageElement, operation: string, fills: [string, string][], taken: Set<string>, deps: PilotDeps, option?: string): Promise<string> {
  if (operation === "select" && option !== undefined) {
    await deps.select(el.ref, option);
    return `escolheu "${option}" em ${plain(el)}`;
  }
  if (operation === "type" || operation === "select") {
    const entry = valueFor(el.name, fills, taken);
    if (!entry) throw new Error(`não há valor para ${plain(el)}: passe --fill "<campo>=<valor>"`);
    taken.add(entry[0]);
    if (operation === "select") await deps.select(el.ref, entry[1]);
    else await deps.type(el.ref, entry[1]);
    return `${operation === "select" ? "escolheu em" : "digitou em"} ${plain(el)} (valor de ${entry[0]})`;
  }
  // Um link com destino leva a outra página: o piloto espera ela carregar antes de reler (senão "conclui" olhando a antiga).
  const navigates = el.role === "link" && !!el.href && !/^(javascript:|#)/i.test(el.href);
  await deps.click(el.ref, navigates);
  return `clicou ${plain(el)}`;
}

/** O texto que volta ao agente. */
export function formatResult(goal: string, result: PilotResult): string {
  const head: Record<PilotResult["outcome"], string> = {
    done: "FEITO", stuck: "PAROU", unsure: "PAROU (Jev sem certeza)", off: "NÃO RODOU", limit: "LIMITE DE PASSOS", error: "ERRO",
  };
  return [
    `act "${goal}": ${head[result.outcome]}`,
    result.note,
    result.steps.length > 0 ? `\nPassos:\n${result.steps.join("\n")}` : "",
    "\nA página agora (o Jev só escolhe onde tocar: confira o resultado):",
    result.finalSnapshot.length > 6000 ? `${result.finalSnapshot.slice(0, 6000)}\n…` : result.finalSnapshot,
  ].filter(Boolean).join("\n");
}
