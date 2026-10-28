// Desenha uma variante do conjunto de TESTE 2 (`scenario2.js`) num `document` qualquer: a página `loja2.html` e os testes
// (happy-dom) usam a mesma função. O que não está à vista não está no DOM (painel de aba fechado, resposta recolhida,
// página seguinte da lista): o critério só vale depois da ação, na página e no teste.

/** `render(document, cenário, "?f=…&s=…&cat=…")`: desenha tudo em `document.body`. */
export function render(doc, s, search = "") {
  const params = new URLSearchParams(search);
  const v = s.view;
  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(doc.createElement(tag), props);
    for (const [key, value] of Object.entries(props.attrs ?? {})) node.setAttribute(key, value);
    for (const child of children) node.append(child);
    return node;
  };
  doc.documentElement.lang = s.lang;
  const status = el("span", { id: "cart", className: "cartline" });
  const header = el("header", {}, el("b", { textContent: s.store }), el("span", { className: "space" }), status);
  const main = el("main");
  doc.body.replaceChildren(header, main);

  if (s.family === "abas") {
    let active = v.keys[0];
    const tablist = el("div", { className: "row", attrs: { role: "tablist" } });
    const panel = el("div", { className: "panel", attrs: { role: "tabpanel" } });
    const draw = () => {
      tablist.replaceChildren(...v.keys.map((key) => {
        const props = { textContent: v.labels[key], attrs: { role: "tab", "aria-selected": String(key === active) }, className: key === active ? "tab on" : "tab" };
        const tab = v.mode === "links" ? el("a", { ...props, href: `#${key}` }) : el("button", { ...props, type: "button" });
        tab.addEventListener("click", (event) => { event.preventDefault(); active = key; draw(); });
        return tab;
      }));
      panel.replaceChildren(el("p", { textContent: v.content[active] }));
    };
    main.append(el("h1", { textContent: v.product }), tablist, panel);
    draw();
  }

  if (s.family === "acordeao") {
    const open = new Set();
    const list = el("div");
    const draw = () => {
      list.replaceChildren(...v.keys.map((key) => {
        const expanded = open.has(key);
        const toggle = () => { if (open.has(key)) open.delete(key); else open.add(key); draw(); };
        const row = el("div", { className: "q" });
        if (v.mode === "pergunta") {
          const button = el("button", { type: "button", textContent: v.questions[key], className: "link", attrs: { "aria-expanded": String(expanded) } });
          button.addEventListener("click", toggle);
          row.append(button);
        } else {
          const button = el("button", { type: "button", textContent: expanded ? "−" : "+", className: "plus", attrs: { "aria-label": v.expand, "aria-expanded": String(expanded) } });
          button.addEventListener("click", toggle);
          row.append(el("span", { textContent: v.questions[key] }), button);
        }
        if (expanded) row.append(el("p", { className: "answer", textContent: v.answers[key] }));
        return row;
      }));
    };
    main.append(el("h1", { textContent: v.title }), list);
    draw();
  }

  if (s.family === "paginacao") {
    let page = 0;
    status.textContent = `${v.cart}: 0`;
    const grid = el("div", { className: "grid" });
    const nav = el("div", { className: "row" });
    const pages = Math.ceil(v.products.length / v.per);
    const draw = () => {
      const shown = v.mode === "mais" ? v.products.slice(0, (page + 1) * v.per) : v.products.slice(page * v.per, (page + 1) * v.per);
      grid.replaceChildren(...shown.map((name) => {
        const add = el("button", { type: "button", textContent: v.add });
        add.addEventListener("click", () => { status.textContent = `${v.cart}: 1 · ${name}`; });
        return el("div", { className: "card" }, el("h3", { textContent: name }), el("div", { className: "price", textContent: `R$ ${(39 + name.length * 9).toFixed(2).replace(".", ",")}` }), add);
      }));
      const more = el("button", { type: "button", textContent: v.mode === "mais" ? v.more : v.next, className: "gray" });
      more.addEventListener("click", () => { page += 1; draw(); });
      nav.replaceChildren(...(v.mode === "proxima" ? [el("span", { textContent: `${v.page} ${page + 1} / ${pages}` })] : []), ...(page + 1 < pages ? [more] : []));
    };
    main.append(el("h1", { textContent: s.store }), grid, nav);
    draw();
  }

  if (s.family === "selecao") {
    let current = v.options[0];
    const out = el("div", { id: "status" });
    const confirm = el("button", { type: "button", textContent: v.confirm });
    confirm.addEventListener("click", () => { out.textContent = `${v.chosen}: ${v.label} ${current}`; });
    main.append(el("h1", { textContent: v.product }));
    if (v.mode === "nativa") {
      const select = el("select", { id: "escolha" }, ...v.options.map((option) => el("option", { value: option, textContent: option })));
      select.addEventListener("change", () => { current = select.value; });
      main.append(el("label", { htmlFor: "escolha", textContent: v.label }), select);
    } else {
      let openList = false;
      const box = el("div", { className: "dropdown" });
      const draw = () => {
        const opener = el("button", { type: "button", textContent: `${v.choose} ${v.label.toLowerCase()}`, attrs: { "aria-haspopup": "listbox", "aria-expanded": String(openList) } });
        opener.addEventListener("click", () => { openList = !openList; draw(); });
        const parts = [opener, el("span", { textContent: ` ${v.label}: ${current}` })];
        if (openList) {
          parts.push(el("ul", { className: "list", attrs: { role: "listbox" } }, ...v.options.map((option) => {
            const item = el("li", { textContent: option, tabIndex: 0, attrs: { role: "option", "aria-selected": String(option === current) } });
            item.addEventListener("click", () => { current = option; openList = false; draw(); });
            return item;
          })));
        }
        box.replaceChildren(...parts);
      };
      main.append(box);
      draw();
    }
    main.append(el("div", { className: "row" }, confirm), out);
  }

  if (s.family === "confirmacao") {
    const items = v.items.slice();
    const removed = [];
    const list = el("ul", { className: "list" });
    const overlay = el("div", { className: "overlay", hidden: true });
    const box = el("div", { className: "box", attrs: { role: "dialog" } });
    overlay.append(box);
    const close = () => { overlay.hidden = true; box.replaceChildren(); };
    const draw = () => {
      status.textContent = `${v.itemsLabel}: ${items.length}`;
      list.replaceChildren(...items.map((name) => {
        const remove = el("button", { type: "button", textContent: v.remove, className: "red" });
        remove.addEventListener("click", () => {
          const yes = el("button", { type: "button", textContent: v.yes, className: "red" });
          const no = el("button", { type: "button", textContent: v.no, className: "gray" });
          yes.addEventListener("click", () => { items.splice(items.indexOf(name), 1); removed.push(name); close(); draw(); });
          no.addEventListener("click", close);
          box.replaceChildren(el("p", { textContent: `${v.sure} ${name}?` }), yes, no);
          overlay.hidden = false;
        });
        return el("li", { className: "row" }, el("span", { textContent: name }), remove);
      }));
      log.replaceChildren(...removed.map((name) => el("div", { textContent: `${v.removed}: ${name}` })));
    };
    const log = el("div", { id: "status" });
    main.append(el("h1", { textContent: v.cart }), log, list);
    doc.body.append(overlay);
    draw();
  }

  if (s.family === "quantidade") {
    let qty = 1;
    status.textContent = `${v.cart}: 0`;
    const add = el("button", { type: "button", textContent: v.add });
    add.addEventListener("click", () => { status.textContent = `${v.cart}: ${qty} · ${v.product}`; });
    const control = el("div", { className: "row" });
    if (v.mode === "botoes") {
      const value = el("span", { textContent: String(qty), className: "qty" });
      const minus = el("button", { type: "button", textContent: "−", className: "gray", attrs: { "aria-label": v.minus } });
      const plus = el("button", { type: "button", textContent: "+", className: "gray", attrs: { "aria-label": v.plus } });
      minus.addEventListener("click", () => { qty = Math.max(1, qty - 1); value.textContent = String(qty); });
      plus.addEventListener("click", () => { qty += 1; value.textContent = String(qty); });
      control.append(minus, value, plus);
    } else {
      const input = el("input", { id: "qtd", type: "number", min: "1", value: "1" });
      const sync = () => { const n = Number.parseInt(input.value, 10); qty = Number.isFinite(n) && n > 0 ? n : 1; };
      input.addEventListener("input", sync);
      input.addEventListener("change", sync);
      control.append(el("label", { htmlFor: "qtd", textContent: v.qty }), input);
    }
    const also = v.others.filter((name) => name !== v.product);
    main.append(
      el("h1", { textContent: v.product }),
      el("div", { className: "price", textContent: `R$ ${(59 + v.product.length * 7).toFixed(2).replace(".", ",")}` }),
      control, el("div", { className: "row" }, add),
      el("h2", { textContent: "—" }), el("ul", { className: "list" }, ...also.map((name) => el("li", { textContent: name }))),
    );
  }

  if (s.family === "menu") {
    const chosen = params.get("cat");
    let openNav = false;
    const nav = el("nav");
    const draw = () => {
      const opener = el("button", { type: "button", textContent: v.mode === "topo" ? v.opener : "☰", className: "gray", attrs: { "aria-expanded": String(openNav), ...(v.mode === "lateral" ? { "aria-label": v.opener } : {}) } });
      opener.addEventListener("click", () => { openNav = !openNav; draw(); });
      const links = openNav ? [el("ul", { className: "list" }, ...v.cats.map((key) => el("li", {}, el("a", { href: `?f=menu&s=${s.seed}&cat=${key}`, textContent: v.labels[key] }))))] : [];
      nav.replaceChildren(opener, ...links);
    };
    header.insertBefore(nav, header.children[1]);
    main.append(el("h1", { textContent: chosen && v.labels[chosen] ? `${v.category}: ${v.labels[chosen]}` : s.store }));
    draw();
  }
}
