/**
 * O piloto do navegador: `ags portal act <portal> "objetivo"`.
 *
 * Um agente que navega com `snapshot` + `click` gasta um turno de um modelo grande por clique: ler a árvore da
 * página inteira, pensar, tocar, repetir. Quase todo clique é uma ESCOLHA entre poucos elementos ("qual destes
 * leva ao objetivo?"), e é para isso que serve o Jev (decisões tipadas, ≤19 opções, centenas de milissegundos).
 *
 * O laço, a cada passo:
 *
 *   1. `snapshot` da página → elementos tocáveis (cada um com seu ref) e o texto visível;
 *   2. os 15 elementos mais ligados ao objetivo + `done` / `scroll` / `stuck` viram as opções da pergunta;
 *   3. o Jev escolhe uma (com a probabilidade); abaixo do mínimo, PARA e devolve a página ao agente;
 *   4. a escolha vira uma ação (`click`, `type` com o valor de `--fill`, `select`, `scroll`).
 *
 * O Jev só escolhe ONDE tocar. O texto digitado vem sempre de `--fill` (campo=valor) — nunca vai ao provedor, só
 * os nomes dos campos — e quem pediu confere o resultado na página que volta no fim.
 *
 * Tudo aqui é puro (a página, o Jev e as ações entram por `PilotDeps`), então o laço é testável sem navegador.
 */

export interface PageElement {
  ref: string;
  role: string;
  name: string;
  states: string[];
}

export interface ParsedPage {
  title: string;
  url: string;
  elements: PageElement[];
  /** O texto visível, em linhas curtas, na ordem da página. */
  text: string[];
}

const NODE = /^\s*- (\S+)(?: ("(?:[^"\\]|\\.)*"))?(.*)$/;
const REF = /\[ref=(e\d+)\]/;
const STATE = /\[([^\]=]+)\]/g;
const HEADER = /^page: (?:("(?:[^"\\]|\\.)*") )?(\S+)/;

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
    const node = NODE.exec(line);
    if (!node) continue;
    const [, role, quoted, rest] = node;
    const name = unquote(quoted);
    const ref = REF.exec(rest)?.[1];
    if (ref) {
      // O valor e o destino de um link vêm depois dos estados: cortá-los evita ler um `[` de dentro de um valor.
      const flags = rest.replace(REF, "").split(" value=")[0].split(" → ")[0];
      const states = [...flags.matchAll(STATE)].map((m) => m[1]);
      page.elements.push({ ref, role, name, states });
    } else if (role === "text" && name) {
      page.text.push(name);
    }
  }
  return page;
}

// ── Opções ──────────────────────────────────────────────────────────

export interface StepOption {
  id: string;
  label: string;
}

const ROLE_LABEL: Record<string, string> = {
  button: "botão", link: "link", textbox: "campo de texto", searchbox: "campo de busca", textarea: "campo de texto",
  combobox: "lista de opções", listbox: "lista de opções", checkbox: "caixa de marcar", radio: "opção", switch: "chave",
  tab: "aba", menuitem: "item de menu", option: "opção", clickable: "elemento clicável", slider: "controle", spinbutton: "campo numérico",
};

const TYPING = new Set(["textbox", "searchbox", "textarea", "spinbutton"]);
const CHOOSING = new Set(["combobox", "listbox"]);

/** Quantos elementos entram na pergunta: o limite do Jev (19) menos as três opções fixas. */
export const MAX_ELEMENTS = 15;

const FIXED: StepOption[] = [
  { id: "done", label: "o objetivo já foi atingido: a página mostra o resultado" },
  { id: "scroll", label: "rolar a página para baixo para ver mais elementos" },
  { id: "stuck", label: "nenhuma destas opções leva ao objetivo" },
];

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

/** O que já foi feito neste laço: o ref e a descrição, para não repetir nem dar voltas. */
export interface Done {
  ref: string;
  /** "clicou botão "Entrar"". */
  what: string;
}

