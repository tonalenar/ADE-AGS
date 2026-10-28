import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { placeOf, realBrowserClose, realBrowserOpen, realBrowserPlace, samePlace, type Box, type Place } from "./realBrowser";

/** O que do app pode ficar por cima da página: menus, diálogos, dicas, o painel lateral. */
const OVERLAYS = '[role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"], [data-radix-popper-content-wrapper], [data-session-panel], [data-over-webview]';
/** A grade de pontos que procura o que está por cima (outro nó do canvas, um popover sem papel ARIA). */
const GRID = { cols: 12, rows: 8 };
/** De quanto em quanto tempo procurar o que está por cima (o lugar do Portal é medido a cada quadro). */
const COVER_MS = 120;

function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/** Os ancestrais que recortam o que passa da borda deles (o canvas, a área de conteúdo). */
function clippingAncestors(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let p = el.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (s.overflowX !== "visible" || s.overflowY !== "visible") out.push(p);
  }
  return out;
}

/** O que do app está por cima do Portal `el`: o maior bloco acima dele que não o contém. */
function coversOf(el: HTMLElement, rect: Box): Box[] {
  const found = new Set<Element>();
  for (const overlay of document.querySelectorAll(OVERLAYS)) {
    if (!overlay.contains(el) && !el.contains(overlay)) found.add(overlay);
  }
  for (let i = 0; i < GRID.cols; i++) {
    for (let j = 0; j < GRID.rows; j++) {
      const hit = document.elementFromPoint(rect.x + ((i + 0.5) * rect.width) / GRID.cols, rect.y + ((j + 0.5) * rect.height) / GRID.rows);
      if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
      let top = hit;
      while (top.parentElement && !top.parentElement.contains(el)) top = top.parentElement;
      found.add(top);
    }
  }
  return [...found].map(boxOf).filter((b) => b.width > 0 && b.height > 0);
}

/**
 * O lugar do navegador nativo do Portal. A página é um WebView2 por cima da janela (ver `real_browser`): este
 * elemento só reserva o espaço e, a cada quadro, diz ao navegador onde o Portal está, o que dele está à vista e o
 * que do app está por cima — o mesmo que o T3 Code faz com o `[data-browser-surface-slot]`. Mouse e teclado vão
 * direto para a página.
 *
 * `url` só vale na abertura: depois quem navega é `realBrowserNavigate` (a barra, os botões, os agentes). A URL que
 * a página informa vai para `onUrl` e nunca volta como navegação.
 */
export function RealBrowserView({ viewId, url, zoom, script, onUrl, onTitle, onLoading, onHistory, onError }: {
  viewId: string;
  url: string;
  /** O zoom da página (1 = 100%), o mesmo dos botões de zoom do navegador. */
  zoom: number;
  /** O piloto dos agentes, injetado em cada documento (ver `real_browser_open`). */
  script?: string;
  onUrl: (url: string) => void;
  onTitle?: (title: string) => void;
  onLoading?: (loading: boolean) => void;
  onHistory?: (state: { back: boolean; forward: boolean }) => void;
  onError: (message: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const latest = useRef({ zoom, onUrl, onTitle, onLoading, onHistory, onError });
  latest.current = { zoom, onUrl, onTitle, onLoading, onHistory, onError };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let opened = false;
    let closed = false;
    let sent: Place | null = null;
    let clips: HTMLElement[] = clippingAncestors(el);
    let covers: Box[] = [];
    let coveredAt = 0;
    let frame = 0;

    const measure = (): Place => {
      const rect = boxOf(el);
      const now = performance.now();
      // Outra aba por cima (`display:none`/`visibility:hidden`) ou a janela minimizada: a página some, mas continua
      // desenhando para as fotos dos agentes.
      const shown = document.visibilityState !== "hidden" && rect.width > 1 && rect.height > 1
        && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
      if (shown && now - coveredAt > COVER_MS) {
        coveredAt = now;
        clips = clippingAncestors(el);
        covers = coversOf(el, rect);
      }
      const windowBox = { x: 0, y: 0, width: innerWidth, height: innerHeight };
      return placeOf(rect, el.offsetWidth, latest.current.zoom, [windowBox, ...clips.map(boxOf)], shown ? covers : [], shown);
    };

    const tick = () => {
      if (opened) {
        const place = measure();
        if (!samePlace(sent, place)) {
          sent = place;
          realBrowserPlace(viewId, place).catch(() => undefined);
        }
      }
      frame = requestAnimationFrame(tick);
    };

    sent = measure();
    realBrowserOpen(viewId, url || "about:blank", sent, script)
      .then(() => {
        if (closed) realBrowserClose(viewId).catch(() => undefined);
        opened = true;
      })
      .catch((e) => latest.current.onError(String(e)));
    frame = requestAnimationFrame(tick);

    const mine = <T extends { id: string }>(fn: (payload: T) => void) => (e: { payload: T }) => {
      if (e.payload.id === viewId) fn(e.payload);
    };
    const offs = [
      listen<{ id: string; url: string }>("real-browser-url", mine((p) => latest.current.onUrl(p.url))),
      listen<{ id: string; title: string }>("real-browser-title", mine((p) => latest.current.onTitle?.(p.title))),
      listen<{ id: string; loading: boolean }>("real-browser-load", mine((p) => latest.current.onLoading?.(p.loading))),
      listen<{ id: string; back: boolean; forward: boolean }>("real-browser-history", mine((p) => latest.current.onHistory?.(p))),
    ];
    return () => {
      closed = true;
      cancelAnimationFrame(frame);
      offs.forEach((p) => p.then((off) => off()));
      realBrowserClose(viewId).catch(() => undefined);
    };
  }, [viewId]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={box} data-real-browser className="relative flex-1 h-full min-h-0 bg-white" />;
}
