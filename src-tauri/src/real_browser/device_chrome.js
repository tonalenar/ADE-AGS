// A moldura do aparelho DENTRO da página: barra de status (hora, rede, bateria, ilha ou câmera) e a barra do
// navegador do sistema (Safari do iOS 26 com vidro flutuante, Chrome do Android). A página passa por baixo das
// barras; só os botões recebem clique. `__AGS_PLATFORM__` é trocado pelo backend por "ios" ou "android".
(() => {
  if (window.top !== window || window.__ags_device_chrome) return;
  Object.defineProperty(window, "__ags_device_chrome", { value: true });
  const platform = "__AGS_PLATFORM__";
  const ios = platform === "ios";
  const host = () => (location.hostname || location.href).replace(/^www\./, "");
  const clock = () => { const d = new Date(); return d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0"); };
  const signal = '<svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx=".8"/><rect x="5" y="5.5" width="3" height="6.5" rx=".8"/><rect x="10" y="3" width="3" height="9" rx=".8"/><rect x="15" y="0" width="3" height="12" rx=".8"/></svg>';
  const wifi = '<svg width="17" height="12" viewBox="0 0 17 12" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M1.2 4.2a10 10 0 0 1 14.6 0"/><path d="M3.9 7a6.2 6.2 0 0 1 9.2 0"/><circle cx="8.5" cy="10" r="1.1" fill="currentColor" stroke="none"/></svg>';
  const battery = ios
    ? '<span class="bat"><b>87</b></span>'
    : '<svg width="9" height="15" viewBox="0 0 9 15" fill="currentColor"><rect x="2.5" y="0" width="4" height="2" rx=".5"/><rect x="0" y="1.5" width="9" height="13.5" rx="1.6"/></svg>';
  const back = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 4 6.5 10l6 6"/></svg>';
  const reload = '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M16 10a6 6 0 1 1-1.8-4.3"/><path d="M15.5 2.5v4h-4"/></svg>';
  const menu = '<svg width="18" height="14" viewBox="0 0 18 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 2h14M2 7h14M2 12h10"/></svg>';
  const tabs = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="2.5" y="6" width="11" height="11" rx="2.6"/><path d="M6.5 3.2h8a2.8 2.8 0 0 1 2.8 2.8v8"/></svg>';
  const dots = '<svg width="4" height="16" viewBox="0 0 4 16" fill="currentColor"><circle cx="2" cy="2" r="1.8"/><circle cx="2" cy="8" r="1.8"/><circle cx="2" cy="14" r="1.8"/></svg>';
  const css = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "SF Pro Text", Roboto, system-ui, sans-serif; }
    .layer { position: fixed; inset: 0; pointer-events: none; color: #000; }
    button { pointer-events: auto; border: 0; background: none; color: inherit; display: grid; place-items: center; cursor: pointer; padding: 0; }
    .status { position: absolute; left: 0; right: 0; top: 0; display: flex; align-items: center; font-weight: 600; }
    .status .time { flex: 1; } .status .icons { flex: 1; display: flex; justify-content: flex-end; align-items: center; gap: 6px; }
    .glass { background: rgba(255,255,255,.62); backdrop-filter: blur(18px) saturate(1.8); -webkit-backdrop-filter: blur(18px) saturate(1.8);
      box-shadow: 0 6px 24px rgba(0,0,0,.14), inset 0 0 0 .5px rgba(255,255,255,.7), inset 0 1px 0 rgba(255,255,255,.9); }
    .ios .status { height: 54px; padding: 0 30px 0 44px; font-size: 17px; }
    .ios .status .time { padding-top: 2px; }
    .ios .island { position: absolute; top: 11px; left: 50%; transform: translateX(-50%); width: 124px; height: 36px; border-radius: 20px; background: #000; }
    .bat { display: inline-flex; align-items: center; justify-content: center; min-width: 27px; height: 13px; padding: 0 3px; border-radius: 4px; background: #000; color: #fff; font-size: 10px; font-weight: 700; position: relative; }
    .bat::after { content: ""; position: absolute; right: -3px; top: 4px; width: 1.5px; height: 5px; border-radius: 0 1px 1px 0; background: rgba(0,0,0,.45); }
    .ios .bar { position: absolute; left: 14px; right: 14px; bottom: 30px; display: flex; gap: 8px; align-items: center; }
    .ios .round { width: 48px; height: 48px; border-radius: 50%; }
    .ios .pill { flex: 1; height: 48px; border-radius: 24px; display: flex; align-items: center; gap: 10px; padding: 0 16px; font-size: 16px; min-width: 0; }
    .ios .pill .addr { flex: 1; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ios .home { position: absolute; bottom: 8px; left: 50%; transform: translateX(-50%); width: 134px; height: 5px; border-radius: 3px; background: #000; }
    .android .status { height: 36px; padding: 0 18px; font-size: 14px; font-weight: 500; }
    .android .cam { position: absolute; top: 11px; left: 50%; transform: translateX(-50%); width: 14px; height: 14px; border-radius: 50%; background: #000; }
    .android .bar { position: absolute; left: 10px; right: 6px; top: 40px; display: flex; gap: 4px; align-items: center; }
    .android .pill { flex: 1; height: 44px; border-radius: 22px; display: flex; align-items: center; gap: 10px; padding: 0 16px; font-size: 16px; min-width: 0; }
    .android .pill .addr { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .android .icon { width: 40px; height: 44px; }
    .android .count { width: 20px; height: 20px; border: 2px solid currentColor; border-radius: 5px; font-size: 11px; font-weight: 700; display: grid; place-items: center; }
    .android .home { position: absolute; bottom: 9px; left: 50%; transform: translateX(-50%); width: 108px; height: 4px; border-radius: 2px; background: rgba(0,0,0,.8); }
    .land .status, .land .island, .land .cam, .land .home { display: none; }
    .ios.land .bar { left: 50%; right: auto; width: 420px; transform: translateX(-50%); bottom: 12px; }
    .android.land .bar { top: 6px; left: 40px; }
  `;
  const mount = () => {
    if (!document.documentElement || document.getElementById("__ags-device-chrome")) return;
    const el = document.createElement("ags-device-chrome");
    el.id = "__ags-device-chrome";
    el.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block";
    const root = el.attachShadow({ mode: "closed" });
    const status = `<div class="status"><span class="time"></span>${ios ? '<span class="island"></span>' : '<span class="cam"></span>'}<span class="icons">${signal}${wifi}${battery}</span></div>`;
    const bar = ios
      ? `<div class="bar"><button class="round glass" data-a="back" aria-label="Voltar">${back}</button><div class="pill glass">${menu}<span class="addr"></span><button data-a="reload" aria-label="Recarregar">${reload}</button></div><button class="round glass" aria-label="Abas">${tabs}</button></div><span class="home"></span>`
      : `<div class="bar"><div class="pill glass"><button data-a="back" aria-label="Voltar">${back}</button><span class="addr"></span><button data-a="reload" aria-label="Recarregar">${reload}</button></div><button class="icon"><span class="count">1</span></button><button class="icon" aria-label="Menu">${dots}</button></div><span class="home"></span>`;
    root.innerHTML = `<style>${css}</style><div class="layer ${platform}">${status}${bar}</div>`;
    const layer = root.querySelector(".layer");
    const tick = () => {
      layer.classList.toggle("land", innerWidth > innerHeight);
      root.querySelector(".time").textContent = clock();
      root.querySelector(".addr").textContent = host();
    };
    tick();
    setInterval(tick, 15000);
    addEventListener("resize", tick);
    root.addEventListener("click", (e) => {
      const a = e.target.closest && e.target.closest("[data-a]");
      if (!a) return;
      if (a.dataset.a === "back") history.back();
      if (a.dataset.a === "reload") location.reload();
    });
    document.documentElement.appendChild(el);
    // Páginas que reescrevem o <html> inteiro tiram a moldura; põe de volta.
    new MutationObserver(() => { if (!el.isConnected) document.documentElement.appendChild(el); })
      .observe(document.documentElement, { childList: true });
  };
  if (document.documentElement) mount();
  document.addEventListener("DOMContentLoaded", mount);
})();
