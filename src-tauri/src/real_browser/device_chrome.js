// A parte da moldura do aparelho que fica DENTRO da página, para o conteúdo passar por baixo dela:
// - iPhone (iOS 26): a barra de status translúcida em volta da ilha, a barra de vidro flutuante do Safari e a barra
//   de início. A página começa abaixo da barra de status (margem no <html>), e os cabeçalhos fixos/grudados no topo
//   descem a mesma altura, então nada fica embaixo da hora e da ilha; ao rolar, o conteúdo passa por trás do vidro.
// - Android: nada aqui. A barra de status e a barra do Chrome são opacas no topo, como no Chrome real, e ficam no app
//   (PhoneChrome.tsx), fora da página.
// Os botões funcionam: voltar e recarregar aqui mesmo; o endereço, as abas e o menu vão ao app pela ponte (mensagens
// `ags-preview` com tipo `device:*`, que o app aceita só desta lista fechada).
// `__AGS_PLATFORM__` e `__AGS_LABELS__` são trocados pelo backend.
(() => {
  if (window.top !== window || window.__ags_device_chrome) return;
  Object.defineProperty(window, "__ags_device_chrome", { value: true });
  const platform = "__AGS_PLATFORM__";
  if (platform !== "ios") return;
  const L = __AGS_LABELS__;
  const STATUS = 54;
  const send = (type, extra) => window.postMessage(Object.assign({ source: "ags-preview", type }, extra || {}), "*");
  const host = () => (location.hostname || location.href).replace(/^www\./, "");
  const clock = () => { const d = new Date(); return d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0"); };
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
    button { pointer-events: auto; border: 0; background: none; color: inherit; display: grid; place-items: center; cursor: pointer; padding: 0; }
    .status { position: absolute; top: 0; left: 0; right: 0; height: ${STATUS}px; display: flex; align-items: flex-end; justify-content: space-between; padding: 0 32px 8px;
      background: rgba(255,255,255,.55); backdrop-filter: blur(14px) saturate(1.6); -webkit-backdrop-filter: blur(14px) saturate(1.6); }
    .dark .status { background: rgba(20,20,22,.5); }
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
    .land .status, .land .island, .land .home { display: none; }
    .land .bar { left: 50%; right: auto; width: 420px; transform: translateX(-50%); bottom: 12px; }
    .land .sheet { left: 50%; right: auto; width: 420px; transform: translateX(-50%); bottom: 70px; }
  `;

  // A página começa abaixo da barra de status. A margem no <html> não muda o fundo (o canvas o estende por baixo da
  // barra translúcida). Só em retrato: deitado, o iPhone esconde a barra de status.
  const offset = document.createElement("style");
  offset.textContent = `html { margin-top: ${STATUS}px !important; }`;
  const landscape = () => innerWidth > innerHeight;

  // Cabeçalhos `fixed`/`sticky` no topo: descem a altura da barra (como no Safari, onde o topo da janela fica abaixo
  // dela). Varredura limitada e só quando o DOM muda, no máximo a cada 300 ms; overlays de tela inteira ficam.
  const moved = new WeakMap();
  let scheduled = 0;
  const fixTop = () => {
    scheduled = 0;
    const shift = landscape() ? 0 : STATUS;
    const all = document.body ? document.body.getElementsByTagName("*") : [];
    const limit = Math.min(all.length, 6000);
    for (let i = 0; i < limit; i++) {
      const el = all[i];
      if (el.id === "__ags-device-chrome") continue;
      const was = moved.get(el);
      const cs = getComputedStyle(el);
      const pos = cs.position;
      if (pos !== "fixed" && pos !== "sticky") {
        if (was !== undefined) { el.style.removeProperty("top"); moved.delete(el); }
        continue;
      }
      const original = was !== undefined ? was : cs.top;
      if (original === "auto" || !/px$/.test(original)) continue;
      const top = parseFloat(original);
      if (top >= STATUS) continue;
      const r = el.getBoundingClientRect();
      if (r.height >= innerHeight * 0.85) continue;
      if (was === undefined) moved.set(el, original);
      const want = `${top + shift}px`;
      if (el.style.getPropertyValue("top") !== want) el.style.setProperty("top", want, "important");
    }
  };
  const schedule = () => { if (!scheduled) scheduled = setTimeout(fixTop, 300); };

  const mount = () => {
    if (!document.documentElement || document.getElementById("__ags-device-chrome")) return;
    const el = document.createElement("ags-device-chrome");
    el.id = "__ags-device-chrome";
    el.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block";
    const root = el.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>${css}</style><div class="layer">
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
      </div><span class="home"></span></div>`;
    const layer = root.querySelector(".layer");
    const sheet = root.querySelector(".sheet");
    let addr = root.querySelector(".addr");
    const tick = () => {
      const land = landscape();
      layer.classList.toggle("land", land);
      if (land) offset.remove(); else if (!offset.isConnected) (document.head || document.documentElement).appendChild(offset);
      // Barra clara ou escura conforme o fundo da página.
      const bg = getComputedStyle(document.body || document.documentElement).backgroundColor;
      const m = bg.match(/\d+(\.\d+)?/g);
      const dark = m && (m.length < 4 || +m[3] > 0.5) && (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) < 110;
      layer.classList.toggle("dark", !!dark);
      root.querySelector(".time").textContent = clock();
      if (addr.tagName === "SPAN") addr.textContent = host();
      schedule();
    };
    const edit = () => {
      if (addr.tagName === "INPUT") return;
      const input = document.createElement("input");
      input.className = "addr";
      input.value = location.href;
      input.setAttribute("enterkeyhint", "go");
      input.setAttribute("aria-label", L.address);
      addr.replaceWith(input);
      addr = input;
      input.focus();
      input.select();
      const done = () => {
        if (addr !== input) return;
        const span = document.createElement("span");
        span.className = "addr";
        span.dataset.a = "edit";
        span.textContent = host();
        input.replaceWith(span);
        addr = span;
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { const text = input.value.trim(); done(); if (text) send("device:navigate", { text }); }
        if (e.key === "Escape") done();
      });
      input.addEventListener("blur", done);
    };
    root.addEventListener("click", (e) => {
      const a = e.target.closest && e.target.closest("[data-a]");
      if (!a) { sheet.classList.remove("open"); return; }
      const act = a.dataset.a;
      if (act !== "menu") sheet.classList.remove("open");
      if (act === "back") history.back();
      else if (act === "reload") location.reload();
      else if (act === "edit") edit();
      else if (act === "menu") sheet.classList.toggle("open");
      else if (act === "tabs") send("device:tabs");
      else if (act === "share") send("device:share", { url: location.href });
      else if (act === "desktop") send("device:desktop");
    });
    document.documentElement.appendChild(el);
    tick();
    setInterval(tick, 15000);
    addEventListener("resize", tick);
    addEventListener("load", tick);
    // Páginas que reescrevem o <html> inteiro tiram a moldura; põe de volta.
    new MutationObserver(() => { if (!el.isConnected) document.documentElement.appendChild(el); })
      .observe(document.documentElement, { childList: true });
    new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"] });
    addEventListener("scroll", schedule, { passive: true });
  };
  if (document.documentElement) mount();
  document.addEventListener("DOMContentLoaded", mount);
})();
