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

import { windowLine, type WindowStats } from "./windowBeat";

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
  /** O que vem logo antes dele na página (o título e o preço do produto, o link anterior): distingue "Adicionar" de "Adicionar". */
  near?: string;
}

export interface ParsedPage {
  title: string;
  url: string;
  elements: PageElement[];
  /** O texto visível, em linhas curtas, na ordem da página. */
  text: string[];
  /** O tamanho da janela da página em px CSS (do cabeçalho do snapshot): converte as frações de uma foto em pontos. */
  viewport?: { width: number; height: number };
  /** Quanto a página já rolou (do cabeçalho do snapshot): rolar muda a página, mesmo sem elemento novo. */
  scrollY?: number;
}

const NODE = /^\s*- (\S+)(?: ("(?:[^"\\]|\\.)*"))?(.*)$/;
const REF = /\[ref=(e\d+)\]/;
const STATE = /\[([^\]=]+)\]/g;
const HEADER = /^page: (?:("(?:[^"\\]|\\.)*") )?(\S+)/;
const VIEWPORT = /^viewport: (\d+)×(\d+)(?: · scroll (\d+)\/(\d+))?/;
/** Quanto do que vem antes de um elemento entra no `near`. */
const NEAR_CHARS = 48;
/** Quanto do `near` é o título; o resto, o último texto (o preço). */
const NEAR_TITLE = 32;
const VALUE = / value=("(?:[^"\\]|\\.)*")/;
const OPTIONS = / options=(\[.*\])\s*$/;

function unquote(raw: string | undefined): string {
  if (!raw) return "";
  try { return JSON.parse(raw) as string; } catch { return raw.slice(1, -1); }
}

/** Lê o texto do `snapshot` (ver `page/snapshotFormat.ts`) de volta em elementos e texto. Pura. */
export function parseSnapshot(snapshot: string): ParsedPage {
  const page: ParsedPage = { title: "", url: "", elements: [], text: [] };
  // O que fica "perto" do próximo elemento: o último título (um heading ou o link do produto) e o último texto depois dele (o preço).
  let title = "";
  let lastText = "";
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
      if (size[3] !== undefined) page.scrollY = Number(size[3]);
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
      const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
      const nearby = [cut(title, NEAR_TITLE), cut(lastText, NEAR_CHARS - NEAR_TITLE)].filter(Boolean).join(" | ");
      page.elements.push({
        ref, role, name, states, filled: value ? unquote(value[1]).length > 0 : null,
        ...(target ? { href: target } : {}),
        ...(options?.length ? { options } : {}),
        ...(nearby ? { near: nearby } : {}),
      });
      lastText = "";
      // O link com nome é o título de quem vem depois (o produto, e o botão «Adicionar» logo abaixo).
      if (role === "link" && name) title = name;
    } else if ((role === "text" || role === "heading") && name) {
      page.text.push(name);
      if (role === "heading") { title = name; lastText = ""; } else lastText = name;
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
  /** Não fazer a pergunta direta «o objetivo já foi atingido?»: o piloto só a usa depois de uma ação dele que mudou a página (plano v2, 4.2). */
  skipGoalDone?: boolean;
}

const ROLE_LABEL: Record<string, string> = {
  button: "button", link: "link", textbox: "text field", searchbox: "search field", textarea: "text area",
  combobox: "dropdown", listbox: "list", checkbox: "checkbox", radio: "radio option", switch: "switch",
  tab: "tab", menuitem: "menu item", option: "option", clickable: "clickable element", slider: "slider", spinbutton: "number field",
};

/** O estado que o runtime escreve num elemento de anúncio (`page/sponsored.ts`). */
const SPONSORED_STATE = "patrocinado";
/** Controles de paginação e de fechar uma faixa/modal: precisam sobreviver ao corte de candidatos de uma página comprida. */
const PAGINATION = /^(pr[óo]xim[ao]|next|mais|more|carregar mais|load more|mostrar mais|show more|ver mais|older|seguinte|›|»|>)\b|^\d{1,3}$/i;
const DISMISS = /^(fechar|close|×|x|rejeitar|reject|recusar|decline|n[ãa]o,? obrigad[oa]|no,? thanks|agora n[ãa]o|not now|dispensar|dismiss|aceitar (apenas )?(os )?essenciais|only necessary|necessary only)\b/i;
/** O objetivo pede um anúncio? Então o patrocinado não é rebaixado. */
const AD_GOAL = /an[uú]ncio|patrocinad|sponsored|\bads?\b|publicidade/i;

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
  /** Veio de um `act` anterior neste portal (o livro-razão da ponte): o `what` já traz «[earlier run #N]». */
  earlier?: boolean;
  /** A ação anterior como a ponte a guardou: tem a contagem do carrinho e se a página mudou desde o fim daquele `act`. */
  prior?: PriorAction;
  /** Foi um «adicionar»: de qual item (papel, nome, produto, endereço) e a contagem do carrinho antes/depois, se a página a mostra. */
  add?: { key: string; cartBefore: number | null; cartAfter: number | null };
}

/**
 * Uma ação de um `act` ANTERIOR neste portal (o livro-razão é `portalLedger.ts`, na ponte; achado D6). Estruturalmente um `Done`.
 * O `what` chega marcado «[feito num act anterior #2] clicou button "Adicionar" — carrinho 0→1»; o piloto o mostra ao Jev como
 * «[earlier run #2] …», a palavra que as regras de `browse_rules.rs` citam.
 */
export interface PriorAction {
  what: string;
  changed: boolean | null;
  auto?: boolean;
  previous: true;
  actNo: number;
  goal: string;
  cartBefore: number | null;
  cartAfter: number | null;
  /** A página de agora difere da do fim daquele `act`? Só na última ação. `null` = não se sabe. */
  pageChangedSince: boolean | null;
}

/** O que o Jev lê de um elemento: o papel, o nome e o estado (marcado, expandido, preenchido), nunca o valor. */
function labelOf(el: PageElement, twins?: Set<string>): string {
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
  // Vários elementos com o mesmo papel e nome ("Adicionar" ×8): só o que vem antes deles os distingue (o produto, o preço).
  const near = twins?.has(twinKey(el)) && el.near ? ` [next to: ${el.near}]` : "";
  // Ordem do que mais importa ao que menos: o nome, o estado, quem é (o que vem antes), o destino — o provedor corta em ~110.
  // Os sinais que as regras do Jev citam (`decisions/browse_rules.rs`) vão logo depois do nome, antes de o provedor cortar o rótulo.
  const tags = `${el.states.includes(SPONSORED_STATE) ? " [sponsored]" : ""}${el.states.includes("required") ? " [required]" : ""}`;
  return `${role}${el.name ? ` "${el.name}"` : ""}${tags}${marks.length > 0 ? ` (${marks.join(", ")})` : ""}${near}${where}`;
}

