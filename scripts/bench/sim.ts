/**
 * O modo `--sim` do benchmark: o `runPilot` REAL contra páginas simuladas em memória (as mesmas 27 locais de
 * `scripts/bench-fixture/`) e um Jev de MENTIRA, uma heurística local. Não custa nada e roda em milissegundos; mede o
 * LAÇO (guardas de ambiguidade, reserva visual, limite de passos, critérios), não a qualidade do Jev de verdade.
 *
 * O tempo é VIRTUAL: cada fase soma uma latência a um relógio de mentira (`SIM_LATENCY`), então o relatório do sim tem
 * a mesma forma do real. Com semente (`--seed`), a latência varia de forma repetível (mesma semente ⇒ mesmos números);
 * sem semente, é fixa. As páginas da leva v2 modelam o que o app faz HOJE (XHR em voo, nós reaproveitados, Jev que dá por
 * feito o que não está): devem falhar até as frentes 2–5 corrigirem — é a linha de base.
 */
import {
  runPilot, words,
  type PilotDeps, type StepQuery, type StepReply, type VisualReply,
} from "../../src/features/browser/jevPilot";
import { parseExpectations, verify } from "../../src/features/browser/expect";
import { parseSnapshot } from "../../src/features/browser/jevPilot";
import { check, evaluate, expectsFor, fold, instrument, rng, viewOf, type BenchTask, type Clock, type TaskRun } from "./core";

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
  /** Até quando (relógio virtual) há XHR/fetch em voo; `null` = rede ociosa. A espera `thorough` (a operação `wait`) a respeita até 2,5 s, como o app. */
  pendingUntil?: () => number | null;
  /**
   * O que o Jev DE VERDADE costuma achar que é «acabou» nesta página, mesmo errado (caixa marcada com a lista ainda
   * carregando, o anúncio no carrinho): o Jev de mentira diz `done` quando isto vale. Modela os falsos «feito» das rodadas ao vivo.
   */
  believesDone?: () => boolean;
  /**
   * Uma política própria no lugar da heurística (`simPick`), para os casos em que o comportamento do Jev real é conhecido
   * (clica de novo quando a quantidade não mudou; não sabe do `act` anterior). `null` = cai na heurística.
   */
  jev?: (query: StepQuery) => { operation: string; target: string | null; probability: number } | null;
  /**
   * Os refs apontam para a POSIÇÃO do nó, não para o conteúdo: um re-render que reaproveita os nós (React com chave por
   * índice) faz o mesmo ref cair noutro produto — o que o runtime de hoje faz (só `isConnected`, achado O1).
   */
  reuseNodes?: boolean;
}

/** O que a página simulada enxerga do mundo: o relógio virtual (para XHR lento e re-render no tempo). */
export interface SimEnv {
  now: () => number;
}

/**
 * O snapshot do app já marca anúncios com `[patrocinado]`? Hoje não (achado O2). Quando a frente de observação (2.2)
 * entregar a marca, ligar aqui faz os nós de anúncio das páginas simuladas ganharem o estado, como no app.
 */
export const SNAPSHOT_MARKS_SPONSORED = true;

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
export function initialNames(build: Build): string[] {
  const page = build("http://sim", { now: () => 0 });
  return page.render().filter((n) => n.name && !n.text && n.role !== "clickable").map((n) => n.name!);
}

// ── As 14 páginas ───────────────────────────────────────────────────

const t = (name: string, role = "text"): SimNode => ({ role, name, text: true });
const btn = (name: string, click: () => void): SimNode => ({ role: "button", name, click });
const unnamed = (click: () => void): SimNode => ({ role: "clickable", click });

export type Build = (host: string, env: SimEnv) => SimPage;