function labelOf(el: PageElement): string {
  return `${ROLE_LABEL[el.role] ?? el.role}${el.name ? ` "${el.name}"` : ""}${el.states.includes("checked") ? " [marcada]" : ""}`;
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

const TEXT_BYTES = 1200;

/**
 * A pergunta de um passo: o estado (objetivo, página, o já feito, o texto visível) e as opções. Os campos a
 * preencher entram só pelo NOME. Pura.
 */
export function buildStep(
  page: ParsedPage,
  goal: string,
  fillKeys: string[],
  done: Done[],
): { state: string; options: StepOption[] } {
  const wanted = words(`${goal} ${fillKeys.join(" ")}`);
  const used = new Set(done.map((d) => d.ref));
  const seenLabels = new Set<string>();
  const candidates = page.elements
    .map((el, index) => ({ el, index, label: labelOf(el) }))
    .filter(({ el, label }) => {
      if (el.states.includes("disabled") || used.has(el.ref) || seenLabels.has(label)) return false;
      seenLabels.add(label);
      return true;
    })
    .map((c) => ({
      ...c,
      // Um campo de texto só vale pontos se ainda há o que preencher.
      score: (overlap(wanted, words(c.el.name)) + fillKeys.filter((key) => similarity(c.el.name, key) > 0).length) * 2 + (TYPING.has(c.el.role) && fillKeys.length > 0 ? 1 : 0),
    }));
  const top = [...candidates].sort((a, b) => b.score - a.score || a.index - b.index).slice(0, MAX_ELEMENTS);
  // Na ordem da página: é como uma pessoa lê, e ajuda o Jev a ver o fluxo.
  top.sort((a, b) => a.index - b.index);
  const options: StepOption[] = [...top.map((c) => ({ id: c.el.ref, label: c.label })), ...FIXED];

  const text: string[] = [];
  let bytes = 0;
  for (const line of page.text) {
    if (bytes + line.length > TEXT_BYTES) break;
    text.push(line);
    bytes += line.length + 1;
  }
  const state = [
    `OBJETIVO: ${goal}`,
    fillKeys.length > 0 ? `CAMPOS A PREENCHER (os valores já estão com o agente): ${fillKeys.join(", ")}` : null,
    `PÁGINA: ${page.title ? `"${page.title}" ` : ""}${bareUrl(page.url)}`,
    done.length > 0 ? `JÁ FEITO: ${done.map((d, i) => `${i + 1}. ${d.what}`).join(" · ")}` : null,
    text.length > 0 ? `TEXTO DA PÁGINA: ${text.join(" | ")}` : null,
  ].filter((part): part is string => part !== null).join("\n");
  return { state, options };
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
  choice: string | null;
  probability: number | null;
  reason: string | null;
  latencyMs: number | null;
}

export interface PilotDeps {
  snapshot: () => Promise<string>;
  click: (ref: string) => Promise<unknown>;
  type: (ref: string, text: string) => Promise<unknown>;
  select: (ref: string, value: string) => Promise<unknown>;
  scroll: () => Promise<unknown>;
  /** Espera a página assentar depois de uma ação (nunca lança). */
  settle: () => Promise<void>;
  pick: (state: string, options: StepOption[]) => Promise<StepReply>;
}

/** Abaixo disto o Jev não está seguro: o piloto para e devolve a página ao agente. */
export const MIN_PROBABILITY = 0.45;
export const DEFAULT_STEPS = 8;
export const MAX_STEPS = 15;

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
  const done: Done[] = [];
  const log: string[] = [];
  const taken = new Set<string>();
  let snapshot = await deps.snapshot();
  let lastSignature = "";

  const finish = (outcome: PilotResult["outcome"], note: string): PilotResult =>
    ({ outcome, steps: log, note, finalSnapshot: snapshot });

  for (let step = 1; step <= limit; step++) {
    const page = parseSnapshot(snapshot);
    const { state, options } = buildStep(page, goal, fills.map(([key]) => key).filter((key) => !taken.has(key)), done);
    const reply = await deps.pick(state, options);
    if (reply.status !== "ok" || !reply.choice) {
      return finish(reply.status === "off" ? "off" : "error", reply.reason ?? "O Jev não respondeu.");
    }
    const meta = `${reply.probability !== null ? `p=${reply.probability.toFixed(2)}` : "p=?"}${reply.latencyMs !== null ? `, ${reply.latencyMs} ms` : ""}`;
    if (reply.probability !== null && reply.probability < MIN_PROBABILITY && reply.choice !== "done") {
      return finish("unsure", `O Jev não tem certeza do próximo passo (${reply.choice}, ${meta}). Continue você, com \`snapshot\` e \`click\`.`);
    }
    if (reply.choice === "done") {
      log.push(`${step}. concluído (${meta})`);
      return finish("done", "O Jev considera o objetivo atingido. Confira na página abaixo.");
    }
    if (reply.choice === "stuck") {
      log.push(`${step}. sem caminho (${meta})`);
      return finish("stuck", "O Jev não viu nenhuma opção que leve ao objetivo. Continue você, ou descreva melhor o objetivo.");
    }

    // Girar em círculos: a mesma escolha na mesma página, duas vezes seguidas.
    const signature = `${bareUrl(page.url)}|${reply.choice}|${page.elements.length}`;
    if (signature === lastSignature) {
      return finish("stuck", "O mesmo passo se repetiu sem mudar a página. Continue você.");
    }
    lastSignature = signature;

    try {
      if (reply.choice === "scroll") {
        await deps.scroll();
        log.push(`${step}. rolou a página (${meta})`);
      } else {
        const el = page.elements.find((e) => e.ref === reply.choice);
        if (!el) return finish("error", `O Jev escolheu ${reply.choice}, que não está na página.`);
        const what = await act(el, fills, taken, deps);
        done.push({ ref: el.ref, what });
        log.push(`${step}. ${what} (${meta})`);
      }
    } catch (e) {
      log.push(`${step}. falhou: ${e instanceof Error ? e.message : String(e)}`);
      return finish("error", "A ação falhou; veja o motivo acima e continue você.");
    }
    await deps.settle();
    snapshot = await deps.snapshot();
  }
  return finish("limit", `Cheguei ao limite de ${limit} passos sem o Jev dizer que terminou. Confira a página e continue, ou rode de novo.`);
}

/** Faz o que o elemento pede e conta o que fez, sem o valor digitado. */
async function act(el: PageElement, fills: [string, string][], taken: Set<string>, deps: PilotDeps): Promise<string> {
  if (TYPING.has(el.role) || CHOOSING.has(el.role)) {
    const entry = valueFor(el.name, fills, taken);
    if (!entry) {
      // Um campo sem valor: clicar (abrir a lista, focar) é o máximo que dá para fazer sem inventar um texto.
      if (CHOOSING.has(el.role)) { await deps.click(el.ref); return `abriu ${labelOf(el)}`; }
      throw new Error(`não há valor para ${labelOf(el)}: passe --fill "<campo>=<valor>"`);
    }
    taken.add(entry[0]);
    if (CHOOSING.has(el.role)) await deps.select(el.ref, entry[1]);
    else await deps.type(el.ref, entry[1]);
    return `${CHOOSING.has(el.role) ? "escolheu em" : "digitou em"} ${labelOf(el)} (valor de ${entry[0]})`;
  }
  await deps.click(el.ref);
  return `clicou ${labelOf(el)}`;
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