/** A chave de "são o mesmo controle": o papel, o nome e o destino. */
function twinKey(el: PageElement): string {
  return `${el.role}|${el.name}|${el.href ?? ""}`;
}

/** Os controles que se repetem na página (mesmo papel, nome e destino). Pura. */
export function twinsOf(elements: PageElement[]): Set<string> {
  const seen = new Map<string, number>();
  for (const el of elements) seen.set(twinKey(el), (seen.get(twinKey(el)) ?? 0) + 1);
  return new Set([...seen].filter(([, n]) => n > 1).map(([key]) => key));
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
  const body = `${bareUrl(page.url)}|${page.elements.map((e) => `${e.role}:${e.name}:${e.filled}:${e.states.join("+")}`).join(";")}|${page.text.slice(0, 40).join(";")}|${page.scrollY ?? ""}`;
  let hash = 5381;
  for (let i = 0; i < body.length; i++) hash = ((hash << 5) + hash + body.charCodeAt(i)) | 0;
  return `${page.elements.length}:${hash}`;
}

/**
 * O que corta o estado que vai ao Jev (plano v2, 4.2, achado D2: a latência por consulta acompanha o tamanho do corpo). Cada
 * número é um botão: o benchmark real diz se a precisão aguenta; voltar atrás é mudar uma constante.
 */
/** O texto visível: as linhas que falam do objetivo vêm primeiro, então 1.800 bytes bastam (eram 3.000). */
export const TEXT_BYTES = 1800;
/** A tabela de elementos do estado repete o rótulo de cada opção das perguntas de alvo: ali o rótulo corta mais cedo. */
export const TABLE_LABEL_CHARS = 90;
/** E leva no máximo estes elementos (os que mais se parecem com o objetivo); as perguntas de alvo continuam com todos. */
export const MAX_TABLE = 80;
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
/**
 * Do que o objetivo cita entre «», «"» ou aspas, os links que têm esse nome mas NÃO vão para esse destino, quando existe um link
 * com esse nome que vai (o último trecho do endereço é o próprio nome: `/wiki/Portugal`). Sem um link exato, nada sai. Pura.
 */
