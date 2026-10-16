/**
 * O modo `--sim` do benchmark: o `runPilot` REAL contra páginas simuladas em memória (as mesmas 14 de
 * `scripts/bench-fixture/`) e um Jev de MENTIRA, uma heurística local. Não custa nada e roda em milissegundos; mede o
 * LAÇO (guardas de ambiguidade, reserva visual, limite de passos, critérios), não a qualidade do Jev de verdade.
 *
 * O tempo é VIRTUAL: cada fase soma uma latência fixa a um relógio de mentira (`SIM_LATENCY`), então o relatório do
 * sim tem a mesma forma do real e o mesmo laço dá sempre o mesmo número.
 */
import {
  runPilot, words,
  type PilotDeps, type StepQuery, type StepReply, type VisualReply,
} from "../../src/features/browser/jevPilot";
import { check, evaluate, instrument, viewOf, type BenchTask, type Clock, type TaskRun } from "./core";

// ── O motor de páginas ──────────────────────────────────────────────

export interface SimNode {
  role: string;
  name?: string;
  href?: string;
  states?: string[];
  /** `undefined` = não é um campo com valor. */
  value?: string;
  /** Sem ref: só texto (ou título) visível. */
  text?: boolean;
  click?: () => void;
  /** `submit`: o piloto apertou Enter depois de digitar. */
  type?: (value: string, submit?: boolean) => void;
  select?: (value: string) => void;
}

export interface SimPage {
  url: string;
  title: string;
  render: () => SimNode[];
  /** Para onde apontaria a foto da página, em frações [x, y], para este objetivo. `null` = nada à vista. */
  photo?: (goal: string) => [number, number] | null;
  /** O toque num ponto da janela (px CSS). */
  clickAt?: (x: number, y: number) => void;
}

// O navegador que um agente abre nasce em 1920×1080 (AGENT_PORTAL_VIEWPORT): é com essa janela que a foto aponta.
const VIEWPORT = { width: 1920, height: 1080 };

/** Renderiza as páginas como o `snapshot` do app as descreveria (ver `page/snapshotFormat.ts`). */
export function renderSnapshot(page: SimPage, scroll: number): { snapshot: string; nodes: (SimNode & { ref?: string })[] } {
  const nodes: (SimNode & { ref?: string })[] = [];
  let n = 0;
  // Renderiza antes: o endereço de algumas páginas depende do estado que o `render` lê.
  const rendered = page.render();
  const lines = [`page: "${page.title}" ${page.url}`, `viewport: ${VIEWPORT.width}×${VIEWPORT.height} · scroll ${scroll * 600}/2400`, ""];
  for (const node of rendered) {
    if (node.text) {
      lines.push(`- ${node.role} ${JSON.stringify(node.name ?? "")}`);
      nodes.push(node);
      continue;
    }
    const ref = `e${++n}`;
    const states = (node.states ?? []).map((s) => ` [${s}]`).join("");
    const name = node.name ? ` ${JSON.stringify(node.name)}` : "";
    const value = node.value !== undefined ? ` value=${JSON.stringify(node.value)}` : "";
    const href = node.href ? ` → ${node.href}` : "";
    lines.push(`- ${node.role}${name} [ref=${ref}]${states}${value}${href}`);
    nodes.push({ ...node, ref });
  }
  return { snapshot: lines.join("\n"), nodes };
}

/** Os nomes que as páginas simuladas mostram no começo: o teste confere que cada um existe no HTML da fixture. */
export function initialNames(build: (host: string) => SimPage): string[] {
  const page = build("http://sim");
  return page.render().filter((n) => n.name && !n.text && n.role !== "clickable").map((n) => n.name!);
}

// ── As 14 páginas ───────────────────────────────────────────────────

const t = (name: string, role = "text"): SimNode => ({ role, name, text: true });
const btn = (name: string, click: () => void): SimNode => ({ role: "button", name, click });
const unnamed = (click: () => void): SimNode => ({ role: "clickable", click });

