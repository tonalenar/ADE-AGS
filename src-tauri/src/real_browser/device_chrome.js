// A parte da moldura do aparelho que fica DENTRO da página: a barra de vidro flutuante do Safari do iOS 26 e a barra
// de início. A página passa por baixo delas; só os botões recebem clique. A barra de status e a barra do Chrome do
// Android são opacas e ficam fora da página (PhoneChrome.tsx), então o Android não injeta nada.
// `__AGS_PLATFORM__` é trocado pelo backend por "ios" ou "android".
(() => {
  if (window.top !== window || window.__ags_device_chrome) return;
  Object.defineProperty(window, "__ags_device_chrome", { value: true });
  const platform = "__AGS_PLATFORM__";
  const ios = platform === "ios";
  if (!ios) return;
  const host = () => (location.hostname || location.href).replace(/^www\./, "");
  const back = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 4 6.5 10l6 6"/></svg>';
  const reload = '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M16 10a6 6 0 1 1-1.8-4.3"/><path d="M15.5 2.5v4h-4"/></svg>';
  const menu = '<svg width="18" height="14" viewBox="0 0 18 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 2h14M2 7h14M2 12h10"/></svg>';
  const tabs = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="2.5" y="6" width="11" height="11" rx="2.6"/><path d="M6.5 3.2h8a2.8 2.8 0 0 1 2.8 2.8v8"/></svg>';
  const css = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "SF Pro Text", Roboto, system-ui, sans-serif; }
    .layer { position: fixed; inset: 0; pointer-events: none; color: #000; }
    button { pointer-events: auto; border: 0; background: none; color: inherit; display: grid; place-items: center; cursor: pointer; padding: 0; }
    .glass { background: rgba(255,255,255,.62); backdrop-filter: blur(18px) saturate(1.8); -webkit-backdrop-filter: blur(18px) saturate(1.8);
      box-shadow: 0 6px 24px rgba(0,0,0,.14), inset 0 0 0 .5px rgba(255,255,255,.7), inset 0 1px 0 rgba(255,255,255,.9); }
    .ios .bar { position: absolute; left: 14px; right: 14px; bottom: 30px; display: flex; gap: 8px; align-items: center; }
    .ios .round { width: 48px; height: 48px; border-radius: 50%; }
    .ios .pill { flex: 1; height: 48px; border-radius: 24px; display: flex; align-items: center; gap: 10px; padding: 0 16px; font-size: 16px; min-width: 0; }
    .ios .pill .addr { flex: 1; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ios .home { position: absolute; bottom: 8px; left: 50%; transform: translateX(-50%); width: 134px; height: 5px; border-radius: 3px; background: #000; }
    .land .status, .land .island, .land .cam, .land .home { display: none; }
    .ios.land .bar { left: 50%; right: auto; width: 420px; transform: translateX(-50%); bottom: 12px; }
  `;
  const mount = () => {
    if (!document.documentElement || document.getElementById("__ags-device-chrome")) return;
    const el = document.createElement("ags-device-chrome");
    el.id = "__ags-device-chrome";
    el.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block";
    const root = el.attachShadow({ mode: "closed" });
    const bar = `<div class="bar"><button class="round glass" data-a="back" aria-label="Voltar">${back}</button><div class="pill glass">${menu}<span class="addr"></span><button data-a="reload" aria-label="Recarregar">${reload}</button></div><button class="round glass" aria-label="Abas">${tabs}</button></div><span class="home"></span>`;
    root.innerHTML = `<style>${css}</style><div class="layer ${platform}">${bar}</div>`;
    const layer = root.querySelector(".layer");
    const tick = () => {
      layer.classList.toggle("land", innerWidth > innerHeight);
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
