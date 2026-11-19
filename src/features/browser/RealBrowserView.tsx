import { useContext, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { FLOATING_PREVIEW_CORNER_RADIUS, NativeCornerRadius } from "./nativeCorner";
import { closeAppPopovers } from "./outsidePointer";
import { boxOf, clippingAncestors, COVER_MS, coversOf, HIT_OVERLAYS, hitCoversOf, OVERLAYS } from "./nativeSurface";
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
export function RealBrowserView({ viewId, url, zoom, script, profileId = "default", projectPath = "", floatingPreview = false, surfaceActive = true, onUrl, onTitle, onLoading, onHistory, onPopup, onClosedByPage, onError }: {
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
  /** `false` quando o container pai (ex.: canvas ou aba por trás de modal) está fora de cena. */
  surfaceActive?: boolean;
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
  const latest = useRef({ zoom, onUrl, onTitle, onLoading, onHistory, onPopup, onClosedByPage, onError, floatingPreview, miniZoom, screenRadius, projectPath, surfaceActive });
  latest.current = { zoom, onUrl, onTitle, onLoading, onHistory, onPopup, onClosedByPage, onError, floatingPreview, miniZoom, screenRadius, projectPath, surfaceActive };
  const wakeRef = useRef<(() => void) | null>(null);

  // A pílula da miniatura não fica presa visível de uma miniatura para a próxima.
  useEffect(() => {
    if (!floatingPreview) setChatBrowserMiniHover(viewId, false);
    return () => setChatBrowserMiniHover(viewId, false);
  }, [floatingPreview, viewId]);

  useEffect(() => {
    wakeRef.current?.();
  }, [zoom, floatingPreview, miniZoom, screenRadius, surfaceActive]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let opened = false;
    let closed = false;
    let sent: Place | null = null;
    let clips: HTMLElement[] = clippingAncestors(el);
    let covers: Box[] = [];
    let hitCovers: Box[] = [];
    let coveredAt = 0;
    let frame = 0;
    let placeInFlight = false;
    let lastPlaceAt = Number.NEGATIVE_INFINITY;
    let lastRect: Box | null = null;
    let emptyPlaces = 0;
    let lastEmpty = false;
    let dirty = false;
    // Entrar com o mouse sobre um elemento novo muda o que está por cima da página: a cobertura é medida de novo.
    const invalidateCovers = () => { coveredAt = Number.NEGATIVE_INFINITY; };
    document.addEventListener("pointerenter", invalidateCovers, true);

    const measure = (): Place => {
      const rect = boxOf(el);
      const now = performance.now();
      // Outra aba por cima (`display:none`/`visibility:hidden`) ou a janela minimizada: a página some, mas continua
      // desenhando para as fotos dos agentes.
      const shown = latest.current.surfaceActive && document.visibilityState !== "hidden" && rect.width > 1 && rect.height > 1
        && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
      const rectChanged = !lastRect || rect.x !== lastRect.x || rect.y !== lastRect.y || rect.width !== lastRect.width || rect.height !== lastRect.height;
      if (shown && (rectChanged || now - coveredAt > COVER_MS)) {
        coveredAt = now;
        lastRect = rect;
        clips = clippingAncestors(el);
        covers = coversOf(el, rect);
        hitCovers = hitCoversOf(el);
      }
      const windowBox = { x: 0, y: 0, width: innerWidth, height: innerHeight };
      const clipsToUse = latest.current.floatingPreview ? [] : clips.map(boxOf);
      return {
        // Com o aparelho emoldurado na miniatura, o palco já escala a página: vale o zoom dele, não o da miniatura.
        ...placeOf(
          rect,
          el.offsetWidth,
          latest.current.floatingPreview && latest.current.screenRadius <= 0 ? latest.current.miniZoom : latest.current.zoom,
          [windowBox, ...clipsToUse],
          shown ? covers : [],
          shown,
          shown ? hitCovers : [],
        ),
        clickToExpand: latest.current.floatingPreview,
        // A tela do aparelho manda nos cantos, também na miniatura.
        cornerRadius: latest.current.screenRadius > 0 ? latest.current.screenRadius : latest.current.floatingPreview ? FLOATING_PREVIEW_CORNER_RADIUS : 0,
      };
    };

    const schedule = () => {
      if (closed || frame !== 0) return;
      frame = requestAnimationFrame(tick);
    };
    const sleeping = () => emptyPlaces >= 2 && lastEmpty;
    const wake = () => {
      if (closed || !opened) return;
      // Com o pai inativo e os 2 lugares vazios já enviados, eventos de layout não trazem a página de volta.
      if (sleeping() && !latest.current.surfaceActive) return;
      dirty = true;
      schedule();
    };
    wakeRef.current = wake;

    // Sem área à vista (escondida: outra aba, a canvas do modo Abas), o nativo só esconde no segundo lugar vazio
    // seguido (ver `empty_clip_visibility`). Por isso o lugar vazio vai duas vezes e depois o laço dorme.
    const tick = () => {
      frame = 0;
      if (closed || !opened) return;
      dirty = false;
      const place = measure();
      const now = performance.now();
      const empty = place.visibleRect === null;
      lastEmpty = empty;
      const due = !samePlace(sent, place) || (empty && emptyPlaces < 2);
      if (due && !placeInFlight && now - lastPlaceAt >= PLACE_SYNC_INTERVAL_MS) {
        sent = place;
        lastPlaceAt = now;
        emptyPlaces = empty ? emptyPlaces + 1 : 0;
        placeInFlight = true;
        realBrowserPlace(viewId, place)
          .catch(() => undefined)
          .finally(() => {
            placeInFlight = false;
            if (!closed && (dirty || !empty || emptyPlaces < 2)) schedule();
          });
      }
      if (empty && emptyPlaces >= 2 && samePlace(sent, place)) return;
      schedule();
    };

    sent = measure();
    lastEmpty = sent.visibleRect === null;
    // A partição é escolhida na abertura: trocar a pasta da vista depois não recria a página.
    realBrowserOpen(viewId, url || "about:blank", sent, script, profileId, latest.current.projectPath)
      .then(() => {
        if (closed) {
          realBrowserClose(viewId).catch(() => undefined);
          return;
        }
        opened = true;
        schedule();
      })
      .catch((e) => latest.current.onError(String(e)));

    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(wake) : null;
    ro?.observe(el);
    const io = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver(wake, { threshold: [0, 0.01] }) : null;
    io?.observe(el);
    const mo = typeof MutationObserver !== "undefined" ? new MutationObserver(wake) : null;
    if (mo) {
      for (let cur: HTMLElement | null = el; cur; cur = cur.parentElement) {
        mo.observe(cur, { attributes: true, attributeFilter: ["style", "class", "hidden"] });
      }
    }
    const overlaySelector = `${OVERLAYS}, ${HIT_OVERLAYS}`;
    const hasOverlayNode = (node: Node): boolean => {
      if (node.nodeType !== 1) return false;
      const elem = node as Element;
      if (el.contains(elem)) return false;
      return elem.matches(overlaySelector) || Boolean(elem.querySelector(overlaySelector));
    };
    const isOverlayMutation = (records: MutationRecord[]): boolean => records.some((record) => {
      if (record.type === "childList") {
        for (const node of record.addedNodes) if (hasOverlayNode(node)) return true;
        for (const node of record.removedNodes) if (hasOverlayNode(node)) return true;
        return false;
      }
      if (record.target.nodeType !== 1) return false;
      const target = record.target as Element;
      if (el.contains(target)) return false;
      if (record.attributeName === "open" || record.attributeName === "data-over-webview" || record.attributeName === "popover" || record.attributeName === "role") {
        return true;
      }
      if (target === document.body || target === document.documentElement) return false;
      return target.matches(overlaySelector) || Boolean(target.querySelector(overlaySelector));
    });
    const bodyMo = typeof MutationObserver !== "undefined"
      ? new MutationObserver((records) => {
          if (!isOverlayMutation(records)) return;
          invalidateCovers();
          wake();
        })
      : null;
    bodyMo?.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open", "data-over-webview", "popover", "role", "style", "class", "hidden", "data-state"],
    });
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("resize", wake);

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
        if (latest.current.floatingPreview) {
          setChatBrowserMiniHover(viewId, p.inside);
          invalidateCovers();
          wake();
        }
      })),
      listen<{ id: string; popup: string; url: string }>("real-browser-popup", mine((p) => latest.current.onPopup?.({ id: p.popup, url: p.url }))),
      listen<{ id: string }>("real-browser-closed", mine(() => latest.current.onClosedByPage?.())),
    ];
    const onBlur = () => closeAppPopovers();
    window.addEventListener("blur", onBlur);
    return () => {
      wakeRef.current = null;
      ro?.disconnect();
      io?.disconnect();
      mo?.disconnect();
      bodyMo?.disconnect();
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("resize", wake);
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
  }, [viewId, profileId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Transparente, não branco: sem tema, o branco aparece como um quadro enquanto a vista nativa não desenha.
  return <div ref={box} data-real-browser className="relative flex-1 h-full min-h-0 bg-transparent" />;
}