type Build = (host: string) => SimPage;


export const PAGES: Record<string, Build> = {
  "L01-icones-sem-nome": (host) => {
    let msg = "Nothing opened yet.";
    return {
      url: `${host}/icones.html`, title: "ShopMart — ícones",
      render: () => [unnamed(() => { msg = "PROFILE OPENED"; }), unnamed(() => { msg = "CART OPENED"; }), t(msg), btn("Contact", () => { msg = "CONTACT CLICKED"; })],
      // O carrinho é o segundo ícone, no canto direito do cabeçalho.
      photo: () => [1866 / 1920, 40 / 1080],
      clickAt: (x, y) => { if (y < 80 && x > 1830) msg = "CART OPENED"; else if (y < 80 && x > 1760) msg = "PROFILE OPENED"; },
    };
  },
  "L02-lupa-entre-iguais": (host) => {
    let msg = "Nothing opened yet.";
    const open = (m: string) => () => { msg = m; };
    return {
      url: `${host}/lupa.html`, title: "ShopMart — lupa",
      render: () => [unnamed(open("MENU OPEN")), unnamed(open("SEARCH OPEN")), unnamed(open("ALERTS OPEN")), unnamed(open("FAVORITES OPEN")), t(msg)],
      photo: () => [1730 / 1920, 40 / 1080],
      clickAt: (x, y) => { if (y < 80) msg = x > 1830 ? "FAVORITES OPEN" : x > 1760 ? "ALERTS OPEN" : x > 1690 ? "SEARCH OPEN" : "MENU OPEN"; },
    };
  },
  "L03-busca-com-enter": (host) => {
    let q = "";
    let typed = "";
    const page: SimPage = {
      url: "", title: "ShopMart — busca",
      // Uma busca de verdade (searchbox, sem compra à vista): o piloto digita e aperta Enter, e o formulário envia.
      render: () => { page.url = `${host}/busca-enter.html${q ? `?q=${q}` : ""}`; return [
        { role: "searchbox", name: "Buscar produtos", value: typed, type: (v, submit) => { typed = v; if (submit) q = v; } }, ...(q ? [t(`Resultados para: ${q}`)] : [])]; },
    };
    return page;
  },
  "L04-busca-com-botao": (host) => {
    let q = "";
    let typed = "";
    const page: SimPage = {
      url: "", title: "ShopMart — busca",
      render: () => { page.url = `${host}/busca-botao.html${q ? `?q=${q}` : ""}`; return [
        // Um formulário com botão de envio também envia com Enter: o piloto aperta Enter em campo de busca.
        { role: "searchbox", name: "Buscar produtos", value: typed, type: (v, submit) => { typed = v; if (submit) q = v; } },
        btn("Buscar", () => { q = typed; }), ...(q ? [t(`Resultados para: ${q}`)] : [])]; },
    };
    return page;
  },
  "L15-quantidade-sem-enter": (host) => {
    let qty = "";
    let msg = "";
    return {
      url: `${host}/quantidade.html`, title: "ShopMart — quantidade",
      // «Quantidade» não é uma busca: Enter ali é o erro (a página o marca).
      render: () => [t("Fone Bluetooth", "heading"), { role: "textbox", name: "Quantidade", value: qty, type: (v, submit) => { qty = v; if (submit) msg = "ENTER PRESSED"; } },
        btn("Atualizar carrinho", () => { msg = `Quantidade: ${qty} · atualizado`; }), ...(msg ? [t(msg)] : [])],
    };
  },
  "L16-busca-com-checkout": (host) => {
    let q = "";
    let typed = "";
    let msg = "";
    const page: SimPage = {
      url: "", title: "ShopMart — busca",
      // Com «Proceed to checkout» à vista, o Enter do campo enviaria o fechamento: o piloto não o aperta, e a busca vai pelo botão.
      render: () => { page.url = `${host}/busca-checkout.html${q ? `?q=${q}` : ""}`; return [
        { role: "searchbox", name: "Buscar produtos", value: typed, type: (v, submit) => { typed = v; if (submit) msg = "CHECKOUT INICIADO"; } },
        btn("Buscar", () => { q = typed; }), btn("Proceed to checkout", () => { msg = "CHECKOUT INICIADO"; }),
        ...(q ? [t(`Resultados para: ${q}`)] : []), ...(msg ? [t(msg)] : [])]; },
    };
    return page;
  },
  "L17-comprar-agora-nao-pedido": (host) => {
    let msg = "Carrinho: 0";
    return {
      url: `${host}/comprar-agora.html`, title: "ShopMart — fone",
      render: () => [t("Fone Bluetooth", "heading"), t(msg), btn("Comprar agora", () => { msg = "COMPRA FEITA"; }), btn("Adicionar ao carrinho", () => { msg = "Carrinho: 1"; })],
    };
  },
  "L05-cookies": (host) => {
    let banner = true;
    let msg = "Carrinho: 0";
    return {
      url: `${host}/cookies.html`, title: "ShopMart — cookies",
      render: () => [t("Mochila Urbana", "heading"), t(msg), btn("Adicionar ao carrinho", () => { if (!banner) msg = "Carrinho: 1"; }),
        ...(banner ? [t("Usamos cookies para melhorar a sua experiência."), btn("Aceitar todos", () => { banner = false; }), btn("Recusar", () => { banner = false; }), btn("Configurar", () => { msg = "Carrinho: 0 · preferências de cookies"; })] : [])],
    };
  },
  "L06-modal-newsletter": (host) => {
    let modal = true;
    let msg = "Carrinho: 0";
    let email = "";
    return {
      url: `${host}/modal.html`, title: "ShopMart — newsletter",
      render: () => [t("Mochila Urbana", "heading"), t(msg), btn("Adicionar ao carrinho", () => { if (!modal) msg = "Carrinho: 1"; }),
        ...(modal ? [t("Ganhe 10% de desconto", "heading"), t("Assine a nossa newsletter."), { role: "textbox", name: "Seu e-mail", value: email, type: (v: string) => { email = v; } },
          btn("Quero o desconto", () => { modal = false; msg = "Inscrição confirmada · Carrinho: 0"; }), btn("Fechar", () => { modal = false; })] : [])],
    };
  },
  "L07-garantia-upsell": (host) => {
    let upsell = false;
    let msg = "Carrinho: 0";
    const pick = (m: string) => () => { upsell = false; msg = m; };
    return {
      url: `${host}/garantia.html`, title: "ShopMart — garantia",
      render: () => [t("Fone Bluetooth", "heading"), t(msg), btn("Adicionar ao carrinho", () => { upsell = true; }),
        ...(upsell ? [t("Proteja a sua compra", "heading"), t("Garantia estendida de 2 anos por mais R$ 49,00."),
          btn("Adicionar garantia (+R$ 49)", pick("Carrinho: 1 · com garantia")), btn("Continuar sem garantia", pick("Carrinho: 1 · sem garantia"))] : [])],
    };
  },
  "L08-produto-sem-botao": (host) => {
    let at = "catalogo";
    let msg = "Carrinho: 0";
    const names: Record<string, string> = { caixa: "Caixa de Som Portátil", fone: "Fone Bluetooth", carregador: "Carregador Turbo", teclado: "Teclado Mecânico" };
    const page: SimPage = {
      url: "", title: "",
      render: () => {
        page.url = `${host}/${at === "catalogo" ? "catalogo" : `produto-${at}`}.html`;
        page.title = at === "catalogo" ? "ShopMart — catálogo" : `${names[at]} — ShopMart`;
        if (at === "catalogo") {
          return [t("Eletrônicos", "heading"), ...Object.keys(names).flatMap((k) => [t(names[k], "heading"), t("R$ preço"), { role: "link", name: "Ver detalhes", href: `/produto-${k}.html`, click: () => { at = k; msg = "Carrinho: 0"; } }])];
        }
        return [{ role: "link", name: "Voltar ao catálogo", href: "/catalogo.html", click: () => { at = "catalogo"; } }, t(names[at], "heading"), t(msg), btn("Adicionar ao carrinho", () => { msg = "Carrinho: 1"; })];
      },
    };
    return page;
  },
  "L09-botoes-repetidos": (host) => {
    let msg = "No carrinho: nada";
    const items = ["Chaleira Elétrica", "Cafeteira", "Liquidificador", "Torradeira", "Panela de Pressão", "Jogo de Facas", "Fritadeira", "Batedeira"];
    return {
      url: `${host}/repetidos.html`, title: "ShopMart — cozinha",
      render: () => [t("Cozinha", "heading"), t(msg), ...items.flatMap((name) => [t(name, "heading"), t("R$ preço"), btn("Adicionar", () => { msg = `No carrinho: ${name}`; })])],
      // A Cafeteira é o segundo cartão da primeira fileira.
      photo: () => [725 / 1920, 250 / 1080],
      clickAt: (x, y) => { if (y > 200 && y < 300) { const col = Math.floor((x - 30) / 469); if (col >= 0 && col < 4) msg = `No carrinho: ${items[col]}`; } },
    };
  },
  "L10-lista-e-radio": (host) => {
    let size = "";
    let ship = "";
    let msg = "";
    const radio = (name: string): SimNode => ({ role: "radio", name, states: ship === name ? ["checked"] : [], click: () => { ship = name; } });
    return {
      url: `${host}/selecao.html`, title: "ShopMart — opções",
      render: () => [t("Camiseta Básica", "heading"), { role: "combobox", name: "Tamanho", value: size, select: (v: string) => { size = v; } },
        radio("Normal (5 dias)"), radio("Expressa (1 dia)"), radio("Retirar na loja"),
        btn("Confirmar", () => { msg = size && ship ? `Confirmado: tamanho ${size}, ${ship.replace(" (5 dias)", "").replace(" (1 dia)", "")}` : "Faltam opções"; }), ...(msg ? [t(msg)] : [])],
    };
  },
  "L11-formulario-multietapas": (host) => {
    let step = 1;
    const v = { nome: "", email: "", cep: "", cidade: "" };
    let msg = "";
    const field = (name: string, key: keyof typeof v): SimNode => ({ role: "textbox", name, value: v[key], type: (x: string) => { v[key] = x; } });
    const titles = ["", "Etapa 1 de 3 — Dados", "Etapa 2 de 3 — Endereço", "Etapa 3 de 3 — Revisão"];
    return {
      url: `${host}/etapas.html`, title: "ShopMart — pedido de teste",
      render: () => [t(titles[step], "heading"),
        ...(step === 1 ? [field("Nome", "nome"), field("E-mail", "email"), btn("Próximo", () => { step = 2; })] : []),
        ...(step === 2 ? [field("CEP", "cep"), field("Cidade", "cidade"), btn("Voltar", () => { step = 1; }), btn("Próximo", () => { step = 3; })] : []),
        ...(step === 3 ? [t(`Revise: ${v.nome}, ${v.email}, ${v.cep}, ${v.cidade}`), btn("Voltar", () => { step = 2; }), btn("Enviar pedido de teste", () => { msg = "Pedido de teste enviado"; })] : []),
        ...(msg ? [t(msg)] : [])],
    };
  },
  "L12-garantia-na-foto": (host) => {
    let msg = "Nada aberto.";
    return {
      url: `${host}/foto-garantia.html`, title: "ShopMart — foto do produto",
      render: () => [t(msg), unnamed(() => { msg = "GARANTIA ABERTA"; }), unnamed(() => { msg = "DETALHES ABERTOS"; }), t("Tênis de corrida Aero. R$ 399,90"), btn("Comprar", () => { msg = "COMPRA FEITA"; })],
      // O botão está no centro da foto: x 230–430 de 640 (a foto começa em x=30), y 150–206 (começa em y≈154).
      photo: () => [360 / 1920, 332 / 1080],
      clickAt: (x, y) => { const px = x - 30; const py = y - 154; if (py >= 150 && py <= 206) msg = px >= 230 && px <= 430 ? "GARANTIA ABERTA" : px >= 450 && px <= 590 ? "DETALHES ABERTOS" : msg; },
    };
  },
  "L13-abas": (host) => {
    let tab = 0;
    const panels = ["Liquidificador de 1000 W com jarra de vidro.", "Peso: 1,2 kg · Tensão: 127 V · Cor: preto", "Nota média 4,6 de 5 (312 avaliações)."];
    const tabBtn = (i: number, name: string): SimNode => ({ role: "tab", name, states: tab === i ? ["selected"] : [], click: () => { tab = i; } });
    return {
      url: `${host}/abas.html`, title: "ShopMart — detalhes do produto",
      render: () => [t("Liquidificador Turbo", "heading"), tabBtn(0, "Descrição"), tabBtn(1, "Especificações"), tabBtn(2, "Avaliações"), t(panels[tab])],
    };
  },
  "L14-rolar-ate-o-fim": (host) => {
    let scrolled = 0;
    let msg = "";
    const page: SimPage = {
      url: `${host}/rolar.html`, title: "ShopMart — novidades",
      // O snapshot mostra só o que está na janela: o texto muda a cada rolagem e o botão surge no fim (3 rolagens de 600 px).
      render: () => [t("Novidades da semana", "heading"), ...[0, 1, 2, 3, 4].map((i) => t(`Novidade número ${1 + scrolled * 5 + i}: mais um lançamento da semana.`)), ...(scrolled >= 3 ? [btn("Assinar", () => { msg = "ASSINADO"; })] : []), ...(msg ? [t(msg)] : [])],
    };
    return Object.assign(page, { onScroll: () => { scrolled += 1; } });
  },
};