export function inexactLinks(page: ParsedPage, goal: string): Set<string> {
  const out = new Set<string>();
  const slug = (href: string) => {
    try { return decodeURIComponent(href.split("/").filter(Boolean).pop() ?? "").replace(/[_-]/g, " ").trim().toLowerCase(); } catch { return ""; }
  };
  for (const match of goal.matchAll(/[«"“]([^»"”]{2,40})[»"”]/g)) {
    const wanted = match[1].trim().toLowerCase();
    const same = page.elements.filter((el) => el.role === "link" && el.name.trim().toLowerCase() === wanted);
    const exact = same.filter((el) => el.href !== undefined && slug(el.href) === wanted);
    if (exact.length === 0) continue;
    for (const el of same) if (!exact.includes(el)) out.add(el.ref);
  }
  return out;
}

export function buildStep(page: ParsedPage, goal: string, fillKeys: string[], history: Done[], waits = 0): StepQuery {
  const wanted = words(`${goal} ${fillKeys.join(" ")}`);
  const wantsAds = AD_GOAL.test(goal);
  const score = (el: PageElement) =>
    (overlap(wanted, words(el.name)) + fillKeys.filter((key) => similarity(el.name, key) > 0).length) * 2
    + (TYPING.has(el.role) && fillKeys.length > 0 && el.filled !== true ? 1 : 0)
    // Numa página comprida o corte fica com os mais ligados ao objetivo: o anúncio é o primeiro a sair, e o «Próxima» e o «Fechar» não saem.
    + (PAGINATION.test(el.name.trim()) || DISMISS.test(el.name.trim()) ? 3 : 0)
    - (!wantsAds && el.states.includes(SPONSORED_STATE) ? 4 : 0);

  const twins = twinsOf(page.elements);
  const inexact = inexactLinks(page, goal);
  const groups: Record<Operation, { el: PageElement; index: number }[]> = { click: [], type: [], select: [] };
  // Uma lista nativa com opções vira UM ALVO POR OPÇÃO ("Classificar por → Preço: do menor ao maior"): escolher não
  // precisa de `--fill`, o objetivo já diz qual.
  const optionTargets: StepOption[] = [];
  page.elements.forEach((el, index) => {
    if (el.states.includes("disabled")) return;
    // Um botão de compra ou pagamento que o objetivo não pediu nem é oferecido: o Jev escolhe entre os outros (o
    // "Adicionar ao carrinho" ao lado de um "Comprar agora") em vez de o piloto parar ao ver a escolha barrada.
    if (blockedControl(el, goal)) return;
    // Vários links com o MESMO nome do que o objetivo cita entre «», e um deles vai mesmo para esse destino: os outros saem
    // (P02: «Portugal» levava ao «Império Português»).
    if (inexact.has(el.ref)) return;
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
    if (kept.length > 0) targets[operation] = kept.map(({ el }) => ({ id: el.ref, label: labelOf(el, twins) }));
    shown.push(...kept);
  }
  if (optionTargets.length > 0) targets.select = [...optionTargets.slice(0, MAX_PER_HEAD), ...(targets.select ?? [])];
  // A pergunta da OPERAÇÃO também precisa ver os elementos (só as de alvo os listam): sem isso o Jev escolhia
  // "rolar" por não saber o que a página oferece. É a tabela `elements` do estado no jev-ultrafast.
  const inTable = shown.length > MAX_TABLE
    ? [...shown].sort((a, b) => score(b.el) - score(a.el) || a.index - b.index).slice(0, MAX_TABLE)
    : shown;
  const clip = (text: string) => (text.length > TABLE_LABEL_CHARS ? `${text.slice(0, TABLE_LABEL_CHARS - 1)}…` : text);
  const table = [
    ...inTable.sort((a, b) => a.index - b.index).map(({ el }) => `[${el.ref}] ${clip(labelOf(el, twins))}`),
    ...(shown.length > inTable.length ? [`(+${shown.length - inTable.length} more elements offered in the questions below)`] : []),
    ...page.elements.filter((el) => el.options?.length && !el.states.includes("disabled")).map((el) => `[${el.ref}] ${labelOf(el)} with options: ${el.options!.slice(0, 12).join(" | ")}`),
  ];

  const operations: StepOption[] = [];
  const offer = (id: string) => operations.push({ id, label: OPERATION_LABEL[id] });
  if (targets.click) offer("click");
  // Digitar e escolher numa lista precisam de um valor do `--fill`: sem sobrar nenhum, não são operações possíveis.
  // Digitar só é uma escolha do Jev se há um campo VAZIO: com todos preenchidos, os valores que sobram são de outra etapa
  // (o Jev voltava a "Nome" depois de o piloto o preencher pelo nome e o `act` perdia o passo).
  if (targets.type && fillKeys.length > 0 && page.elements.some((el) => TYPING.has(el.role) && el.filled !== true && !el.states.includes("disabled"))) offer("type");
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
  /** O que a consulta custou: bytes, tokens, tentativas, espera (plano v2, 4.2). Ausente num erro antes de enviar. */
  cost?: QueryCost | null;
  /** De quem foi a falha: a rede, o provedor ou a configuração local (plano v2, 4.3). */
  fault?: "rede" | "provedor" | "local" | null;
}

/** O que uma consulta ao Jev carregou e custou (espelha `QueryCost` em `decisions/browse.rs`). */
export interface QueryCost {
  stateBytes: number;
  requestBytes: number;
  responseBytes: number;
  inputTokens: number;
  outputTokens: number;
  questions: number;
  options: number;
  scanMs: number;
  attempts: number;
  backoffMs: number;
  timeoutMs: number;
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
  /** Abre a conexão com o Jev enquanto a primeira página é lida (o handshake sai do caminho do primeiro passo). Nunca lança. */
  warm?: () => void;
  /** As ações dos `act` anteriores NESTE portal (D6). Chamada DEPOIS da primeira leitura da página (é aí que se sabe se ela mudou). Opcional. */
  prior?: () => PriorAction[];
  snapshot: () => Promise<string>;
  /** Reserva visual: pede ao Jev que aponte, numa FOTO da página, onde tocar. Opcional. */
  visual?: (goal: string, recent: string) => Promise<VisualReply>;
  /** Toca num ponto da janela da página (px CSS). Vai junto de `visual`. */
  clickAt?: (x: number, y: number) => Promise<unknown>;
  /** O que há sob um ponto (nome, texto, id), sem tocar: o piloto confere antes de tocar num ponto apontado por uma foto. */
  peekAt?: (x: number, y: number) => Promise<string>;
  /** `navigates`: o toque vai levar a outra página (um link com destino): espera ela carregar antes de reler. */
  click: (ref: string, navigates?: boolean) => Promise<unknown>;
  /** `submit`: aperta Enter depois de digitar (uma busca só roda assim quando a página não tem botão visível). */
  type: (ref: string, text: string, submit?: boolean) => Promise<unknown>;
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

/** Controles que só avançam um fluxo (próxima etapa, enviar o formulário já preenchido). */
const ADVANCE = /^(pr[óo]xim[oa]|continuar|avan[çc]ar|seguinte|enviar|salvar|confirmar|next|continue|submit|save|send)\b/i;

/** Piso para um controle de avançar, quando não há mais nada a preencher: um «Próximo» sozinho, com p entre 0,30 e 0,40, é o passo óbvio. */
export const MIN_ADVANCE = 0.3;

/**
 * Uma escolha com p abaixo do piso, mas que é só avançar um fluxo: um botão «Próximo/Enviar/Continuar» e nenhum campo de
 * texto vazio (fora a busca) na página. Medido: com os campos já preenchidos o Jev dava p=0,36 ao único «Próximo». Nunca vale
 * para um controle de compra ou pagamento que o objetivo não pediu. Pura.
 */
export function obviousAdvance(page: ParsedPage, operation: string, target: string | null, probability: number | null, goal: string): boolean {
  if (operation !== "click" || probability === null || probability < MIN_ADVANCE || probability >= MIN_PROBABILITY) return false;
  const el = page.elements.find((e) => e.ref === target);
  if (!el || !ADVANCE.test(el.name.trim()) || blockedControl(el, goal)) return false;
  return !page.elements.some((e) => TYPING.has(e.role) && e.filled === false && !e.states.includes("disabled") && !isSearchField(e));
}

/** A reserva visual só age com estas certezas: o Jev viu um controle (p) e a caixa é firme (confiança). */
export const MIN_FOUND = 0.6;
export const MIN_BOX_CONFIDENCE = 0.6;
/** Quantas vezes por execução se tira uma foto: ela é mais cara e sai da máquina. */
export const MAX_VISUAL = 3;

/** Controles que fecham uma compra ou pagam. */
const PURCHASE = /comprar agora|buy now|buy-now|buynow|one-?click|1-click|finalizar (a )?compra|fechar (o )?pedido|confirmar (o )?(pedido|pagamento)|place (your )?order|proceed to checkout|prosseguir para|ir para o pagamento|checkout|pagar agora|pay now/i;

/** O controle (nome e destino) é uma compra que o objetivo não pediu? O carrinho de `/checkout/cart` (Magento) não é fechar a compra. Pura. */
export function blockedControl(el: PageElement, goal: string): boolean {
  return blockedPurchase(`${el.name} ${(el.href ?? "").replace(/checkout\/cart/gi, "/cart")}`, goal);
}

/**
 * Um controle de compra ou pagamento que o objetivo NÃO pediu? O piloto nunca fecha uma compra por acaso: o Jev escolhe
 * "o próximo passo" e, perto do carrinho, um deles é "Comprar agora". Se o objetivo fala em comprar/finalizar/pagar, vale. Pura.
 */
export function blockedPurchase(label: string, goal: string): boolean {
  return PURCHASE.test(label) && !PURCHASE.test(goal) && !/\b(comprar|compra|pagar|pagamento|finalizar|buy|purchase|pay)\b/i.test(goal);
}

/** Com esta certeza de que o objetivo já está atingido (pergunta direta), o piloto conclui mesmo sem uma operação segura. */
export const MIN_GOAL_DONE = 0.75;
/** Depois de uma busca que o PILOTO enviou (Enter) e que levou a outra página, o «acabou» basta com menos certeza. */
export const MIN_GOAL_DONE_AFTER_SUBMIT = 0.6;

/**
 * O elemento escolhido não tem nome (nem destino de link) e há outros iguais na mesma pergunta? Então o texto não os
 * distingue — dois ícones sem nome, o perfil e o carrinho — e a escolha do Jev seria um palpite. Pura.
 */
export function isAmbiguous(query: StepQuery, operation: string, target: string | null, probability: number | null = null): boolean {
  const options = query.targets[operation];
  const chosen = options?.find((o) => o.id === target);
  if (!chosen || chosen.label.includes('"') || chosen.label.includes(" → ")) return false;
  if (options.filter((o) => o.label === chosen.label).length > 1) return true;
  // Dois ícones sem nome com rótulos que só diferem pelo «perto de»: o Jev escolhe um com p=0,58 e erra metade das vezes (L01).
  // Sem nome e sem certeza (p < 0,8), com outro controle sem nome na pergunta, é palpite: a foto decide.
  const unnamed = options.filter((o) => !o.label.includes('"') && !o.label.includes(" → "));
  return probability !== null && probability < UNNAMED_MIN_PROBABILITY && unnamed.length > 1;
}

/** Abaixo disto, um controle SEM NOME escolhido entre outros sem nome não é aceito só pelo texto. */
export const UNNAMED_MIN_PROBABILITY = 0.8;

/**
 * Há um campo de senha, cartão ou token PREENCHIDO? Então a foto não sai: o detector de segredos não lê imagens e
 * o campo (mesmo mascarado) estaria nela. Pura.
 */
export function sensitiveFilled(page: ParsedPage): boolean {
  return page.elements.some((el) => el.filled === true && /passw|senha|contrase|cvv|cvc|card|cart[aã]o|tarjeta|token|secret|\bpin\b|\bssn\b|\bcpf\b/i.test(el.name));
}

/**
 * Sem nenhum `--fill`, o piloto não digita: um objetivo como "preencher o nome Ana e enviar" clica em Enviar com o campo
 * vazio e o Jev ainda acha que terminou. Se a página termina com campos de texto vazios e nada foi passado para eles, o
 * relatório diz isso (os valores só vêm de `--fill`, nunca do texto do objetivo). Pura.
 */
export function emptyFieldsNote(page: ParsedPage, fillCount: number): string {
  if (fillCount > 0) return "";
  const empty = page.elements.filter((el) => TYPING.has(el.role) && el.filled === false && el.name && !el.states.includes("disabled") && !isSearchField(el));
  if (empty.length === 0) return "";
  const names = empty.slice(0, 4).map((el) => `"${el.name}"`).join(", ");
  return ` Atenção: nenhum --fill foi passado e há campos vazios na página (${names}): o piloto só digita valores de --fill, nunca os do texto do objetivo.`;
}

/** Objetivo que pede para digitar/pesquisar: sem `--fill` o piloto não tem o que digitar. */
const TYPE_GOAL = /\b(pesquis\w*|busc\w*|procur\w*|search\w*|digit\w*|preench\w*|escrev\w*|informe|type|fill)\b/i;

/**
 * O objetivo manda digitar ou pesquisar, não veio nenhum `--fill` e a página tem um campo vazio: o piloto nunca digita o
 * texto do objetivo, então clicaria em "Search" com o campo vazio e pararia. Recusa antes de tocar em qualquer coisa, dizendo
 * o que passar. Devolve o aviso, ou `null` se pode seguir. Pura.
 */
export function missingFill(goal: string, fillCount: number, page: ParsedPage): string | null {
  if (fillCount > 0 || !TYPE_GOAL.test(goal)) return null;
  const empty = page.elements.find((el) => TYPING.has(el.role) && el.filled === false && el.name && !el.states.includes("disabled"));
  if (!empty) return null;
  return `O objetivo pede para digitar ou pesquisar, mas nenhum --fill foi passado, e o piloto nunca digita o texto do objetivo. Não toquei em nada. Rode de novo com --fill "${empty.name}=<texto>" (campo vazio da página: "${empty.name}").`;
}

/** Controles que adicionam ao carrinho/lista. «Comprar» não entra: é compra, tem a trava própria. */
export const ADD_CONTROL = /^(adicionar|add|colocar no carrinho|p[ôo]r no carrinho|incluir)\b/i;
/** O objetivo pede mais de uma unidade: então repetir o «adicionar» é o que se quer. */
const QUANTITY_GOAL = /\b(\d+|dois|duas|tr[êe]s|quatro|cinco|two|three|four|five)\s*(unidades?|vezes|units?|times|c[óo]pias?|pares?|x)\b|\bquantidade\b|\bquantity\b|\bmais uma\b|\bone more\b|\banother\b/i;

/** Qual item um «adicionar» adiciona: o controle, o que vem antes dele (produto e preço) e a página. Pura. */
export function addKey(el: PageElement, page: ParsedPage): string {
  return `${plain(el)}|${el.near ?? ""}|${bareUrl(page.url)}`;
}

/**
 * Este «adicionar» repete um que já foi feito? Só recusa com prova. Neste `act`: o carrinho subiu na primeira vez (a contagem
 * antes e depois, lida da página) para o MESMO item (papel, nome, produto, página). Num `act` anterior (livro-razão da ponte,
 * que não guarda o produto): o controle tem nome único na página (sem gêmeos, senão podia ser outro item) e o carrinho
 * subiu naquela ação, ou a página é a mesma do fim daquele `act` e a ação a mudou. Com um objetivo que pede mais de uma
 * unidade nunca recusa. Devolve o motivo, ou `null`. Pura.
 */
export function repeatedAdd(el: PageElement, page: ParsedPage, goal: string, history: Done[]): string | null {
  if (!ADD_CONTROL.test(el.name.trim()) || QUANTITY_GOAL.test(goal)) return null;
  const key = addKey(el, page);
  const same = history.find((d) => d.add?.key === key);
  if (same?.add) {
    const { cartBefore, cartAfter } = same.add;
    if (cartBefore !== null && cartAfter !== null && cartAfter > cartBefore) {
      return `este item já foi adicionado (o carrinho subiu de ${cartBefore} para ${cartAfter}); adicionar de novo duplicaria`;
    }
  }
  if (twinsOf(page.elements).has(twinKey(el))) return null;
  // Só com a página do fim do `act` anterior (a ponte diz `pageChangedSince === false` na última ação): numa página nova o carrinho pode
  // ter voltado a 0 e o «adicionar» de antes não vale mais (benchmark real, L07/L17: a 2.ª repetição era recusada à toa).
  const priors = history.filter((d) => d.prior);
  if (priors.length === 0 || priors[priors.length - 1].prior!.pageChangedSince !== false) return null;
  const clicked = `clicou ${el.role}${el.name ? ` "${el.name}"` : ""}`;
  const p = [...priors].reverse().find((d) => d.prior!.what.includes(clicked))?.prior;
  if (!p) return null;
  if (p.cartBefore !== null && p.cartAfter !== null && p.cartAfter > p.cartBefore) {
    return `este item já foi adicionado num act anterior deste portal (o carrinho subiu de ${p.cartBefore} para ${p.cartAfter}); adicionar de novo duplicaria`;
  }
  if (p.changed) return "este item já foi adicionado num act anterior e a página é a mesma do fim dele; adicionar de novo duplicaria";
  return null;
}

const CART_GOAL = /carrinho|\bcart\b|sacola|basket|cesta/i;
const EMPTY_GOAL = /\b(vazi[oa]s?|esvazi\w*|empty|sem (nenhum )?(item|itens|produtos?)|zero (item|itens|produtos?)|nenhum (item|produto))\b/i;
const COUNT_GOAL = /\b(\d+|um|uma|dois|duas|tr[êe]s|quatro|cinco|one|two|three|four|five)\s+(item|itens|items|produtos?|products?)\b/i;
const COUNT_WORDS: Record<string, number> = { um: 1, uma: 1, one: 1, dois: 2, duas: 2, two: 2, tres: 3, "três": 3, three: 3, quatro: 4, four: 4, cinco: 5, five: 5 };
const REMOVE_CONTROL = /^(remove|remover|excluir|delete|eliminar|quitar)\b/i;
const COUNT_TEXT = /\b(\d+)\s+(items?|itens|produtos?|products?)\b/i;
const EMPTY_TEXT = /\b(vazi[oa]|empty|0\s+(items?|itens)|nenhum item|no items)\b/i;

/**
 * O Jev disse "acabou": a página desmente? Só para objetivos de carrinho com uma contagem ("1 item") ou um estado ("vazio"):
 * o que o Jev vê é a probabilidade, a página tem o número. Conta os controles "Remover/Remove/Excluir" (um por item) e
 * lê "N itens" do texto. Devolve o que a página mostra de diferente, ou `null` se confere ou não dá para saber. Pura.
 */
export function goalContradiction(goal: string, page: ParsedPage, initial: number | null = null): string | null {
  // Uma página de erro («Desculpe! Algo deu errado») nunca é o objetivo cumprido, a menos que o objetivo fale em erro.
  if (!/\b(erro|error|falha)\b/i.test(goal)) {
    const top = [page.title, ...page.text.slice(0, 8)].find((l) => ERROR_PAGE.test(l));
    if (top) return `a página mostra um erro («${top.slice(0, 80)}»).`;
  }
  if (!CART_GOAL.test(goal)) return null;
  const { removers, saidCount, saysEmpty } = cartFacts(page);
  const wanted = COUNT_GOAL.exec(goal);
  if (wanted) {
    const raw = wanted[1].toLowerCase();
    const n = /^\d+$/.test(raw) ? Number(raw) : COUNT_WORDS[raw];
    if (n === undefined) return null;
    const seen = saidCount ?? (removers > 0 ? removers : null);
    if (seen !== null && seen !== n) return `o objetivo pede ${n} item(ns), mas a página mostra ${seen}.`;
    return null;
  }
  if (EMPTY_GOAL.test(goal)) {
    if (saysEmpty && removers === 0) return null;
    if (removers > 0) return `ainda há ${removers} item(ns) com botão de remover na página.`;
    if (saidCount !== null && saidCount > 0) return `a página ainda mostra ${saidCount} item(ns).`;
    return null;
  }
  // «Remover o produto do carrinho»: não diz quantos sobram, mas a contagem tem de ter caído em relação ao começo.
  if (REMOVE_GOAL.test(goal) && initial !== null && initial > 0) {
    const now = cartCount(page);
    if (now !== null && now >= initial) return `o carrinho ainda tem ${now} item(ns), os mesmos de antes (${initial}): nada foi removido.`;
  }
  return null;
}

const ERROR_PAGE = /algo deu errado|something went wrong|sorry! something|desculpe[,!]|p[áa]gina n[ãa]o encontrada|page not found|access denied|acesso negado|^404\b|\b(502|503) /i;

const REMOVE_GOAL =/\b(remov\w*|remove|exclu\w*|delete|apag\w*|tir\w+)\b/i;

function cartFacts(page: ParsedPage): { removers: number; saidCount: number | null; saysEmpty: boolean } {
  const removers = page.elements.filter((el) => REMOVE_CONTROL.test(el.name.trim())).length;
  const lines = [...page.text, ...page.elements.map((el) => el.name)];
  const said = lines.map((l) => COUNT_TEXT.exec(l)).find((m) => m !== null);
  return { removers, saidCount: said ? Number(said[1]) : null, saysEmpty: lines.some((l) => EMPTY_TEXT.test(l)) };
}

/**
 * Quantos itens o carrinho que está na página tem: o «N itens» do texto, ou os botões de remover (um por item); 0 se diz que
 * está vazio; `null` se a página não parece um carrinho. Pura.
 */
export function cartCount(page: ParsedPage): number | null {
  const { removers, saidCount, saysEmpty } = cartFacts(page);
  if (saidCount !== null) return saidCount;
  if (removers > 0) return removers;
  return saysEmpty ? 0 : null;
}

/** Onde foi o tempo do piloto, em ms (somas por fase): o Jev (consulta), o snapshot, a ação, a espera, a foto. */
export interface Timings {
  jev: number;
  snapshot: number;
  acao: number;
  espera: number;
  foto: number;
  consultas: number;
  fotos: number;
  total: number;
  /** Bytes do corpo enviado em cada consulta, na ordem (a linha TEMPOS que o benchmark lê). */
  bytes: number[];
  /** Tokens (entrada + saída) somados, como o provedor contou. */
  tokens: number;
  /** A latência de cada consulta ao Jev (com as repetições), na ordem; a mediana e o p95 saem daqui. */
  consultaMs: number[];
  /** Repetições ao provedor (429/503/529, conexão) e quanto se esperou por elas, em ms. */
  repeticoes: number;
  esperaRede: number;
  /** A varredura de segredos antes de enviar, somada, em ms. */
  varredura: number;
  /** Consultas sem a pergunta `concluido` (a última ação não mudou a página). */
  semConcluido: number;
}

/** Mediana de uma lista de números (0 se vazia). Pura. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** O percentil `q` (0–1) pelo método do posto mais próximo (0 se vazia). Pura. */
export function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

export const emptyTimings = (): Timings => ({
  jev: 0, snapshot: 0, acao: 0, espera: 0, foto: 0, consultas: 0, fotos: 0, total: 0,
  bytes: [], tokens: 0, consultaMs: [], repeticoes: 0, esperaRede: 0, varredura: 0, semConcluido: 0,
});

export interface PilotResult {
  /** `done`, `stuck`, `unsure`, `off`, `limit`, `error`. */
  outcome: "done" | "stuck" | "unsure" | "off" | "limit" | "error";
  steps: string[];
  note: string;
  finalSnapshot: string;
  timings?: Timings;
  /** Saúde do renderizador da UI durante o `act` (Fase 0.1). */
  window?: WindowStats;
}

/** As mesmas ações, medindo quanto cada fase leva (soma em `t`). Só embrulha: não decide nada. */
export function timed(deps: PilotDeps, t: Timings): PilotDeps {
  const wrap = <A extends unknown[], R>(phase: "snapshot" | "acao" | "espera" | "foto" | "jev", fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      const started = Date.now();
      try { return await fn(...args); } finally { t[phase] += Date.now() - started; }
    };
  return {
    snapshot: wrap("snapshot", deps.snapshot),
    visual: deps.visual && (async (goal, recent) => { t.fotos += 1; return wrap("foto", deps.visual!)(goal, recent); }),
    clickAt: deps.clickAt && wrap("acao", deps.clickAt),
    peekAt: deps.peekAt && wrap("acao", deps.peekAt),
    click: wrap("acao", deps.click),
    type: wrap("acao", deps.type),
    select: wrap("acao", deps.select),
    scroll: wrap("acao", deps.scroll),
    settle: wrap("espera", deps.settle),
    pick: async (query) => {
      t.consultas += 1;
      if (query.skipGoalDone) t.semConcluido += 1;
      const started = Date.now();
      const reply = await wrap("jev", deps.pick)(query);
      t.consultaMs.push(reply.latencyMs ?? Date.now() - started);
      const cost = reply.cost;
      if (cost) {
        t.bytes.push(cost.requestBytes);
        t.tokens += cost.inputTokens + cost.outputTokens;
        t.repeticoes += Math.max(0, cost.attempts - 1);
        t.esperaRede += cost.backoffMs;
        t.varredura += cost.scanMs;
      }
      return reply;
    },
    warm: deps.warm,
    prior: deps.prior,
  };
}

/**
 * O piloto. Uma falha de leitura ou de ação no meio do caminho (a página nova ainda não respondeu) não joga fora o que já foi
 * feito: o relatório sai com os passos até ali e o motivo, em vez de só a mensagem de erro.
 */
export async function runPilot(
  goal: string,
  rawFills: string[],
  maxSteps: number | undefined,
  rawDeps: PilotDeps,
): Promise<PilotResult> {
  const progress: Progress = { startedAt: Date.now(), timings: emptyTimings(), log: [], snapshot: "", history: [] };
  try {
    return await pilotLoop(goal, rawFills, maxSteps, rawDeps, progress);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (progress.log.length === 0) throw e;
    progress.log.push(`falhou: ${message}`);
    return {
      outcome: "error",
      steps: progress.log,
      note: `${message} O que o piloto já fez está nos passos acima; a página pode estar carregando: leia com \`snapshot\` e continue.`,
      finalSnapshot: progress.snapshot,
      timings: { ...progress.timings, total: Date.now() - progress.startedAt },
    };
  }
}

interface Progress { startedAt: number; timings: Timings; log: string[]; snapshot: string; history: Done[] }

async function pilotLoop(
  goal: string,
  rawFills: string[],
  maxSteps: number | undefined,
  rawDeps: PilotDeps,
  progress: Progress,
): Promise<PilotResult> {
  const { startedAt, timings, log } = progress;
  const deps = timed(rawDeps, timings);
  const fills = parseFills(rawFills);
  const limit = Math.min(MAX_STEPS, Math.max(1, Math.round(maxSteps ?? DEFAULT_STEPS)));
  // A conexão com o Jev abre enquanto a primeira página é lida: o handshake não cai no primeiro passo.
  try { deps.warm?.(); } catch { /* só acelera */ }
  // O que os `act` anteriores deste portal fizeram entra no histórico, marcado: o Jev não repete um «adicionar» já feito.
  const history: Done[] = progress.history;
  const taken = new Set<string>();
  let snapshot = await deps.snapshot();
  progress.snapshot = snapshot;
  // Só depois da primeira leitura: é aí que a ponte sabe se a página mudou desde o fim do `act` anterior.
  try {
    // O histórico de um `act` anterior só vale se a página é a MESMA em que ele parou (T5: o segundo `act` na página do carrinho). Se a página
    // mudou (outra navegação, outra tarefa no mesmo portal), «clicou Adicionar» de antes só confunde: o Jev dava o objetivo por feito no passo 1
    // e repetia o último clique de outra tarefa (benchmark real, L01/L08/L13/L17).
    const all = deps.prior?.() ?? [];
    const samePage = all.length > 0 && all[all.length - 1].pageChangedSince === false;
    history.push(...(samePage ? all : []).slice(-HISTORY).map((p) => ({
      what: p.what.replace(/^\[feito num act anterior/, "[earlier run"),
      changed: p.changed, auto: p.auto, earlier: true, prior: p,
    })));
  } catch { /* sem livro-razão */ }
  let lastSignature = "";
  let waits = 0;
  let staleRetries = 0;
  let coveredRetries = 0;
  let noValueRetries = 0;
  let addRefusals = 0;
  /** O «adicionar» que está para ser clicado: o item e a contagem do carrinho antes (a de depois só se sabe depois de reler). */
  let pendingAdd: { key: string; cartBefore: number | null } | null = null;

  const finish = (outcome: PilotResult["outcome"], note: string): PilotResult =>
    ({ outcome, steps: log, note: note + emptyFieldsNote(parseSnapshot(snapshot), fills.length), finalSnapshot: snapshot, timings: { ...timings, total: Date.now() - startedAt } });

  const early = missingFill(goal, fills.length, parseSnapshot(snapshot));
  if (early) {
    log.push(`0. recusou: ${early.split(". ")[0]}`);
    return finish("error", early);
  }
  let contradictions = 0;
  /** Quantos itens o carrinho tinha ao começar (se a página já é um carrinho): «remover» só vale se isso diminuiu. */
  const initialCart = cartCount(parseSnapshot(snapshot));

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
    snapshot = progress.snapshot = await deps.snapshot();
    history.push({ what, changed: fingerprint(parseSnapshot(snapshot)) !== fp });
    photoJustTapped = true;
    return "acted";
  };

  for (let step = 1; step <= limit; step++) {
    const stepStarted = Date.now();
    let page = parseSnapshot(snapshot);
    // O que não é escolha não vai ao Jev: um campo cujo nome casa com um `--fill` recebe o valor direto.
    let filled: string[] = [];
    try {
      filled = await autoFill(page, fills, taken, deps, goal);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Um campo coberto por uma faixa: o Jev a fecha na consulta seguinte e o valor (ainda não gasto) entra depois.
      if (!(/est[áa] coberto por/i.test(message) && coveredRetries < 3)) {
        log.push(`${step}. falhou: ${message}`);
        return finish("error", "O preenchimento falhou; veja o motivo acima e continue você.");
      }
      coveredRetries += 1;
      const what = `tentou preencher um campo, mas falhou: ${message.split(". ")[0].slice(0, 160)}`;
      log.push(`${step}. ${what}`);
      history.push({ what, changed: false, auto: true });
    }
    if (filled.length > 0) {
      const filledEntries: Done[] = [];
      for (const what of filled) {
        const entry: Done = { what, changed: true, auto: true };
        filledEntries.push(entry);
        history.push(entry);
        log.push(`${what} (pelo nome do campo, sem o Jev)`);
      }
      const before = fingerprint(page);
      await deps.settle();
      snapshot = progress.snapshot = await deps.snapshot();
      page = parseSnapshot(snapshot);
      // Uma busca enviada com Enter leva um tempo até a página de resultados existir (a Amazon: segundos): lida cedo demais,
      // a página é a MESMA, o Jev "não tem certeza" e o `act` para com a busca já feita. Espera a rede assentar e relê, até 3 vezes.
      if (filled.some((what) => what.includes("apertou Enter"))) {
        for (let wait = 0; wait < 3 && fingerprint(page) === before; wait++) {
          await deps.settle(true);
          snapshot = progress.snapshot = await deps.snapshot();
          page = parseSnapshot(snapshot);
        }
        // O Enter que não mudou a página não conta como ação que levou ao objetivo (abaixo, `lastDid`).
        if (fingerprint(page) === before) for (const entry of filledEntries) if (entry.what.includes("apertou Enter")) entry.changed = false;
      }
    }

    const query = buildStep(page, goal, fills.map(([key]) => key).filter((key) => !taken.has(key)), history, waits);
    // A pergunta «o objetivo já foi atingido?» só vale depois de uma ação do Jev que mudou a página (abaixo): sem isso a
    // resposta seria jogada fora, e custa uma cabeça a mais por consulta.
    // Uma busca enviada pelo piloto com Enter (campo preenchido pelo nome) que levou a OUTRA página também é uma ação dele: o
    // objetivo «pesquise X» termina ali, e o Jev dizia «acabou» com p=0,72 e o `act` parava «sem certeza» (L04).
    const lastJev = [...history].reverse().find((d) => !d.auto || (d.changed && d.what.includes("apertou Enter")));
    if (!lastJev || lastJev.changed === false) query.skipGoalDone = true;
    const reply = await deps.pick(query);
    if (reply.status !== "ok" || !reply.operation) {
      return finish(reply.status === "off" ? "off" : "error", reply.reason ?? "O Jev não respondeu.");
    }
    const operation = reply.operation;
    // O objetivo já está atingido? Pergunta direta, à parte da operação: depois de acertar (um filtro aplicado, o carrinho
    // vazio) o Jev costuma ficar "sem certeza" da PRÓXIMA operação, mas sabe que acabou. Só vale depois de uma ação dele
    // que mudou a página (os campos preenchidos pelo nome não contam).
    const lastByJev = lastJev;
    // "Acabou" é uma probabilidade; a contagem do carrinho está na página. Se ela desmente, o piloto continua em vez de dar
    // o objetivo por cumprido (duas vezes no máximo: depois devolve a dúvida a quem pediu).
    const doubt = (): "no" | "retry" | "give-up" => {
      const why = goalContradiction(goal, page, initialCart);
      if (!why) return "no";
      contradictions += 1;
      log.push(`${step}. o Jev disse que acabou, mas a página não confere: ${why}`);
      if (contradictions > 2) return "give-up";
      history.push({ what: `conferiu a página e o objetivo ainda não foi atingido: ${why}`, changed: false, auto: true });
      return "retry";
    };
    const unconfirmed = () => finish("unsure", "O Jev disse que o objetivo foi atingido, mas a página não confere (veja acima). Continue você, com `snapshot` e `click`.");
    if (lastByJev && lastByJev.changed !== false && (reply.goalDone ?? 0) >= (lastByJev.auto ? MIN_GOAL_DONE_AFTER_SUBMIT : MIN_GOAL_DONE)) {
      const verdict = doubt();
      if (verdict === "retry") continue;
      if (verdict === "give-up") return unconfirmed();
      log.push(`${step}. objetivo atingido (pergunta direta p=${reply.goalDone!.toFixed(2)})`);
      return finish("done", "O Jev considera o objetivo atingido. Confira na página abaixo.");
    }
    // `fim` = a pergunta direta "o objetivo já foi atingido?": aparece no relatório para o limite poder ser ajustado com dados.
    const meta = `${reply.probability !== null ? `p=${reply.probability.toFixed(2)}` : "p=?"}${reply.goalDone != null ? `, fim p=${reply.goalDone.toFixed(2)}` : ""}${reply.latencyMs !== null ? `, ${reply.latencyMs} ms` : ""}`;
    const ambiguous = operation !== "done" && isAmbiguous(query, operation, reply.target, reply.probability);
    const lowP = reply.probability !== null && reply.probability < MIN_PROBABILITY && operation !== "done";
    if (ambiguous || (lowP && !obviousAdvance(page, operation, reply.target, reply.probability, goal))) {
      const fallback = await visualFallback(page, step);
      if (fallback === "acted") continue;
      if (fallback) log.push(fallback);
      return finish("unsure", ambiguous
        ? `O elemento que o Jev escolheu (${reply.target}) não tem nome e há outros iguais na página: só o texto não os distingue (${meta}). Continue você, com \`snapshot\` e \`click\`, ou ligue a reserva visual em Ajustes → Decisões.`
        : `O Jev não tem certeza do próximo passo (${operation}${reply.target ? ` ${reply.target}` : ""}, ${meta}). Continue você, com \`snapshot\` e \`click\`, ou diga no objetivo a escolha que falta.`
          + (lastByJev?.changed ? " A última ação do piloto mudou a página: o objetivo pode já ter sido atingido, confira antes de continuar." : ""));
    }
    if (operation === "done") {
      // «Acabou» no PRIMEIRO passo, sem o piloto ter feito nada, com p baixa: não é prova (L17: p=0,43 virou «FEITO (não verificado)»).
      if (!lastByJev && (reply.probability ?? 0) < MIN_GOAL_DONE) {
        log.push(`${step}. o Jev disse que acabou antes de qualquer ação, mas sem certeza (${meta})`);
        return finish("unsure", "O Jev disse que o objetivo já está atingido sem nenhuma ação, mas sem certeza. Confira a página e continue você.");
      }
      const verdict = doubt();
      if (verdict === "retry") continue;
      if (verdict === "give-up") return unconfirmed();
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
        if (blockedControl(el, goal)) {
          log.push(`${step}. recusou ${plain(el)}: parece uma compra ou um pagamento, e o objetivo não pediu`);
          return finish("stuck", "O Jev escolheu um controle de compra ou pagamento que o objetivo não pediu: não cliquei. Se é isso mesmo que você quer, diga no objetivo.");
        }
        // Idempotência (4.1/3.4): um «adicionar» que já foi feito (neste `act` ou num anterior) não se repete.
        const repeat = operation === "click" ? repeatedAdd(el, page, goal, history) : null;
        if (repeat) {
          addRefusals += 1;
          lastSignature = "";
          log.push(`${step}. recusou ${plain(el)}: ${repeat}`);
          if (addRefusals > 2) return finish("unsure", `O Jev insiste em adicionar de novo um item que já foi adicionado (${repeat}). Confira a página.`);
          history.push({ what: `não clicou ${plain(el)}: ${repeat}`, changed: false, auto: true });
          continue;
        }
        pendingAdd = operation === "click" && ADD_CONTROL.test(el.name.trim()) ? { key: addKey(el, page), cartBefore: cartCount(page) } : null;
        what = await act(el, operation, fills, taken, deps, option, { page, goal });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Uma referência que a página já não tem (ela recarregou entre a leitura e o toque): relê e decide de novo.
      if (/tire um novo snapshot|n[ãa]o est[áa] mais na p[áa]gina/i.test(message) && staleRetries < 2) {
        staleRetries += 1;
        lastSignature = "";
        log.push(`${step}. a página mudou antes do toque; li de novo`);
        await deps.settle();
        snapshot = progress.snapshot = await deps.snapshot();
        continue;
      }
      // Sem valor de --fill para o campo que o Jev escolheu: ele vê isso no histórico e escolhe outra coisa (um botão, outro campo).
      if (/n[ãa]o h[áa] valor para/i.test(message) && noValueRetries < 2) {
        noValueRetries += 1;
        const what = `tentou digitar em ${reply.target ?? "um campo"}, mas ${message.slice(0, 160)}`;
        log.push(`${step}. ${what}`);
        history.push({ what, changed: false });
        continue;
      }
      // Um controle coberto (a faixa de cookies, o modal) não é o fim: o Jev vê a falha no histórico e escolhe fechar o que está na frente.
      if (/est[áa] coberto por/i.test(message) && coveredRetries < 3) {
        coveredRetries += 1;
        // O Jev ainda não tinha visto a falha ao escolher o controle coberto: na PRIMEIRA vez, escolher o mesmo de novo não é girar em
        // círculos (L05: a segunda escolha foi e1 outra vez e o act parou). Na segunda, sim.
        if (coveredRetries === 1) lastSignature = "";
        const what = `tentou tocar em ${reply.target ?? "um elemento"}, mas falhou: ${message.split(". ")[0].slice(0, 160)}`;
        log.push(`${step}. ${what}`);
        history.push({ what, changed: false });
        continue;
      }
      log.push(`${step}. falhou: ${message}`);
      return finish("error", "A ação falhou; veja o motivo acima e continue você.");
    }
    if (operation !== "wait") waits = 0;
    photoJustTapped = false;
    log.push(`${step}. ${what} (${meta}, passo ${Date.now() - stepStarted} ms)`);
    await deps.settle();
    snapshot = progress.snapshot = await deps.snapshot();
    const after = parseSnapshot(snapshot);
    history.push({
      what,
      changed: fingerprint(after) !== fingerprint(page),
      ...(pendingAdd ? { add: { ...pendingAdd, cartAfter: cartCount(after) } } : {}),
    });
    pendingAdd = null;
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
  goal = "",
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
    out.push(await act(best, operationOf(best), fills, taken, deps, undefined, { page, goal }));
  }
  return out;
}

/** Um campo de busca? Digitar nele e apertar Enter é o gesto de pesquisar; a lupa ao lado costuma não ter nome. Pura. */
export function isSearchField(el: PageElement): boolean {
  return el.role === "searchbox" || /busca|pesquis|procur|search|\b(q|query)\b/i.test(el.name);
}

/**
 * Digitar neste campo aperta Enter? Só numa busca, e nunca com um controle de compra ou pagamento à vista que o objetivo
 * não pediu: ali o Enter poderia enviar o formulário de fechamento sem passar pela trava dos cliques. Pura.
 */
export function submitsOnType(el: PageElement, page: ParsedPage | undefined, goal: string): boolean {
  if (!isSearchField(el)) return false;
  // «Pesquise por fone e escolha a sugestão «fone bluetooth»»: o Enter enviaria «fone» antes de a sugestão aparecer (N06).
  if (SUGGEST_GOAL.test(goal)) return false;
  return !page?.elements.some((other) => blockedControl(other, goal));
}

/** O objetivo manda ESCOLHER uma sugestão da lista de autocompletar: digitar não pode enviar a busca. */
const SUGGEST_GOAL = /sugest|suggest|autocomplet/i;

/** Faz o que a operação pede no elemento e conta o que fez, sem o valor digitado. */
async function act(el: PageElement, operation: string, fills: [string, string][], taken: Set<string>, deps: PilotDeps, option?: string, where?: { page: ParsedPage; goal: string }): Promise<string> {
  if (operation === "select" && option !== undefined) {
    await deps.select(el.ref, option);
    return `escolheu "${option}" em ${plain(el)}`;
  }
  if (operation === "type" || operation === "select") {
    const entry = valueFor(el.name, fills, taken);
    if (!entry) throw new Error(`não há valor para ${plain(el)}: passe --fill "<campo>=<valor>"`);
    const submit = operation === "type" && submitsOnType(el, where?.page, where?.goal ?? "");
    if (operation === "select") await deps.select(el.ref, entry[1]);
    else await deps.type(el.ref, entry[1], submit);
    // O valor só fica gasto depois de digitado: um campo coberto por uma faixa falha e o valor volta a valer.
    taken.add(entry[0]);
    return `${operation === "select" ? "escolheu em" : "digitou em"} ${plain(el)} (valor de ${entry[0]})${submit ? " e apertou Enter" : ""}`;
  }
  // Um link com destino leva a outra página: o piloto espera ela carregar antes de reler (senão "conclui" olhando a antiga).
  const navigates = el.role === "link" && !!el.href && !/^(javascript:|#)/i.test(el.href);
  await deps.click(el.ref, navigates);
  return `clicou ${plain(el)}`;
}

/**
 * As consultas ao Jev numa linha legível: quantas, latência (mediana e p95), bytes e tokens. É o que o plano v2 (4.2) mede:
 * a meta é mediana ≤ 450 ms por consulta. Pura.
 */
export function queriesLine(t: Timings): string {
  if (t.consultas === 0) return "CONSULTAS: nenhuma";
  const parts = [
    `${t.consultas} consulta(s)`,
    t.consultaMs.length > 0 ? `latência mediana ${median(t.consultaMs)} ms, p95 ${percentile(t.consultaMs, 0.95)} ms` : null,
    t.bytes.length > 0 ? `corpo mediano ${median(t.bytes)} B (máx ${Math.max(...t.bytes)} B)` : null,
    t.tokens > 0 ? `${t.tokens} tokens` : null,
    t.semConcluido > 0 ? `${t.semConcluido} sem a pergunta de fim` : null,
    t.repeticoes > 0 ? `${t.repeticoes} repetição(ões) ao provedor (${t.esperaRede} ms de espera)` : null,
    t.varredura > 0 ? `varredura de segredos ${t.varredura} ms` : null,
  ].filter((part): part is string => part !== null);
  return `CONSULTAS: ${parts.join(" · ")}`;
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
    result.timings ? `\n${queriesLine(result.timings)}\nTEMPOS: ${JSON.stringify(result.timings)}` : "",
    result.window ? `${windowLine(result.window)}\nJANELA: ${JSON.stringify(result.window)}` : "",
    "\nA página agora (o Jev só escolhe onde tocar: confira o resultado):",
    result.finalSnapshot.length > 6000 ? `${result.finalSnapshot.slice(0, 6000)}\n…` : result.finalSnapshot,
  ].filter(Boolean).join("\n");
}
