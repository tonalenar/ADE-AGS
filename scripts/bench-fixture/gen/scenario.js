// Conjunto de TESTE do piloto do Jev (protocolo J2): tarefas geradas por semente que NUNCA serviram para ajustar uma
// regra do piloto. O mesmo módulo é usado pela página (`loja.html`, que desenha a variante) e pelo bench
// (`scripts/bench/tasks-teste.ts`, que tira dele o objetivo e o critério). Determinístico: a mesma (família, semente)
// dá sempre a mesma página e a mesma tarefa. Sem dependências, sem dado real.

/** PRNG pequeno e determinístico (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, list) => list[Math.floor(r() * list.length)];
function shuffle(r, list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
/** `n` itens distintos de `list`. */
const sample = (r, list, n) => shuffle(r, list).slice(0, n);

export const FAMILIES = ["adicionar", "busca", "filtro", "icone", "formulario"];
export const SEEDS = 20;

const PRODUCTS = [
  "Mochila Trilha 30L", "Garrafa Inox 750ml", "Lanterna de Cabeça", "Barraca Duas Pessoas", "Saco de Dormir Leve",
  "Fone Sem Fio Pulse", "Teclado Mecânico Mini", "Mouse Vertical", "Carregador Rápido 65W", "Cabo USB-C Trançado",
  "Caneca Térmica", "Cafeteira Prensa", "Moedor Manual", "Chaleira Elétrica", "Jogo de Facas",
];

const T = {
  pt: {
    store: "Loja Exemplo", cart: "Carrinho", add: ["Adicionar ao carrinho", "Comprar", "Pôr na sacola", "Adicionar"],
    cookies: "Usamos cookies para melhorar sua experiência.", accept: "Aceitar", reject: "Recusar",
    news: "Assine nossa newsletter e ganhe 10%", subscribe: "Assinar", close: ["Fechar", "Não, obrigado", "Agora não"],
    subscribed: "Inscrição confirmada",
    search: ["Buscar produtos", "Pesquisar", "Buscar na loja"], searchBtn: ["Buscar", "Pesquisar", "Ir"], results: "Resultados para:",
    filters: [["Frete grátis", "com frete grátis"], ["Em promoção", "em promoção"], ["Pronta entrega", "com pronta entrega"]],
    showing: (n, what) => `Mostrando ${n} produtos ${what}`,
    fields: { nome: "Nome completo", email: "E-mail", telefone: "Telefone", cidade: "Cidade" },
    send: ["Enviar", "Cadastrar", "Concluir cadastro"], next: "Próximo", sent: "Cadastro enviado:",
  },
  en: {
    store: "Sample Store", cart: "Cart", add: ["Add to cart", "Add to bag", "Buy", "Add"],
    cookies: "We use cookies to improve your experience.", accept: "Accept", reject: "Decline",
    news: "Join our newsletter and get 10% off", subscribe: "Subscribe", close: ["Close", "No thanks", "Not now"],
    subscribed: "Subscription confirmed",
    search: ["Search products", "Search", "Search the store"], searchBtn: ["Search", "Go", "Find"], results: "Results for:",
    filters: [["Free shipping", "with free shipping"], ["On sale", "on sale"], ["In stock", "in stock"]],
    showing: (n, what) => `Showing ${n} products ${what}`,
    fields: { nome: "Full name", email: "Email", telefone: "Phone", cidade: "City" },
    send: ["Submit", "Sign up", "Finish"], next: "Next", sent: "Form sent:",
  },
  es: {
    store: "Tienda Ejemplo", cart: "Carrito", add: ["Añadir al carrito", "Comprar", "Agregar", "Añadir a la bolsa"],
    cookies: "Usamos cookies para mejorar tu experiencia.", accept: "Aceptar", reject: "Rechazar",
    news: "Suscríbete y gana un 10%", subscribe: "Suscribirme", close: ["Cerrar", "No, gracias", "Ahora no"],
    subscribed: "Suscripción confirmada",
    search: ["Buscar productos", "Buscar", "Buscar en la tienda"], searchBtn: ["Buscar", "Ir"], results: "Resultados para:",
    filters: [["Envío gratis", "con envío gratis"], ["En oferta", "en oferta"], ["Entrega inmediata", "con entrega inmediata"]],
    showing: (n, what) => `Mostrando ${n} productos ${what}`,
    fields: { nome: "Nombre completo", email: "Correo", telefone: "Teléfono", cidade: "Ciudad" },
    send: ["Enviar", "Registrarme", "Terminar"], next: "Siguiente", sent: "Registro enviado:",
  },
};

