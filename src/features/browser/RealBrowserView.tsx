import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { boxOf, clippingAncestors, COVER_MS, coversOf } from "./nativeSurface";
import { miniBrowserZoom, placeOf, realBrowserClose, realBrowserOpen, realBrowserPlace, samePlace, type Box, type Place } from "./realBrowser";
import { setChatBrowserMiniHover, setRightPanel, useChatStore } from "@/features/chat/store";

/**
 * O lugar do navegador nativo do Portal. A página é um WebView2 por cima da janela (ver `real_browser`): este
 * elemento só reserva o espaço e, a cada quadro, diz ao navegador onde o Portal está, o que dele está à vista e o
 * que do app está por cima — o mesmo que o T3 Code faz com o `[data-browser-surface-slot]`. Mouse e teclado vão
 * direto para a página.
 *
 * `url` só vale na abertura: depois quem navega é `realBrowserNavigate` (a barra, os botões, os agentes). A URL que
 * a página informa vai para `onUrl` e nunca volta como navegação.
 */
export function RealBrowserView({ viewId, url, zoom, script, profileId = "default", projectPath = "", floatingPreview = false, onUrl, onTitle, onLoading, onHistory, onPopup, onClosedByPage, onError }: {
  viewId: string;
  url: string;
  /** O zoom da página (1 = 100%), o mesmo dos botões de zoom do navegador. */
  zoom: number;
  /** O piloto dos agentes, injetado em cada documento (ver `real_browser_open`). */
  script?: string;
  /** Perfil isolado, compartilhado somente entre vistas que escolherem o mesmo id. */
  profileId?: string;
  /** Caminho usado só para derivar uma chave de partição sem gravá-lo no nome do diretório. */
  projectPath?: string;
  /** A vista continua montada e o host nativo habilita clique para reabrir o painel. */
  floatingPreview?: boolean;
  onUrl: (url: string) => void;
  onTitle?: (title: string) => void;
  onLoading?: (loading: boolean) => void;
  onHistory?: (state: { back: boolean; forward: boolean }) => void;
  /** A página abriu um pop-up (OAuth, `window.open`, `target=_blank`): o motor já o criou com `opener`; falta a aba. */
  onPopup?: (popup: { id: string; url: string }) => void;
  /** A própria página se fechou (`window.close()`, o fim de um OAuth). */
  onClosedByPage?: () => void;
  onError: (message: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chatBrowser = useChatStore((state) => state.browser);
  const floatingRect = useChatStore((state) => state.browserFloatRect);
  const sourceRect = chatBrowser?.viewId === viewId ? chatBrowser.rect : null;
  const miniZoom = miniBrowserZoom(
    zoom,
    sourceRect ? { x: sourceRect.left, y: sourceRect.top, width: sourceRect.width, height: sourceRect.height } : null,
    floatingRect ? { x: floatingRect.left, y: floatingRect.top, width: floatingRect.width, height: floatingRect.height } : null,
  );
  const latest = useRef({ zoom, onUrl, onTitle, onLoading, onHistory, onPopup, onClosedByPage, onError, floatingPreview, miniZoom });
  latest.current = { zoom, onUrl, onTitle, onLoading, onHistory, onPopup, onClosedByPage, onError, floatingPreview, miniZoom };

  // A pílula da miniatura não fica presa visível de uma miniatura para a próxima.
  useEffect(() => {
    if (!floatingPreview) setChatBrowserMiniHover(false);
  }, [floatingPreview]);

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
      return {
        ...placeOf(rect, el.offsetWidth, latest.current.floatingPreview ? latest.current.miniZoom : latest.current.zoom, [windowBox, ...clips.map(boxOf)], shown ? covers : [], shown),
        clickToExpand: latest.current.floatingPreview,
        cornerRadius: latest.current.floatingPreview ? 16 : 0,
      };
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
    realBrowserOpen(viewId, url || "about:blank", sent, script, profileId, projectPath)
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
      listen<{ id: string }>("real-browser-mini-click", mine(() => {
        if (latest.current.floatingPreview) setRightPanel("browser");
      })),
      listen<{ id: string; inside: boolean }>("real-browser-mini-hover", mine((p) => {
        if (latest.current.floatingPreview) setChatBrowserMiniHover(p.inside);
      })),
      listen<{ id: string; popup: string; url: string }>("real-browser-popup", mine((p) => latest.current.onPopup?.({ id: p.popup, url: p.url }))),
      listen<{ id: string }>("real-browser-closed", mine(() => latest.current.onClosedByPage?.())),
    ];
    return () => {
      closed = true;
      cancelAnimationFrame(frame);
      offs.forEach((p) => p.then((off) => off()));
      realBrowserClose(viewId).catch(() => undefined);
    };
  }, [viewId, profileId, projectPath]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={box} data-real-browser className="relative flex-1 h-full min-h-0 bg-white" />;
}