const link = (name: string, href: string, click: () => void): SimNode => ({ role: "link", name, href, click });
const sponsoredStates = (ad: boolean) => (ad && SNAPSHOT_MARKS_SPONSORED ? ["patrocinado"] : []);
const DELAY_SEARCH = 8000;
const DELAY_SUGGEST = 600;
const DELAY_SAVE = 700;
/** O re-render das páginas N07/N08 acontece uma vez, neste instante virtual (depois do 1.º snapshot, antes do 1.º toque). */
const RERENDER_AT = 400;


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

  // ── Leva v2 ───────────────────────────────────────────────────────
  "N01-anuncio-primeiro-resultado": (host) => {
    let open = "";
    const results: [string, string, boolean][] = [["termica", "Caneca Térmica Premium", true], ["ceramica", "Caneca de Cerâmica Branca", false], ["esmaltada", "Caneca Esmaltada Retrô", false]];
    const page: SimPage = {
      url: "", title: "",
      render: () => {
        page.url = `${host}/anuncios-busca.html${open ? `?p=${open}` : ""}`;
        const chosen = results.find(([key]) => key === open);
        page.title = chosen ? `${chosen[1]} — ShopMart` : "ShopMart — resultados";
        if (chosen) return [link("Voltar aos resultados", "/anuncios-busca.html", () => { open = ""; }), t(`Produto: ${chosen[1]}`, "heading"), t("R$ 39,90")];
        return [t("Resultados para: caneca", "heading"), ...results.flatMap(([key, name, ad]) => [
          ...(ad ? [t("Patrocinado")] : []), { ...link(name, `/anuncios-busca.html?p=${key}`, () => { open = key; }), states: sponsoredStates(ad) }, t("R$ 39,90")])];
      },
      // O Jev real dá por feito ao abrir «o primeiro resultado», sem saber que era anúncio (rodadas 3–5).
      believesDone: () => open !== "",
    };
    return page;
  },
  "N02-anuncio-carrinho": (host) => {
    let cart = "";
    const items: [string, boolean][] = [["Fone Gamer RGB", true], ["Fone Bluetooth Lite", false], ["Fone com Fio Clássico", false]];
    return {
      url: `${host}/anuncios-carrinho.html`, title: "ShopMart — fones",
      render: () => [t("Fones de ouvido", "heading"), t(cart ? `Carrinho: 1 item · ${cart}` : "Carrinho: vazio"), ...items.flatMap(([name, ad]) => [
        ...(ad ? [t("Patrocinado")] : []), t(name, "heading"), t("R$ 99,90"),
        { role: "button", name: `Adicionar ${name} ao carrinho`, states: sponsoredStates(ad), click: () => { if (!cart) cart = name; } }])],
      believesDone: () => cart !== "",
    };
  },
  "N03-busca-lenta-xhr": (host, env) => {
    let typed = "";
    let q = "";
    let sentAt = -1;
    let open = "";
    const loading = () => q !== "" && env.now() < sentAt + DELAY_SEARCH;
    const page: SimPage = {
      url: "", title: "ShopMart — busca",
      render: () => {
        page.url = `${host}/busca-lenta.html?xhr=${DELAY_SEARCH}${q ? `&q=${q}` : ""}${open ? `&p=${open}` : ""}`;
        if (open) return [t(`Produto: ${open}`, "heading"), t("R$ 29,90")];
        return [
          // Busca de verdade: o piloto digita e aperta Enter; a página troca o endereço na hora e busca os resultados por fetch.
          { role: "searchbox", name: "Buscar produtos", value: typed, type: (v, submit) => { typed = v; if (submit) { q = v; sentAt = env.now(); } } },
          ...(loading() ? [t("Carregando resultados…")] : []),
          ...(q && !loading() ? [t(`Resultados para: ${q}`, "heading"), ...["Caneca Azul", "Caneca de Vidro", "Caneca Esmaltada"].map((name) => link(name, `/busca-lenta.html?p=${encodeURIComponent(name)}`, () => { open = name; }))] : []),
        ];
      },
      pendingUntil: () => (loading() ? sentAt + DELAY_SEARCH : null),
      believesDone: () => open !== "",
    };
    return page;
  },
  "N04-filtro-lento-xhr": (host, env) => {
    let checked = false;
    let at = -1;
    const loading = () => at >= 0 && env.now() < at + DELAY_SEARCH;
    return {
      url: `${host}/filtro-lento.html?xhr=${DELAY_SEARCH}`, title: "ShopMart — canecas",
      render: () => [t("Canecas e garrafas", "heading"),
        { role: "checkbox", name: "Frete grátis", states: checked ? ["checked"] : [], click: () => { checked = !checked; at = env.now(); } },
        t(loading() ? "Atualizando lista…" : checked ? "Mostrando 3 produtos com frete grátis" : "Mostrando 12 produtos"),
        t("Caneca Azul · R$ 29,90"), t("Garrafa Térmica · R$ 59,90")],
      pendingUntil: () => (loading() ? at + DELAY_SEARCH : null),
      // A caixa marcada parece o objetivo cumprido; a lista só muda 8 s depois (rodada 4: «feito» com a página carregando).
      believesDone: () => checked,
    };
  },
  "N05-autocomplete-cidade": (host, env) => {
    let typed = "";
    let typedAt = -1;
    let listOpen = false;
    let chosen = "";
    let msg = "";
    const cities = ["São Paulo - SP", "São Pedro - SP", "São Paulo de Olivença - AM", "Santos - SP"];
    const options = () => (listOpen && env.now() >= typedAt + DELAY_SUGGEST ? cities.filter((c) => fold(c).startsWith(fold(typed))) : []);
    return {
      url: `${host}/autocomplete-cidade.html`, title: "ShopMart — entrega",
      render: () => [t("Endereço de entrega", "heading"),
        { role: "textbox", name: "Cidade", value: typed, type: (v: string) => { typed = v; typedAt = env.now(); listOpen = true; chosen = ""; } },
        ...options().map((c): SimNode => ({ role: "option", name: c, click: () => { chosen = c; typed = c; listOpen = false; } })),
        // Confirmar com o texto solto fecha a lista (como os combobox de verdade) e pede uma cidade da lista.
        btn("Confirmar", () => { listOpen = false; msg = chosen ? `Cidade escolhida: ${chosen}` : "Escolha uma cidade da lista de sugestões"; }),
        ...(msg ? [t(msg)] : [])],
      pendingUntil: () => (listOpen && env.now() < typedAt + DELAY_SUGGEST ? typedAt + DELAY_SUGGEST : null),
    };
  },
  "N06-autocomplete-busca": (host, env) => {
    let typed = "";
    let typedAt = -1;
    let listOpen = false;
    let q = "";
    const suggestions = ["fone bluetooth", "fone com fio", "fone gamer"];
    const options = () => (listOpen && env.now() >= typedAt + DELAY_SUGGEST ? suggestions.filter((s) => s.startsWith(fold(typed))) : []);
    const page: SimPage = {
      url: "", title: "ShopMart — busca",
      render: () => {
        page.url = `${host}/autocomplete-busca.html${q ? `?q=${encodeURIComponent(q)}` : ""}`;
        return [
          { role: "searchbox", name: "Buscar produtos", value: typed, type: (v, submit) => { typed = v; typedAt = env.now(); listOpen = true; if (submit) { q = v; listOpen = false; } } },
          ...options().map((s): SimNode => ({ role: "option", name: s, click: () => { q = s; typed = s; listOpen = false; } })),
          ...(q ? [t(`Resultados para: ${q}`, "heading")] : []),
        ];
      },
      pendingUntil: () => (listOpen && env.now() < typedAt + DELAY_SUGGEST ? typedAt + DELAY_SUGGEST : null),
      believesDone: () => q !== "",
    };
    return page;
  },
  "N07-rerender-lista": (host, env) => {
    let cart = "";
    const first = ["Teclado Mecânico", "Fone Bluetooth", "Mouse Sem Fio", "Webcam HD"];
    // «Mais vendidos agora» chega depois e reordena a lista REAPROVEITANDO os mesmos botões (chave por índice).
    const later = ["Mouse Sem Fio", "Webcam HD", "Fone Bluetooth", "Teclado Mecânico"];
    return {
      url: `${host}/rerender-lista.html`, title: "ShopMart — mais vendidos",
      reuseNodes: true,
      render: () => [t("Mais vendidos agora", "heading"), t(cart ? `No carrinho: ${cart}` : "Carrinho vazio"),
        ...(env.now() >= RERENDER_AT ? later : first).flatMap((name) => [t(name, "heading"), btn(`Adicionar ${name} ao carrinho`, () => { cart = name; })])],
      believesDone: () => cart !== "",
    };
  },
  "N08-rerender-remover": (host, env) => {
    const removed: string[] = [];
    const first = ["Cabo USB", "Mouse Sem Fio", "Capa de Celular"];
    // Os preços chegam e o carrinho se reordena por preço, com os MESMOS botões «Remover».
    const later = ["Mouse Sem Fio", "Capa de Celular", "Cabo USB"];
    return {
      url: `${host}/rerender-carrinho.html`, title: "ShopMart — carrinho",
      reuseNodes: true,
      render: () => {
        const left = (env.now() >= RERENDER_AT ? later : first).filter((name) => !removed.includes(name));
        return [t("Seu carrinho", "heading"), t(`${left.length} itens`),
          ...left.flatMap((name) => [t(name, "heading"), btn(`Remover ${name}`, () => { removed.push(name); })]),
          ...(removed.length > 0 ? [t(`Removido: ${removed.join(", ")}`)] : [])];
      },
      believesDone: () => removed.length > 0,
    };
  },
  "N09-carrinho-quantidade": (host, env) => {
    const clicks: number[] = [];
    const shown = () => 1 + clicks.filter((at) => at + DELAY_SAVE <= env.now()).length;
    const saving = () => clicks.some((at) => at + DELAY_SAVE > env.now());
    return {
      url: `${host}/carrinho-quantidade.html?xhr=${DELAY_SAVE}`, title: "ShopMart — carrinho",
      render: () => {
        const n = shown();
        return [t("Seu carrinho", "heading"), t("Caneca Azul", "heading"), t(`Quantidade: ${n}`),
          btn("Diminuir quantidade", () => undefined), btn("Aumentar quantidade", () => { clicks.push(env.now()); }),
          ...(saving() ? [t("Salvando…")] : []), t(`Carrinho: ${n} ${n === 1 ? "item" : "itens"}`)];
      },
      pendingUntil: () => (saving() ? Math.max(...clicks) + DELAY_SAVE : null),
      // O Jev real lê a quantidade da tela: menor que 2, clica «Aumentar» de novo; 2 ou mais, acabou.
      jev: (query) => {
        if (shown() >= 2) return { operation: "done", target: null, probability: 0.9 };
        const plus = query.targets.click?.find((o) => o.label.includes("Aumentar"));
        return plus ? { operation: "click", target: plus.id, probability: 0.85 } : null;
      },
    };
  },
  "N10-carrinho-idempotente": (host) => {
    let count = 0;
    return {
      url: `${host}/carrinho-idempotente.html`, title: "ShopMart — caneca",
      render: () => [t("Caneca Azul", "heading"), t("R$ 29,90"), btn("Adicionar ao carrinho", () => { count += 1; }), t(`Carrinho: ${count} ${count === 1 ? "item" : "itens"}`)],
      // O Jev real só sabe o que está no histórico da consulta: sem «Adicionar» nas ações recentes, adiciona (de novo).
      jev: (query) => {
        const recent = (query.state.split("RECENT ACTIONS:")[1] ?? "").split("VISIBLE TEXT")[0];
        if (/Adicionar ao carrinho/.test(recent)) return { operation: "done", target: null, probability: 0.9 };
        const add = query.targets.click?.find((o) => o.label.includes("Adicionar ao carrinho"));
        return add ? { operation: "click", target: add.id, probability: 0.85 } : null;
      },
    };
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
const SPONSORED = /patrocinad|sponsored|\banuncio\b/;

/**
 * Uma heurística no lugar do Jev: pontua cada elemento pelas palavras que divide com o objetivo, remove obstáculos
 * (cookies, modais) antes de seguir, e diz `done` quando o critério da tarefa vale na página (um oráculo, o que o Jev
 * de verdade tenta inferir só do texto). Devolve probabilidades que acompanham a margem, para exercitar as guardas.
 */
export function simPick(query: StepQuery, goal: string, isDone: () => boolean, scrolls: { n: number }): StepReply {
  const reply = (operation: string, target: string | null, probability: number): StepReply =>
    ({ status: "ok", operation, target, probability, reason: null, latencyMs: SIM_LATENCY.pick });
  if (isDone()) return reply("done", null, 0.97);
  // A página diz que ainda está carregando: o Jev pede para esperar (a operação `wait`, quando oferecida).
  const ops0 = new Set(query.operations.map((o) => o.id));
  if (ops0.has("wait") && /VISIBLE TEXT[^\n]*(carregando|atualizando|loading)/i.test(query.state)) return reply("wait", null, 0.7);

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
    // Um anúncio MARCADO ([patrocinado], O2) fica de lado, como a regra NEXT_ACTION pedirá (D1); sem a marca, o Jev não o vê.
    const penalty = (UNWANTED.test(lower) ? 4 : 0) + (SPONSORED.test(lower.normalize("NFD").replace(/[̀-ͯ]/g, "")) ? 10 : 0) + repeats(o.label);
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
  /**
   * Fase 5: passa ao «act» os `--expect` equivalentes ao critério da tarefa e aplica a conferência por código: um FEITO que a
   * página desmente vira NÃO CONFERE (outcome `unsure`, veredito `mismatch`). Sem isto o sim não confere nada (como o app antes).
   */
  withExpect?: boolean;
  /** Liga a reserva visual (a foto) como no app. Padrão: ligada. */
  visual?: boolean;
  /**
   * Semente da variação de latência: cada fase leva a latência base × [0,75; 1,25) e, em 5% das vezes, ×3 (a cauda que o
   * p95 tem de enxergar). Sem semente, a latência é fixa (o comportamento antigo do sim).
   */
  seed?: number;
  /**
   * Guarda semântica por elemento (Fase 2.1, O1): antes de agir, confere se o nó do ref ainda tem o papel e o nome do
   * snapshot; se mudou, devolve «stale» sem agir. Hoje o runtime NÃO faz isso (padrão desligado): ligue para simular o depois.
   */
  guard?: boolean;
}

/** Espera de rede da operação `wait` do app (`agentBridge.ts`: `wait { idle }` com teto de 2,5 s). */
export const THOROUGH_WAIT_CAP = 2500;

/** Bytes UTF-8 de uma consulta como vai ao Jev (estado + operações + alvos). */
export function queryBytes(query: StepQuery): number {
  return new TextEncoder().encode(JSON.stringify(query)).length;
}

export async function runSimTask(task: BenchTask, options: SimOptions = {}): Promise<TaskRun> {
  const build = PAGES[task.id];
  if (!build) throw new Error(`A tarefa ${task.id} não tem página simulada.`);
  const clock = virtualClock();
  const page = build("http://localhost:8765", { now: clock.now });
  const random = options.seed === undefined ? null : rng(options.seed);
  const lat = (base: number) => (random ? Math.round(base * (0.75 + 0.5 * random()) * (random() < 0.05 ? 3 : 1)) : base);
  let scroll = 0;
  let current = renderSnapshot(page, scroll);
  const refresh = () => { current = renderSnapshot(page, scroll); return current; };
  // Um ref aponta para o nó do último snapshot; numa página que reaproveita nós, para a POSIÇÃO — e o conteúdo ali é o de agora.
  const node = (ref: string) => {
    const seen = current.nodes.find((n) => n.ref === ref);
    if (!page.reuseNodes) return seen;
    const live = renderSnapshot(page, scroll).nodes.find((n) => n.ref === ref);
    if (options.guard && live && seen && (live.role !== seen.role || live.name !== seen.name)) {
      throw new Error(`O elemento ${ref} não está mais na página como no snapshot (mudou de «${seen.name}» para «${live.name}»): tire um novo snapshot.`);
    }
    return live;
  };
  const scrolls = { n: 0 };
  const onScroll = (page as SimPage & { onScroll?: () => void }).onScroll;
  const bytes: number[] = [];
  const latencies: number[] = [];
  // O oráculo lê a página de agora SEM trocar o snapshot que o piloto viu: os refs continuam os da última leitura dele.
  const isDone = () => check(task.success, viewOf(renderSnapshot(page, scroll).snapshot));

  const base: PilotDeps = {
    snapshot: async () => { clock.advance(lat(SIM_LATENCY.snapshot)); return refresh().snapshot; },
    click: async (ref) => { clock.advance(lat(SIM_LATENCY.click)); node(ref)?.click?.(); },
    type: async (ref, value, submit) => { clock.advance(lat(SIM_LATENCY.type)); node(ref)?.type?.(value, submit); },
    select: async (ref, value) => { clock.advance(lat(SIM_LATENCY.select)); node(ref)?.select?.(value); },
    scroll: async () => { clock.advance(lat(SIM_LATENCY.scroll)); scroll += 1; onScroll?.(); },
    // Sem `thorough` o app só espera o comando assentar (modo rápido, não olha a rede); a operação `wait` do Jev espera a
    // rede ociosa até 2,5 s — com XHR em voo, até ele terminar ou o teto.
    settle: async (thorough) => {
      if (!thorough) { clock.advance(lat(SIM_LATENCY.settle / 5)); return; }
      const until = page.pendingUntil?.() ?? null;
      clock.advance(until === null ? lat(SIM_LATENCY.settle) : Math.min(THOROUGH_WAIT_CAP, Math.max(0, until - clock.now()) + 50));
    },
    pick: async (query) => {
      const ms = lat(SIM_LATENCY.pick);
      clock.advance(ms);
      bytes.push(queryBytes(query));
      latencies.push(ms);
      const policy = page.jev?.(query) ?? null;
      const reply: StepReply = policy
        ? { status: "ok", operation: policy.operation, target: policy.target, probability: policy.probability, reason: null, latencyMs: ms }
        : !isDone() && page.believesDone?.()
          ? { status: "ok", operation: "done", target: null, probability: 0.9, reason: null, latencyMs: ms }
          : simPick(query, task.goal, isDone, scrolls);
      return { ...reply, latencyMs: ms };
    },
    ...(options.visual === false ? {} : {
      visual: async (): Promise<VisualReply> => {
        const ms = lat(SIM_LATENCY.visual);
        clock.advance(ms);
        const center = page.photo?.(task.goal) ?? null;
        return { status: "ok", found: center !== null, foundProbability: center ? 0.9 : 0.1, center, confidence: center ? 0.8 : 0.1, reason: null, latencyMs: ms };
      },
      clickAt: async (x: number, y: number) => { clock.advance(lat(SIM_LATENCY.click)); page.clickAt?.(x, y); },
    }),
  };

  // Vários `act` com o mesmo objetivo na mesma página (N10): cada um é um `runPilot` novo, como o agente chamando de novo.
  const acts = Math.max(1, task.acts ?? 1);
  const log: string[] = [];
  const stepMs: number[] = [];
  const actMs: number[] = [];
  const phases = { jevMs: 0, snapshotMs: 0, actionMs: 0, waitMs: 0, otherMs: 0 };
  let picks = 0;
  let photos = 0;
  let result: Awaited<ReturnType<typeof runPilot>> | null = null;
  for (let a = 0; a < acts; a++) {
    const probe = instrument(base, clock);
    result = await runPilot(task.goal, task.fills ?? [], task.maxSteps, probe.deps);
    const timings = probe.finish();
    if (acts > 1) log.push(`— act ${a + 1}/${acts}: ${result.outcome}`);
    // O piloto mede "passo N ms" com o relógio de parede; no sim o tempo é virtual, então sai do log para a rodada ser repetível.
    log.push(...result.steps.map((line) => line.replace(/, passo \d+ ms\)$/, ")")));
    stepMs.push(...timings.stepMs);
    actMs.push(timings.totalMs);
    for (const key of Object.keys(phases) as (keyof typeof phases)[]) phases[key] += timings.phases[key];
    picks += timings.picks;
    photos += timings.photos;
  }
  // O critério tem de valer quando o piloto devolve («feito» com a lista ainda carregando é falso, N04) E continuar valendo
  // com a página ASSENTADA (o XHR em voo que soma mais uma unidade, N09).
  const atReturn = evaluate(task, refresh().snapshot);
  const settledAt = page.pendingUntil?.() ?? null;
  if (settledAt !== null && settledAt > clock.now()) clock.advance(settledAt - clock.now());
  const settled = evaluate(task, refresh().snapshot);
  const evaluated = { criterionOk: atReturn.criterionOk && settled.criterionOk, forbidden: atReturn.forbidden || settled.forbidden, finalUrl: settled.finalUrl };
  const final = result!;
  // A conferência por código do app (Fase 5): só com `withExpect`; o app real a faz sempre (os genéricos) e com `--expect` quando passado.
  let verdict: TaskRun["verdict"];
  let outcome: TaskRun["outcome"] = final.outcome;
  if (options.withExpect) {
    const v = verify(task.goal, final.outcome, parseExpectations(expectsFor(task.success)).expects, parseSnapshot(refresh().snapshot));
    if (final.outcome === "done") {
      verdict = v.verdict;
      if (v.verdict === "mismatch") outcome = "unsure";
    }
  }
  const numbered = log.filter((line) => /^\d+\. /.test(line)).length;
  const totalBytes = bytes.reduce((x, y) => x + y, 0);
  const run: TaskRun = {
    log,
    id: task.id, outcome, ...evaluated, ...(verdict ? { verdict } : {}),
    blocked: log.some((line) => /recusou |compra ou (um )?pagamento/.test(line)) || /compra ou pagamento/.test(final.note),
    probes: picks + photos,
    steps: numbered, autoFills: log.filter((line) => line.includes("sem o Jev)")).length, photos,
    totalMs: actMs.reduce((x, y) => x + y, 0), stepMs, phases, timing: "measured",
    acts, actMs,
    queries: { count: picks, bytes, latencyMs: latencies, tokens: Math.round(totalBytes / 4), tokensEstimated: true },
    windowHang: false,
    ...(final.outcome !== "done" ? { note: final.note.slice(0, 160) } : {}),
  };
  return run;
}