/** Como o objetivo (sempre em PT-BR, como o agente escreveria) chama cada filtro. */
const FILTER_GOAL = ["com frete grátis", "em promoção", "com pronta entrega"];
const TERMS = ["mochila", "lanterna", "caneca", "teclado", "barraca", "garrafa", "cafeteira", "carregador"];
const ICONS = ["carrinho", "busca", "perfil", "notificacoes", "ajuda"];
const ICON_GOAL = {
  carrinho: "o carrinho de compras", busca: "a busca do site", perfil: "o perfil da conta",
  notificacoes: "as notificações", ajuda: "a ajuda",
};
const ICON_DONE = { carrinho: "CARRINHO ABERTO", busca: "BUSCA ABERTA", perfil: "PERFIL ABERTO", notificacoes: "NOTIFICAÇÕES ABERTAS", ajuda: "AJUDA ABERTA" };
const PEOPLE = ["Ana Teste", "Bruno Exemplo", "Carla Fictícia", "Diego Demo", "Elisa Amostra"];
const CITIES = ["Campinas", "Curitiba", "Recife", "Belém", "Natal"];

/** Um semente → o idioma da página (metade em PT, o resto EN/ES: o objetivo continua em PT). */
function langOf(r) {
  const x = r();
  return x < 0.5 ? "pt" : x < 0.75 ? "en" : "es";
}

/**
 * A variante de uma (família, semente): o que a página desenha (`view`) e o que o bench pede e confere (`goal`, `fills`,
 * `success`, `forbid`). Critérios como dados: `{ kind: "text", value }`, `{ kind: "url", value }`, `{ kind: "all", of }`.
 */
export function scenario(family, seed) {
  if (!FAMILIES.includes(family)) throw new Error(`família desconhecida: ${family}`);
  const r = rng(seed * 7919 + FAMILIES.indexOf(family) * 104729);
  const lang = langOf(r);
  const t = T[lang];
  const base = { family, seed, lang, store: t.store };

  if (family === "adicionar") {
    const products = sample(r, PRODUCTS, 4 + Math.floor(r() * 3));
    const target = pick(r, products);
    const add = pick(r, t.add);
    const obstacle = pick(r, ["nenhum", "nenhum", "cookies", "modal"]);
    const close = pick(r, t.close);
    return {
      ...base,
      goal: `Adicione «${target}» ao carrinho${obstacle === "modal" ? ", sem assinar a newsletter" : ""}.`,
      fills: [],
      success: { kind: "text", value: `${t.cart}: 1 · ${target}` },
      forbid: { kind: "text", value: t.subscribed },
      view: { products, add, obstacle, close, cart: t.cart, cookies: t.cookies, accept: t.accept, reject: t.reject, news: t.news, subscribe: t.subscribe, subscribed: t.subscribed },
    };
  }
  if (family === "busca") {
    const term = pick(r, TERMS);
    const label = pick(r, t.search);
    const mode = pick(r, ["botao", "enter"]);
    return {
      ...base,
      goal: `Pesquise por ${term} na loja.`,
      fills: [`${label}=${term}`],
      success: { kind: "all", of: [{ kind: "url", value: `q=${term}` }, { kind: "text", value: `${t.results} ${term}` }] },
      view: { label, mode, button: pick(r, t.searchBtn), results: t.results, products: sample(r, PRODUCTS, 6) },
    };
  }
  if (family === "filtro") {
    const which = Math.floor(r() * t.filters.length);
    const [label, what] = t.filters[which];
    const delay = pick(r, [0, 0, 800, 2000, 4000]);
    const products = sample(r, PRODUCTS, 8).map((name) => ({ name, on: r() < 0.45 }));
    if (!products.some((p) => p.on)) products[0].on = true;
    // Todos marcados: o filtro não mudaria nada e o critério valeria antes da ação.
    if (products.every((p) => p.on)) products[products.length - 1].on = false;
    const n = products.filter((p) => p.on).length;
    return {
      ...base,
      goal: `Mostre só os produtos ${FILTER_GOAL[which]}.`,
      fills: [],
      success: { kind: "text", value: t.showing(n, what) },
      view: { label, delay, products, showing: t.showing(n, what), all: t.showing(products.length, "").trim() },
    };
  }
  if (family === "icone") {
    const icons = sample(r, ICONS, 3 + Math.floor(r() * 2));
    const target = pick(r, icons);
    return {
      ...base,
      goal: `Abra ${ICON_GOAL[target]}: é um dos ícones no topo da página.`,
      fills: [],
      success: { kind: "text", value: ICON_DONE[target] },
      view: { icons, done: ICON_DONE },
    };
  }
  // formulario
  const keys = ["nome", ...sample(r, ["email", "telefone", "cidade"], 1 + Math.floor(r() * 3))];
  const person = pick(r, PEOPLE);
  const values = { nome: person, email: `${person.split(" ")[0].toLowerCase()}@exemplo.test`, telefone: "11 90000-0000", cidade: pick(r, CITIES) };
  const steps = r() < 0.4 ? 2 : 1;
  return {
    ...base,
    goal: `Preencha o cadastro e envie.`,
    fills: keys.map((k) => `${t.fields[k]}=${values[k]}`),
    success: { kind: "text", value: `${t.sent} ${person}` },
    view: { keys, labels: t.fields, steps, send: pick(r, t.send), next: t.next, sent: t.sent },
  };
}
