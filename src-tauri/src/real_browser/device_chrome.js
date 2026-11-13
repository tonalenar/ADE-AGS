// A parte da moldura do aparelho que fica DENTRO da página, para o conteúdo passar por baixo dela:
// - iPhone (iOS 26): a barra de status quase transparente em volta da ilha, a barra de vidro flutuante do Safari e a
//   barra de início. A página começa abaixo da barra de status (margem no <html>), e os cabeçalhos fixos/grudados no
//   topo descem a mesma altura; ao rolar, o conteúdo passa por trás do vidro.
// - Android: a barra de status e a barra do Chrome são opacas no topo, como no Chrome real, e ficam no app
//   (PhoneChrome.tsx), fora da página. Aqui só a alça de gestos, por cima da página, que vai até o fim da tela.
// - Os dois: os cantos arredondados da tela. A vista nativa é retangular e o recorte dela no macOS não pega; os cantos
//   são desenhados por cima da página, na cor da moldura, e nada vaza pela curva.
// Os botões funcionam: voltar e recarregar aqui mesmo; o endereço, as abas e o menu vão ao app pela ponte (mensagens
// `ags-preview` com tipo `device:*`, que o app aceita só desta lista fechada).
// A moldura entra e sai ao vivo (o app roda este script no documento aberto e `__agsDeviceChromeStop` a tira), sem
// recarregar a página quando só a moldura muda.
// `__AGS_PLATFORM__` e `__AGS_LABELS__` são trocados pelo backend.
(() => {
  if (window.top !== window) return;
  if (typeof window.__agsDeviceChromeStop === "function") window.__agsDeviceChromeStop();
  const platform = "__AGS_PLATFORM__";
  const L = __AGS_LABELS__;
  const ios = platform === "ios";
  // A cor da moldura (`phoneScreen` em ResponsiveStage.tsx) e o raio da tela, em px da página.
  const BEZEL = "#0b0b0d";
  const RADIUS = ios ? 52 : 34;
  const STATUS = ios ? 54 : 0;
  const cleanup = [];
  let stopped = false;
  Object.defineProperty(window, "__agsDeviceChromeStop", {
    configurable: true,
    value: () => {
      stopped = true;
      for (const fn of cleanup.splice(0)) { try { fn(); } catch (_) {} }
      try { delete window.__agsDeviceChromeStop; } catch (_) {}
    },
  });
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); cleanup.push(() => target.removeEventListener(type, fn, opts)); };
  const every = (fn, ms) => { const t = setInterval(fn, ms); cleanup.push(() => clearInterval(t)); };

  // Página escura (fundo do body ou do html): a barra e a alça ficam claras.
  const darkPage = () => {
    for (const node of [document.body, document.documentElement]) {
      if (!node) continue;
      const m = getComputedStyle(node).backgroundColor.match(/\d+(\.\d+)?/g);
      if (!m || (m.length >= 4 && +m[3] < 0.5)) continue;
      return (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) < 110;
    }
    return false;
  };
  const corner = (v, h) => `<span class="corner" style="${v}:0;${h}:0;background:radial-gradient(circle at ${h === "left" ? RADIUS : 0}px ${v === "top" ? RADIUS : 0}px, transparent ${RADIUS - 0.75}px, ${BEZEL} ${RADIUS}px)"></span>`;
  const corners = (ios ? corner("top", "left") + corner("top", "right") : "") + corner("bottom", "left") + corner("bottom", "right");
  const send = (type, extra) => window.postMessage(Object.assign({ source: "ags-preview", type }, extra || {}), "*");
  const host = () => (location.hostname || location.href).replace(/^www\./, "");
  const clock = () => { const d = new Date(); return d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0"); };
  const landscape = () => innerWidth > innerHeight;
  const ic = {
    back: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 4 6.5 10l6 6"/></svg>',
    reload: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M16 10a6 6 0 1 1-1.8-4.3"/><path d="M15.5 2.5v4h-4"/></svg>',
    menu: '<svg width="18" height="14" viewBox="0 0 18 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 2h14M2 7h14M2 12h10"/></svg>',
    tabs: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="2.5" y="6" width="11" height="11" rx="2.6"/><path d="M6.5 3.2h8a2.8 2.8 0 0 1 2.8 2.8v8"/></svg>',
    signal: '<svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx=".8"/><rect x="5" y="5.5" width="3" height="6.5" rx=".8"/><rect x="10" y="3" width="3" height="9" rx=".8"/><rect x="15" y="0" width="3" height="12" rx=".8"/></svg>',
    wifi: '<svg width="17" height="12" viewBox="0 0 17 12" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M1.2 4.2a10 10 0 0 1 14.6 0"/><path d="M3.9 7a6.2 6.2 0 0 1 9.2 0"/><circle cx="8.5" cy="10" r="1.1" fill="currentColor" stroke="none"/></svg>',
    battery: '<svg width="27" height="13" viewBox="0 0 27 13" fill="none"><rect x=".5" y=".5" width="23" height="12" rx="3.6" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="17" height="9" rx="2.2" fill="currentColor"/><path d="M25 4.5v4c.9-.3 1.5-1.2 1.5-2s-.6-1.7-1.5-2Z" fill="currentColor" opacity=".45"/></svg>',
  };
  const css = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "SF Pro Text", system-ui, sans-serif; -webkit-tap-highlight-color: transparent; }
    .layer { position: fixed; inset: 0; pointer-events: none; color: #000; }
    .layer.dark { color: #fff; }
    .corner { position: absolute; width: ${RADIUS}px; height: ${RADIUS}px; pointer-events: none; }
    .gesture { position: absolute; left: 50%; bottom: 9px; transform: translateX(-50%); width: 108px; height: 4px; border-radius: 2px; background: rgba(0,0,0,.72); }
    .dark .gesture { background: rgba(255,255,255,.82); }
    button { pointer-events: auto; border: 0; background: none; color: inherit; display: grid; place-items: center; cursor: pointer; padding: 0; }
    /* iOS 26: quase transparente. Um desfoque leve que some para baixo e um véu suave, sem tingir a página. */
    .status { position: absolute; top: 0; left: 0; right: 0; height: ${STATUS}px; display: flex; align-items: flex-end; justify-content: space-between; padding: 0 32px 8px; }
    .status::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: ${STATUS + 18}px; z-index: -1;
      background: linear-gradient(to bottom, rgba(255,255,255,.72), rgba(255,255,255,.38) 55%, rgba(255,255,255,0));
      backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
      -webkit-mask-image: linear-gradient(to bottom, #000 45%, transparent); mask-image: linear-gradient(to bottom, #000 45%, transparent); }
    .dark .status::before { background: linear-gradient(to bottom, rgba(0,0,0,.6), rgba(0,0,0,.3) 55%, rgba(0,0,0,0)); }
    .status .time { width: 100px; text-align: center; font-size: 17px; font-weight: 600; letter-spacing: -.3px; }
    .status .icons { width: 100px; display: flex; gap: 6px; align-items: center; justify-content: center; }
    .island { position: absolute; top: 11px; left: 50%; transform: translateX(-50%); width: 118px; height: 34px; border-radius: 17px; background: #000; }
    .glass { background: rgba(255,255,255,.62); backdrop-filter: blur(18px) saturate(1.8); -webkit-backdrop-filter: blur(18px) saturate(1.8);
      box-shadow: 0 6px 24px rgba(0,0,0,.14), inset 0 0 0 .5px rgba(255,255,255,.7), inset 0 1px 0 rgba(255,255,255,.9); color: #000; }
    .dark .glass { background: rgba(40,40,44,.6); box-shadow: 0 6px 24px rgba(0,0,0,.4), inset 0 0 0 .5px rgba(255,255,255,.15); color: #fff; }
    .bar { position: absolute; left: 14px; right: 14px; bottom: 30px; display: flex; gap: 8px; align-items: center; }
    .round { width: 48px; height: 48px; border-radius: 50%; flex: none; }
    .pill { pointer-events: auto; flex: 1; height: 48px; border-radius: 24px; display: flex; align-items: center; gap: 10px; padding: 0 16px; font-size: 16px; min-width: 0; }
    .addr { flex: 1; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: text; }
    input.addr { pointer-events: auto; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; text-align: left; min-width: 0; }
    .home { position: absolute; bottom: 8px; left: 50%; transform: translateX(-50%); width: 134px; height: 5px; border-radius: 3px; background: currentColor; }
    .sheet { pointer-events: auto; position: absolute; left: 14px; right: 14px; bottom: 88px; border-radius: 22px; padding: 6px; display: none; }
    .sheet.open { display: block; }
    .sheet button { width: 100%; display: flex; justify-content: flex-start; height: 44px; padding: 0 14px; border-radius: 14px; font-size: 16px; }
    .sheet button:active { background: rgba(127,127,127,.18); }
    .land .status, .land .island, .land .home, .land .gesture { display: none; }
    .land .bar { left: 50%; right: auto; width: 420px; transform: translateX(-50%); bottom: 12px; }
    .land .sheet { left: 50%; right: auto; width: 420px; transform: translateX(-50%); bottom: 70px; }
  `;
  const iosParts = `
      <div class="status"><span class="time"></span><span class="icons">${ic.signal}${ic.wifi}${ic.battery}</span></div><span class="island"></span>
      <div class="sheet glass">
        <button data-a="share">${L.share}</button>
        <button data-a="desktop">${L.desktop}</button>
        <button data-a="reload">${L.reload}</button>
      </div>
      <div class="bar">
        <button class="round glass" data-a="back" aria-label="${L.back}">${ic.back}</button>
        <div class="pill glass"><button data-a="menu" aria-label="${L.menu}">${ic.menu}</button><span class="addr" data-a="edit"></span><button data-a="reload" aria-label="${L.reload}">${ic.reload}</button></div>
        <button class="round glass" data-a="tabs" aria-label="${L.tabs}">${ic.tabs}</button>
      </div><span class="home"></span>`;

  // A página começa abaixo da barra de status (só iPhone em retrato). A margem no <html> não muda o fundo.
  const offset = document.createElement("style");
  offset.textContent = `html { margin-top: ${STATUS}px !important; }`;
  cleanup.push(() => offset.remove());

  // Cabeçalhos `fixed`/`sticky` no topo descem a altura da barra (como no Safari). Varredura limitada e só quando o
  // DOM muda, no máximo a cada 300 ms; overlays de tela inteira ficam.
  const moved = new Map();
  cleanup.push(() => { for (const [node] of moved) node.style.removeProperty("top"); moved.clear(); });
  let scheduled = 0;
  cleanup.push(() => clearTimeout(scheduled));
  const fixTop = () => {
    scheduled = 0;
    if (stopped || !ios) return;
    const shift = landscape() ? 0 : STATUS;
    const all = document.body ? document.body.getElementsByTagName("*") : [];
    const limit = Math.min(all.length, 6000);
    for (let i = 0; i < limit; i++) {
      const node = all[i];
      if (node.id === "__ags-device-chrome") continue;
      const was = moved.get(node);
      const cs = getComputedStyle(node);
      if (cs.position !== "fixed" && cs.position !== "sticky") {
        if (was !== undefined) { node.style.removeProperty("top"); moved.delete(node); }
        continue;
      }
      const original = was !== undefined ? was : cs.top;
      if (original === "auto" || !/px$/.test(original)) continue;
      const top = parseFloat(original);
      if (top >= STATUS) continue;
      if (node.getBoundingClientRect().height >= innerHeight * 0.85) continue;
      if (was === undefined) moved.set(node, original);
      const want = `${top + shift}px`;
      if (node.style.getPropertyValue("top") !== want) node.style.setProperty("top", want, "important");
    }
  };
  const schedule = () => { if (!scheduled && !stopped) scheduled = setTimeout(fixTop, 300); };

  let el = null;
  let root = null;
  let addr = null;
  let pressed = null;

  const edit = () => {
    if (!addr || addr.tagName === "INPUT") return;
    const input = document.createElement("input");
    input.className = "addr";
    input.value = location.href;
    input.setAttribute("enterkeyhint", "go");
    input.setAttribute("aria-label", L.address);
    addr.replaceWith(input);
    addr = input;
    input.focus();
    input.select();
    input.addEventListener("blur", () => setTimeout(() => { if (addr === input && root && root.activeElement !== input) closeEdit(); }, 0));
  };
  const closeEdit = () => {
    if (!addr || addr.tagName !== "INPUT") return;
    const span = document.createElement("span");
    span.className = "addr";
    span.dataset.a = "edit";
    span.textContent = host();
    addr.replaceWith(span);
    addr = span;
  };
  const act = (a) => {
    const sheet = root.querySelector(".sheet");
    const what = a.dataset.a;
    if (what !== "menu") sheet.classList.remove("open");
    if (what === "back") history.back();
    else if (what === "reload") location.reload();
    else if (what === "edit") edit();
    else if (what === "menu") sheet.classList.toggle("open");
    else if (what === "tabs") send("device:tabs");
    else if (what === "share") send("device:share", { url: location.href });
    else if (what === "desktop") send("device:desktop");
  };
  // O que está sob o ponteiro dentro da moldura (o evento chega à janela já reapontado para o hospedeiro).
  const inner = (e) => (root && typeof e.clientX === "number" ? root.elementFromPoint(e.clientX, e.clientY) : null);
  const ours = (e) => !!el && (e.target === el || (e.composedPath && e.composedPath()[0] === el));

  // Os eventos da moldura são tratados na janela, em captura, ANTES de qualquer script da página (este script roda
  // primeiro em todo documento): um site que cancela o `touchstart`, para a propagação no documento ou tem atalhos
  // de teclado não deixa a barra morta. E nenhum desses eventos chega à página.
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "touchstart", "touchend", "touchmove"]) {
    on(window, type, (e) => {
      if (!ours(e)) return;
      if (type === "pointerdown") {
        const node = inner(e);
        pressed = node && node.closest ? node.closest("[data-a]") : null;
        if (!(node && node.closest && node.closest("input"))) e.preventDefault();
      } else if (type === "pointerup") {
        const node = inner(e);
        const a = node && node.closest ? node.closest("[data-a]") : null;
        const was = pressed;
        pressed = null;
        if (!a) { if (!(node && node.closest && node.closest(".sheet, .bar"))) root.querySelector(".sheet").classList.remove("open"); }
        else if (a === was) act(a);
      } else if (type === "contextmenu" || type === "touchstart" || type === "touchmove") {
        const node = inner(e);
        if (!(node && node.closest && node.closest("input"))) e.preventDefault();
      }
      e.stopImmediatePropagation();
    }, { capture: true, passive: false });
  }
  for (const type of ["keydown", "keypress", "keyup", "input", "beforeinput"]) {
    on(window, type, (e) => {
      if (!addr || addr.tagName !== "INPUT" || !el || document.activeElement !== el) return;
      e.stopImmediatePropagation();
      if (type !== "keydown") return;
      if (e.key === "Enter") {
        e.preventDefault();
        const text = addr.value.trim();
        closeEdit();
        if (text) send("device:navigate", { text });
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeEdit();
      }
    }, { capture: true });
  }

  const mount = () => {
    if (stopped || !document.documentElement || (el && el.isConnected)) return;
    el = document.createElement("ags-device-chrome");
    el.id = "__ags-device-chrome";
    el.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block";
    root = el.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>${css}</style><div class="layer">${ios ? iosParts : '<span class="gesture"></span>'}${corners}</div>`;
    addr = root.querySelector(".addr");
    const layer = root.querySelector(".layer");
    const tick = () => {
      if (stopped) return;
      const land = landscape();
      layer.classList.toggle("land", land);
      if (ios) {
        if (land) offset.remove(); else if (!offset.isConnected) (document.head || document.documentElement).appendChild(offset);
        root.querySelector(".time").textContent = clock();
        if (addr && addr.tagName === "SPAN") addr.textContent = host();
        schedule();
      }
      layer.classList.toggle("dark", darkPage());
    };
    document.documentElement.appendChild(el);
    const node = el;
    cleanup.push(() => node.remove());
    tick();
    every(tick, 15000);
    on(window, "resize", tick);
    on(window, "load", tick);
    // Páginas que reescrevem o <html> inteiro tiram a moldura; põe de volta.
    const keep = new MutationObserver(() => { if (!stopped && !node.isConnected) document.documentElement.appendChild(node); });
    keep.observe(document.documentElement, { childList: true });
    cleanup.push(() => keep.disconnect());
    if (ios) {
      const watch = new MutationObserver(schedule);
      watch.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"] });
      cleanup.push(() => watch.disconnect());
      on(window, "scroll", schedule, { passive: true });
    }
  };
  if (document.documentElement) mount();
  on(document, "DOMContentLoaded", mount);
})();
