// Conjunto de TESTE 2 do piloto do Jev (protocolo J2): famílias de página que o conjunto 1 (`scenario.js`) não cobre —
// abas, perguntas que abrem, paginação, escolha em lista, confirmação antes de remover, quantidade e menu. Mesmas regras:
// determinístico por (família, semente), idioma da página PT/EN/ES, objetivo sempre em PT-BR, nenhuma regra do piloto
// ajustada nelas antes de medir. A página é `loja2.html` (desenha com `render2.js`); o bench tira daqui o objetivo e o
// critério (`scripts/bench/tasks-teste.ts`). `solve` é o caminho certo, só para os testes conferirem a página.

import { rng } from "./scenario.js";

const pick = (r, list) => list[Math.floor(r() * list.length)];
function shuffle(r, list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
const sample = (r, list, n) => shuffle(r, list).slice(0, n);
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

export const FAMILIES2 = ["abas", "acordeao", "paginacao", "selecao", "confirmacao", "quantidade", "menu"];
export const SEEDS2 = 20;

const PRODUCTS = [
  "Mochila Trilha 30L", "Garrafa Inox 750ml", "Lanterna de Cabeça", "Barraca Duas Pessoas", "Saco de Dormir Leve",
  "Fone Sem Fio Pulse", "Teclado Mecânico Mini", "Mouse Vertical", "Carregador Rápido 65W", "Cabo USB-C Trançado",
  "Caneca Térmica", "Cafeteira Prensa", "Moedor Manual", "Chaleira Elétrica", "Jogo de Facas", "Tábua de Bambu",
  "Panela de Ferro", "Luminária de Mesa", "Suporte de Notebook", "Hub USB 7 Portas",
];

const T = {
  pt: {
    store: "Loja Exemplo", cart: "Carrinho", add: "Adicionar ao carrinho",
    tabs: { descricao: "Descrição", especificacoes: "Especificações", avaliacoes: "Avaliações", garantia: "Garantia", entrega: "Entrega" },
    warranty: "Garantia de fábrica", months: "meses", weight: "Peso", reviews: "avaliações", delivery: "Entrega em", days: "dias úteis", ref: "Código",
    faq: "Perguntas frequentes", expand: "Expandir",
    questions: {
      devolucao: "Como faço uma devolução?", troca: "Posso trocar o tamanho?", frete: "Quanto custa o frete?",
      pagamento: "Quais formas de pagamento vocês aceitam?", prazo: "Qual o prazo de entrega?", nota: "Como recebo a nota fiscal?",
    },
    answers: {
      devolucao: "Devolução grátis em até", troca: "Troca liberada em até", frete: "Frete grátis acima de R$",
      pagamento: "Parcelamos em até", prazo: "Despacho em até", nota: "A nota fiscal chega no e-mail em até",
    },
    units: { devolucao: "dias", troca: "dias", frete: "", pagamento: "vezes", prazo: "horas", nota: "horas" },
    next: "Próxima", more: "Carregar mais", page: "Página",
    size: "Tamanho", color: "Cor", choose: "Escolha", confirm: ["Confirmar", "Aplicar", "Salvar escolha"], chosen: "Escolhido",
    colors: { preto: "Preto", azul: "Azul", verde: "Verde", vermelho: "Vermelho", cinza: "Cinza" },
    remove: "Remover", sure: "Tem certeza que deseja remover", yes: ["Sim, remover", "Remover", "Confirmar"], no: ["Cancelar", "Manter", "Voltar"],
    removed: "Removido", items: "Itens no carrinho",
    qty: "Quantidade", plus: "Aumentar", minus: "Diminuir",
    categories: "Categorias", menu: "Menu", category: "Categoria",
    cats: { cozinha: "Cozinha", camping: "Camping", informatica: "Informática", escritorio: "Escritório", audio: "Áudio" },
  },
  en: {
    store: "Sample Store", cart: "Cart", add: "Add to cart",
    tabs: { descricao: "Description", especificacoes: "Specifications", avaliacoes: "Reviews", garantia: "Warranty", entrega: "Shipping" },
    warranty: "Manufacturer warranty", months: "months", weight: "Weight", reviews: "reviews", delivery: "Delivered in", days: "business days", ref: "Code",
    faq: "Frequently asked questions", expand: "Expand",
    questions: {
      devolucao: "How do I return an item?", troca: "Can I exchange the size?", frete: "How much is shipping?",
      pagamento: "Which payment methods do you accept?", prazo: "How long does delivery take?", nota: "How do I get the invoice?",
    },
    answers: {
      devolucao: "Free returns within", troca: "Exchanges allowed within", frete: "Free shipping over $",
      pagamento: "Split into up to", prazo: "Ships within", nota: "The invoice arrives by email within",
    },
    units: { devolucao: "days", troca: "days", frete: "", pagamento: "installments", prazo: "hours", nota: "hours" },
    next: "Next", more: "Load more", page: "Page",
    size: "Size", color: "Color", choose: "Choose", confirm: ["Confirm", "Apply", "Save choice"], chosen: "Selected",
    colors: { preto: "Black", azul: "Blue", verde: "Green", vermelho: "Red", cinza: "Gray" },
    remove: "Remove", sure: "Are you sure you want to remove", yes: ["Yes, remove", "Remove", "Confirm"], no: ["Cancel", "Keep", "Go back"],
    removed: "Removed", items: "Items in cart",
    qty: "Quantity", plus: "Increase", minus: "Decrease",
    categories: "Categories", menu: "Menu", category: "Category",
    cats: { cozinha: "Kitchen", camping: "Camping", informatica: "Computers", escritorio: "Office", audio: "Audio" },
  },
  es: {
    store: "Tienda Ejemplo", cart: "Carrito", add: "Añadir al carrito",
    tabs: { descricao: "Descripción", especificacoes: "Especificaciones", avaliacoes: "Opiniones", garantia: "Garantía", entrega: "Envío" },
    warranty: "Garantía de fábrica", months: "meses", weight: "Peso", reviews: "opiniones", delivery: "Entrega en", days: "días hábiles", ref: "Código",
    faq: "Preguntas frecuentes", expand: "Expandir",
    questions: {
      devolucao: "¿Cómo hago una devolución?", troca: "¿Puedo cambiar la talla?", frete: "¿Cuánto cuesta el envío?",
      pagamento: "¿Qué formas de pago aceptan?", prazo: "¿Cuál es el plazo de entrega?", nota: "¿Cómo recibo la factura?",
    },
    answers: {
      devolucao: "Devolución gratis hasta", troca: "Cambio permitido hasta", frete: "Envío gratis desde $",
      pagamento: "Hasta", prazo: "Despacho en hasta", nota: "La factura llega al correo en hasta",
    },
    units: { devolucao: "días", troca: "días", frete: "", pagamento: "cuotas", prazo: "horas", nota: "horas" },
    next: "Siguiente", more: "Cargar más", page: "Página",
    size: "Talla", color: "Color", choose: "Elige", confirm: ["Confirmar", "Aplicar", "Guardar elección"], chosen: "Elegido",
    colors: { preto: "Negro", azul: "Azul", verde: "Verde", vermelho: "Rojo", cinza: "Gris" },
    remove: "Quitar", sure: "¿Seguro que quieres quitar", yes: ["Sí, quitar", "Quitar", "Confirmar"], no: ["Cancelar", "Conservar", "Volver"],
    removed: "Quitado", items: "Artículos en el carrito",
    qty: "Cantidad", plus: "Aumentar", minus: "Disminuir",
    categories: "Categorías", menu: "Menú", category: "Categoría",
    cats: { cozinha: "Cocina", camping: "Camping", informatica: "Informática", escritorio: "Oficina", audio: "Audio" },
  },
};

/** Como o objetivo (em PT-BR) chama cada coisa. */
const GOAL_TAB = { descricao: "descrição", especificacoes: "especificações", avaliacoes: "avaliações", garantia: "garantia", entrega: "entrega" };
const GOAL_Q = { devolucao: "devolução", troca: "troca de tamanho", frete: "frete", pagamento: "formas de pagamento", prazo: "prazo de entrega", nota: "nota fiscal" };
const GOAL_CAT = { cozinha: "Cozinha", camping: "Camping", informatica: "Informática", escritorio: "Escritório", audio: "Áudio" };
const GOAL_COLOR = { preto: "preta", azul: "azul", verde: "verde", vermelho: "vermelha", cinza: "cinza" };

function langOf(r) {
  const x = r();
  return x < 0.5 ? "pt" : x < 0.75 ? "en" : "es";
}

/**
 * A variante de uma (família, semente): `view` (o que a página desenha), `goal`, `fills`, `success`, `forbid` (critérios como
 * dados, como em `scenario.js`) e `solve` (o caminho certo, em passos `{ click }`, `{ fill: [rótulo, valor] }`,
 * `{ select: [rótulo, opção] }`, `{ follow }` — só para os testes).
 */
export function scenario2(family, seed) {
  if (!FAMILIES2.includes(family)) throw new Error(`família desconhecida: ${family}`);
  const r = rng(seed * 6007 + FAMILIES2.indexOf(family) * 92821 + 17);
  const lang = langOf(r);
  const t = T[lang];
  const base = { family, seed, lang, store: t.store };

  if (family === "abas") {
    const product = pick(r, PRODUCTS);
    const keys = sample(r, Object.keys(t.tabs), int(r, 3, 5));
    const n = { garantia: int(r, 6, 24), especificacoes: int(r, 150, 2400), avaliacoes: int(r, 12, 980), entrega: int(r, 2, 15), descricao: int(r, 1000, 9999) };
    const content = {
      descricao: `${t.ref}: REF-${n.descricao}`,
      especificacoes: `${t.weight}: ${n.especificacoes} g`,
      avaliacoes: `4,${int(r, 1, 9)} ★ · ${n.avaliacoes} ${t.reviews}`,
      garantia: `${t.warranty}: ${n.garantia} ${t.months}`,
      entrega: `${t.delivery} ${n.entrega} ${t.days}`,
    };
    // Nunca a aba que já abre ativa (a primeira): o critério valeria antes da ação.
    const target = keys[1 + Math.floor(r() * (keys.length - 1))];
    const mode = pick(r, ["botoes", "links"]);
    return {
      ...base,
      goal: `Mostre a aba de ${GOAL_TAB[target]} do produto «${product}».`,
      fills: [],
      success: { kind: "text", value: content[target] },
      view: { product, keys, labels: t.tabs, content, mode },
      solve: [{ click: t.tabs[target] }],
    };
  }

  if (family === "acordeao") {
    const keys = sample(r, Object.keys(t.questions), int(r, 4, 6));
    const values = Object.fromEntries(keys.map((k) => [k, k === "frete" ? int(r, 99, 399) : k === "pagamento" ? int(r, 3, 12) : int(r, 7, 90)]));
    const answers = Object.fromEntries(keys.map((k) => [k, `${t.answers[k]} ${values[k]}${t.units[k] ? ` ${t.units[k]}` : ""}`.replace("$ ", "$")]));
    const target = pick(r, keys);
    // «pergunta»: a própria pergunta é o botão; «mais»: um botão «+» igual ao lado de cada uma (só o vizinho distingue).
    const mode = pick(r, ["pergunta", "mais"]);
    return {
      ...base,
      goal: `Abra a pergunta sobre ${GOAL_Q[target]} nas perguntas frequentes.`,
      fills: [],
      success: { kind: "text", value: answers[target] },
      view: { title: t.faq, keys, questions: t.questions, answers, mode, expand: t.expand },
      solve: [mode === "pergunta" ? { click: t.questions[target] } : { click: t.expand, near: t.questions[target] }],
    };
  }

  if (family === "paginacao") {
    const per = int(r, 4, 6);
    const products = sample(r, PRODUCTS, per * int(r, 3, 4));
    // Sempre fora da primeira página.
    const index = per + Math.floor(r() * (products.length - per));
    const target = products[index];
    const mode = pick(r, ["proxima", "mais"]);
    const pageOf = Math.floor(index / per);
    const solve = [];
    for (let p = 0; p < pageOf; p++) solve.push({ click: mode === "proxima" ? t.next : t.more });
    solve.push({ click: t.add, near: target });
    return {
      ...base,
      goal: `Adicione «${target}» ao carrinho.`,
      fills: [],
      success: { kind: "text", value: `${t.cart}: 1 · ${target}` },
      view: { products, per, mode, cart: t.cart, add: t.add, next: t.next, more: t.more, page: t.page },
      solve,
    };
  }

  if (family === "selecao") {
    const product = pick(r, PRODUCTS);
    const kind = pick(r, ["tamanho", "cor"]);
    const options = kind === "tamanho"
      ? sample(r, ["P", "M", "G", "GG", "38", "40", "42", "44"], int(r, 4, 5))
      : sample(r, Object.keys(t.colors), int(r, 3, 5)).map((k) => t.colors[k]);
    const colorKey = (label) => Object.keys(t.colors).find((k) => t.colors[k] === label);
    // A primeira opção já vem marcada na lista nativa: o alvo é outra.
    const target = options[1 + Math.floor(r() * (options.length - 1))];
    const mode = pick(r, ["nativa", "lista"]);
    const confirm = pick(r, t.confirm);
    const label = kind === "tamanho" ? t.size : t.color;
    return {
      ...base,
      goal: kind === "tamanho" ? `Escolha o tamanho ${target} do produto «${product}» e confirme.` : `Escolha a cor ${GOAL_COLOR[colorKey(target)]} do produto «${product}» e confirme.`,
      fills: [],
      success: { kind: "text", value: `${t.chosen}: ${label} ${target}` },
      view: { product, label, options, mode, confirm, choose: t.choose, chosen: t.chosen },
      solve: mode === "nativa" ? [{ select: [label, target] }, { click: confirm }] : [{ click: `${t.choose} ${label.toLowerCase()}` }, { click: target }, { click: confirm }],
    };
  }

  if (family === "confirmacao") {
    const items = sample(r, PRODUCTS, int(r, 3, 4));
    const target = pick(r, items);
    const yes = pick(r, t.yes);
    const no = pick(r, t.no);
    return {
      ...base,
      goal: `Remova «${target}» do carrinho.`,
      fills: [],
      // O item certo saiu E só ele: dois removidos deixariam a contagem errada.
      success: { kind: "all", of: [{ kind: "text", value: `${t.removed}: ${target}` }, { kind: "text", value: `${t.items}: ${items.length - 1}` }] },
      view: { items, remove: t.remove, sure: t.sure, yes, no, removed: t.removed, itemsLabel: t.items, cart: t.cart },
      solve: [{ click: t.remove, near: target }, { click: yes }],
    };
  }

  if (family === "quantidade") {
    const product = pick(r, PRODUCTS);
    const others = sample(r, PRODUCTS.filter((p) => p !== product), 2);
    const qty = int(r, 2, 4);
    const mode = pick(r, ["botoes", "campo"]);
    const solve = mode === "botoes"
      ? [...Array.from({ length: qty - 1 }, () => ({ click: t.plus })), { click: t.add }]
      : [{ fill: [t.qty, String(qty)] }, { click: t.add }];
    return {
      ...base,
      goal: `Adicione ${qty} unidades de «${product}» ao carrinho.`,
      fills: mode === "campo" ? [`${t.qty}=${qty}`] : [],
      success: { kind: "text", value: `${t.cart}: ${qty} · ${product}` },
      view: { product, others: shuffle(r, [product, ...others]), mode, qty: t.qty, plus: t.plus, minus: t.minus, add: t.add, cart: t.cart },
      solve,
    };
  }

  // menu
  const cats = sample(r, Object.keys(t.cats), int(r, 4, 5));
  const target = pick(r, cats);
  const mode = pick(r, ["topo", "lateral"]);
  const opener = mode === "topo" ? t.categories : t.menu;
  return {
    ...base,
    goal: `Abra a categoria ${GOAL_CAT[target]} pelo menu da loja.`,
    fills: [],
    success: { kind: "all", of: [{ kind: "url", value: `cat=${target}` }, { kind: "text", value: `${t.category}: ${t.cats[target]}` }] },
    view: { cats, labels: t.cats, mode, opener, category: t.category },
    solve: [{ click: opener }, { follow: t.cats[target] }],
  };
}
