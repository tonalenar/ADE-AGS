import { useContext, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { FLOATING_PREVIEW_CORNER_RADIUS, NativeCornerRadius } from "./nativeCorner";
import { closeAppPopovers } from "./outsidePointer";
import { boxOf, clippingAncestors, COVER_MS, coversOf } from "./nativeSurface";
import { miniBrowserZoom, placeOf, realBrowserClose, realBrowserOpen, realBrowserPlace, samePlace, type Box, type Place } from "./realBrowser";
import { setChatBrowserMiniHover, useChatStore } from "@/features/chat/store";

const PLACE_SYNC_INTERVAL_MS = 32;

/**
 * O lugar do navegador nativo do Portal. A página é um WebView2 por cima da janela (ver `real_browser`): este
 * elemento só reserva o espaço e acompanha onde o Portal está, o que dele está à vista e o que do app está por
 * cima; durante redimensionamentos, as mudanças nativas são coalescidas em até uma chamada a cada 32 ms. Mouse e teclado vão
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
  const chatBrowser = useChatStore((state) => floatingPreview ? state.browser : null);
  const floatingRect = useChatStore((state) => floatingPreview ? state.browserFloatRect : null);
  const sourceRect = chatBrowser?.viewId === viewId ? chatBrowser.rect : null;
  const effectiveSourceRect = sourceRect ?? (floatingPreview ? { left: 0, top: 0, width: 1280, height: 800 } : null);
  const miniZoom = miniBrowserZoom(
    zoom,
    effectiveSourceRect ? { x: effectiveSourceRect.left, y: effectiveSourceRect.top, width: effectiveSourceRect.width, height: effectiveSourceRect.height } : null,
    floatingRect ? { x: floatingRect.left, y: floatingRect.top, width: floatingRect.width, height: floatingRect.height } : null,
  );
  const screenRadius = useContext(NativeCornerRadius);
  const latest = useRef({ zoom, onUrl, onTitle, onLoading, onHistory, onPopup, onClosedByPage, onError, floatingPreview, miniZoom, screenRadius });
  latest.current = { zoom, onUrl, onTitle, onLoading, onHistory, onPopup, onClosedByPage, onError, floatingPreview, miniZoom, screenRadius };

  // A pílula da miniatura não fica presa visível de uma miniatura para a próxima.
  useEffect(() => {
    if (!floatingPreview) setChatBrowserMiniHover(viewId, false);
    return () => setChatBrowserMiniHover(viewId, false);
  }, [floatingPreview, viewId]);

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
    let placeInFlight = false;
    let lastPlaceAt = Number.NEGATIVE_INFINITY;
    let lastRect: Box | null = null;
    // Entrar com o mouse sobre um elemento novo muda o que está por cima da página: a cobertura é medida de novo.
    const invalidateCovers = () => { coveredAt = Number.NEGATIVE_INFINITY; };
    document.addEventListener("pointerenter", invalidateCovers, true);

    const measure = (): Place => {
      const rect = boxOf(el);
      const now = performance.now();
      // Outra aba por cima (`display:none`/`visibility:hidden`) ou a janela minimizada: a página some, mas continua
      // desenhando para as fotos dos agentes.
      const shown = document.visibilityState !== "hidden" && rect.width > 1 && rect.height > 1
        && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
      const rectChanged = !lastRect || rect.x !== lastRect.x || rect.y !== lastRect.y || rect.width !== lastRect.width || rect.height !== lastRect.height;
      if (shown && (rectChanged || now - coveredAt > COVER_MS)) {
        coveredAt = now;
        lastRect = rect;
        clips = clippingAncestors(el);
        covers = coversOf(el, rect);
      }
      const windowBox = { x: 0, y: 0, width: innerWidth, height: innerHeight };
      const clipsToUse = latest.current.floatingPreview ? [] : clips.map(boxOf);
      return {
        // Com o aparelho emoldurado na miniatura, o palco já escala a página: vale o zoom dele, não o da miniatura.
        ...placeOf(rect, el.offsetWidth, latest.current.floatingPreview && latest.current.screenRadius <= 0 ? latest.current.miniZoom : latest.current.zoom, [windowBox, ...clipsToUse], shown ? covers : [], shown),
        clickToExpand: latest.current.floatingPreview,
        // A tela do aparelho manda nos cantos, também na miniatura.
        cornerRadius: latest.current.screenRadius > 0 ? latest.current.screenRadius : latest.current.floatingPreview ? FLOATING_PREVIEW_CORNER_RADIUS : 0,
      };
    };

    const tick = () => {
      if (opened) {
        const place = measure();
        const now = performance.now();
        if (!samePlace(sent, place) && !placeInFlight && now - lastPlaceAt >= PLACE_SYNC_INTERVAL_MS) {
          sent = place;
          lastPlaceAt = now;
          placeInFlight = true;
          realBrowserPlace(viewId, place).catch(() => undefined).finally(() => { placeInFlight = false; });
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
      listen<{ id: string }>("real-browser-pointer", mine(() => closeAppPopovers())),
      listen<{ id: string; inside: boolean }>("real-browser-mini-hover", mine((p) => {
        if (latest.current.floatingPreview) setChatBrowserMiniHover(viewId, p.inside);
      })),
      listen<{ id: string; popup: string; url: string }>("real-browser-popup", mine((p) => latest.current.onPopup?.({ id: p.popup, url: p.url }))),
      listen<{ id: string }>("real-browser-closed", mine(() => latest.current.onClosedByPage?.())),
    ];
    const onBlur = () => closeAppPopovers();
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("pointerenter", invalidateCovers, true);
      closed = true;
      cancelAnimationFrame(frame);
      offs.forEach((p) => p.then((off) => off()));
      // A desmontagem manda o lugar invisível antes de fechar: o nativo não segue mostrando a página sem dono.
      const finalPlace = sent ? { ...sent, visible: false } : null;
      const closing = finalPlace ? realBrowserPlace(viewId, finalPlace).catch(() => undefined) : Promise.resolve();
      closing.finally(() => realBrowserClose(viewId).catch(() => undefined));
    };
  }, [viewId, profileId, projectPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // Transparente, não branco: sem tema, o branco aparece como um quadro enquanto a vista nativa não desenha.
  return <div ref={box} data-real-browser className="relative flex-1 h-full min-h-0 bg-transparent" />;
}