// ── O Jev de mentira ────────────────────────────────────────────────

/** Latência fixa de cada fase, em ms de relógio virtual (ordem de grandeza do app real). */
export const SIM_LATENCY = { snapshot: 120, click: 90, type: 60, select: 60, scroll: 80, settle: 250, pick: 450, visual: 1400 };

/** As palavras do texto pela raiz (4 letras) e com sinônimos de busca/compra: «pesquise» casa com «Buscar». */
const SYNONYMS = [["pesq", "busc", "sear"], ["adic", "add", "comp"]];
function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of words(text)) {
    const root = w.length >= 5 ? w.slice(0, 4) : w;
    out.add(root);
    for (const group of SYNONYMS) if (group.includes(root)) for (const other of group) out.add(other);
  }
  return out;
}

const ADVANCE = /proximo|continuar|avancar|next|enviar|confirmar|submit/;
const OBSTACLE = /aceitar|accept|fechar|close|continuar sem|no thanks|nao,? obrigado/;
const UNWANTED = /garantia \(|quero o desconto|assinar a newsletter/;

/**
 * Uma heurística no lugar do Jev: pontua cada elemento pelas palavras que divide com o objetivo, remove obstáculos
 * (cookies, modais) antes de seguir, e diz `done` quando o critério da tarefa vale na página (um oráculo, o que o Jev
 * de verdade tenta inferir só do texto). Devolve probabilidades que acompanham a margem, para exercitar as guardas.
 */
export function simPick(query: StepQuery, goal: string, isDone: () => boolean, scrolls: { n: number }): StepReply {
  const reply = (operation: string, target: string | null, probability: number): StepReply =>
    ({ status: "ok", operation, target, probability, reason: null, latencyMs: SIM_LATENCY.pick });
  if (isDone()) return reply("done", null, 0.97);

  const wanted = stems(goal);
  // Só as ações: o que vem depois (o texto visível) não é histórico.
  const recent = (query.state.split("RECENT ACTIONS:")[1] ?? "").split("VISIBLE TEXT")[0];
  const ops = new Set(query.operations.map((o) => o.id));
  const overlap = (label: string) => { let n = 0; for (const w of stems(label)) if (wanted.has(w)) n++; return n; };
  // Uma palavra inteira em comum pesa mais que uma raiz: «Especificações» casa com o objetivo, «Descrição» só casa com «Descubra».
  const goalWords = words(goal);
  const exact = (label: string) => { let n = 0; for (const w of words(label)) if (goalWords.has(w)) n++; return n; };
  // Repetir o que acabou de fazer é o erro que o Jev vê no histórico: pesa muito; repetir o que não mudou a página, mais ainda.
  const lines = recent.split("\n").filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  const repeats = (label: string) => {
    const tag = /"[^"]*"/.exec(label)?.[0] ?? label.replace(/ \(.*$/, "");
    return (last.includes(tag) ? 8 : 0) + lines.filter((l) => l.includes(tag) && l.includes("did not change")).length * 3;
  };

  // Campos a preencher: o primeiro vazio, se ainda sobram valores do `--fill`.
  const wantsFill = /FIELDS THE CALLER WILL FILL/.test(query.state);
  if (wantsFill && ops.has("type")) {
    const empty = query.targets.type?.find((o) => o.label.includes("empty"));
    if (empty) return reply("type", empty.id, 0.9);
  }
  if (wantsFill && ops.has("select")) {
    const empty = query.targets.select?.find((o) => o.label.includes("empty"));
    if (empty) return reply("select", empty.id, 0.9);
  }

  const clicks = query.targets.click ?? [];
  const scored = clicks.map((o) => {
    const lower = o.label.toLowerCase();
    const named = o.label.includes('"');
    // Um obstáculo à vista passa na frente: o Jev vê a faixa/modal no texto e a fecha.
    const obstacle = named && OBSTACLE.test(lower.normalize("NFD").replace(/[̀-ͯ]/g, "")) && /cookie|newsletter|garantia estendida|proteja/.test(query.state.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")) ? 12 : 0;
    const penalty = (UNWANTED.test(lower) ? 4 : 0) + repeats(o.label);
    // Avançar um fluxo («Próximo», «Enviar»…) vale um ponto mesmo sem palavra em comum com o objetivo.
    const advance = named && ADVANCE.test(lower.normalize("NFD").replace(/[̀-ͯ]/g, "")) ? 1 : 0;
    return { o, score: overlap(o.label) * 2 + exact(o.label) * 3 + obstacle + advance - penalty, named };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (best && best.score > 0) {
    const second = scored[1];
    const margin = best.score - (second?.score ?? 0);
    // Vários elementos com o MESMO rótulo (oito «Adicionar»): o texto não distingue, e um Jev calibrado diz que não tem certeza (medido: as escolhas erradas têm p de 0,20 a 0,32; o piso é MIN_PROBABILITY = 0,40).
    const twins = clicks.filter((o) => o.label === best.o.label).length > 1;
    return reply("click", best.o.id, twins ? 0.3 : Math.min(0.95, 0.55 + 0.1 * margin + (best.named ? 0.1 : 0)));
  }
  // Nada liga ao objetivo: um ícone sem nome é um palpite (a guarda `isAmbiguous` o pega); senão, rolar; senão, desistir.
  const blank = clicks.find((o) => !o.label.includes('"') && !o.label.includes(" → "));
  if (blank && repeats(blank.label) === 0) return reply("click", blank.id, 0.6);
  if (scrolls.n < 3) { scrolls.n += 1; return reply("scroll", null, 0.5); }
  return reply("stuck", null, 0.9);
}

// ── A rodada simulada ───────────────────────────────────────────────

export function virtualClock(): Clock & { advance: (ms: number) => void } {
  let at = 0;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

export interface SimOptions {
  /** Liga a reserva visual (a foto) como no app. Padrão: ligada. */
  visual?: boolean;
}

export async function runSimTask(task: BenchTask, options: SimOptions = {}): Promise<TaskRun> {
  const build = PAGES[task.id];
  if (!build) throw new Error(`A tarefa ${task.id} não tem página simulada.`);
  const page = build("http://localhost:8765");
  const clock = virtualClock();
  let scroll = 0;
  let current = renderSnapshot(page, scroll);
  const refresh = () => { current = renderSnapshot(page, scroll); return current; };
  const node = (ref: string) => current.nodes.find((n) => n.ref === ref);
  const scrolls = { n: 0 };
  const onScroll = (page as SimPage & { onScroll?: () => void }).onScroll;

  const base: PilotDeps = {
    snapshot: async () => { clock.advance(SIM_LATENCY.snapshot); return refresh().snapshot; },
    click: async (ref) => { clock.advance(SIM_LATENCY.click); node(ref)?.click?.(); },
    type: async (ref, value, submit) => { clock.advance(SIM_LATENCY.type); node(ref)?.type?.(value, submit); },
    select: async (ref, value) => { clock.advance(SIM_LATENCY.select); node(ref)?.select?.(value); },
    scroll: async () => { clock.advance(SIM_LATENCY.scroll); scroll += 1; onScroll?.(); },
    // Sem `thorough` o app só espera o comando assentar (modo rápido); a operação `wait` do Jev espera a rede ociosa.
    settle: async (thorough) => { clock.advance(thorough ? SIM_LATENCY.settle : SIM_LATENCY.settle / 5); },
    pick: async (query) => {
      clock.advance(SIM_LATENCY.pick);
      return simPick(query, task.goal, () => check(task.success, viewOf(refresh().snapshot)), scrolls);
    },
    ...(options.visual === false ? {} : {
      visual: async (): Promise<VisualReply> => {
        clock.advance(SIM_LATENCY.visual);
        const center = page.photo?.(task.goal) ?? null;
        return { status: "ok", found: center !== null, foundProbability: center ? 0.9 : 0.1, center, confidence: center ? 0.8 : 0.1, reason: null, latencyMs: SIM_LATENCY.visual };
      },
      clickAt: async (x: number, y: number) => { clock.advance(SIM_LATENCY.click); page.clickAt?.(x, y); },
    }),
  };

  const probe = instrument(base, clock);
  const result = await runPilot(task.goal, task.fills ?? [], task.maxSteps, probe.deps);
  const timings = probe.finish();
  const evaluated = evaluate(task, refresh().snapshot);
  const numbered = result.steps.filter((line) => /^\d+\. /.test(line)).length;
  const run: TaskRun = {
    // O piloto mede "passo N ms" com o relógio de parede; no sim o tempo é virtual, então sai do log para a rodada ser repetível.
    log: result.steps.map((line) => line.replace(/, passo \d+ ms\)$/, ")")),
    id: task.id, outcome: result.outcome, ...evaluated,
    blocked: result.steps.some((line) => /recusou |compra ou (um )?pagamento/.test(line)) || /compra ou pagamento/.test(result.note),
    probes: timings.picks + timings.photos,
    steps: numbered, autoFills: result.steps.filter((line) => line.includes("sem o Jev)")).length, photos: timings.photos,
    totalMs: timings.totalMs, stepMs: timings.stepMs, phases: timings.phases, timing: "measured",
    ...(result.outcome !== "done" ? { note: result.note.slice(0, 160) } : {}),
  };
  return run;
}

