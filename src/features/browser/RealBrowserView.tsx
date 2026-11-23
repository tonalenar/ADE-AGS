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
export function RealBrowserView({ viewId, url, zoom, script, profileId = "default", projectPath = "", floatingPreview = false, stageScaled = false, surfaceActive = true, onUrl, onTitle, onLoading, onHistory, onPopup, onClosedByPage, onError }: {
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
  /** `true` quando o palco (`ResponsiveStage`) já escala a página por `transform`, dispensando `miniZoom`. */
  stageScaled?: boolean;
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
  const latest = useRef({ zoom, onUrl, onTitle, onLoading, onHistory, onPopup, onClosedByPage, onError, floatingPreview, stageScaled, miniZoom, screenRadius, projectPath, surfaceActive });
  latest.current = { zoom, onUrl, onTitle, onLoading, onHistory, onPopup, onClosedByPage, onError, floatingPreview, stageScaled, miniZoom, screenRadius, projectPath, surfaceActive };
  const wakeRef = useRef<(() => void) | null>(null);

  // A pílula da miniatura não fica presa visível de uma miniatura para a próxima.
  useEffect(() => {
    if (!floatingPreview) setChatBrowserMiniHover(viewId, false);
    return () => setChatBrowserMiniHover(viewId, false);
  }, [floatingPreview, viewId]);

  useEffect(() => {
    wakeRef.current?.();
  }, [zoom, floatingPreview, stageScaled, miniZoom, screenRadius, surfaceActive, floatingRect]);

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
    let throttleTimer: ReturnType<typeof setTimeout> | null = null;
    let placeInFlight = false;
    let lastPlaceAt = Number.NEGATIVE_INFINITY;
    let lastRect: Box | null = null;
    let emptyPlaces = 0;
    let lastEmpty = false;
    let dirty = false;
    const clearThrottle = () => {
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }
    };
    const invalidateCovers = () => { coveredAt = Number.NEGATIVE_INFINITY; };

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
      const useMiniZoom = latest.current.floatingPreview && !latest.current.stageScaled && latest.current.screenRadius <= 0;
      return {
        // Quando o palco já escala a página (viewport fixo ou aparelho emoldurado), vale o zoom dele, não o da miniatura.
        ...placeOf(
          rect,
          el.offsetWidth,
          useMiniZoom ? latest.current.miniZoom : latest.current.zoom,
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
      clearThrottle();
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
    // Entrar com o mouse sobre um elemento fora do host pode abrir tooltip/menu por cima da página: recalcula sob demanda.
    const onPointerEnter = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && el.contains(target)) return;
      invalidateCovers();
      wake();
    };
    document.addEventListener("pointerenter", onPointerEnter, true);

    // Observação dirigida a eventos, sem rAF contínuo a 60 FPS: só agenda novo quadro quando há mudança pendente
    // aguardando o intervalo de coalescência (32 ms) ou a confirmação do 2º lugar vazio seguido (`empty_clip_visibility`).
    const tick = () => {
      frame = 0;
      if (closed || !opened) return;
      dirty = false;
      const place = measure();
      const now = performance.now();
      const empty = place.visibleRect === null;
      lastEmpty = empty;
      const needsSecondEmpty = empty && emptyPlaces < 2;
      const due = !samePlace(sent, place) || needsSecondEmpty;
      if (!due) return;
      if (placeInFlight) {
        dirty = true;
        return;
      }
      const waitMs = PLACE_SYNC_INTERVAL_MS - (now - lastPlaceAt);
      if (waitMs > 0) {
        if (throttleTimer === null) {
          throttleTimer = setTimeout(() => {
            throttleTimer = null;
            schedule();
          }, waitMs);
        }
        return;
      }
      sent = place;
      lastPlaceAt = now;
      emptyPlaces = empty ? emptyPlaces + 1 : 0;
      placeInFlight = true;
      realBrowserPlace(viewId, place)
        .catch(() => undefined)
        .finally(() => {
          placeInFlight = false;
          if (!closed && (dirty || (empty && emptyPlaces < 2))) schedule();
        });
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
    if (ro) {
      ro.observe(el);
      for (const ancestor of clips) ro.observe(ancestor);
      if (document.documentElement) ro.observe(document.documentElement);
    }
    const io = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver(wake, { threshold: [0, 0.01, 0.5, 1] }) : null;
    io?.observe(el);
    const mo = typeof MutationObserver !== "undefined" ? new MutationObserver(wake) : null;
    if (mo) {
      for (let cur: HTMLElement | null = el; cur; cur = cur.parentElement) {
        mo.observe(cur, { attributes: true, attributeFilter: ["style", "class", "hidden"] });
      }
    }
    const overlaySelector = `${OVERLAYS}, ${HIT_OVERLAYS}`;
    const overlayAttrMo = typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => {
          invalidateCovers();
          wake();
        })
      : null;
    const watchOverlayAttrs = () => {
      if (!overlayAttrMo) return;
      overlayAttrMo.disconnect();
      for (const overlay of document.querySelectorAll(overlaySelector)) {
        if (el.contains(overlay)) continue;
        overlayAttrMo.observe(overlay, { attributes: true, attributeFilter: ["style", "class", "hidden", "data-state", "data-visible"] });
      }
    };
    watchOverlayAttrs();
    const hasOverlayNode = (node: Node): boolean => {
      if (node.nodeType !== 1) return false;
      const elem = node as Element;
      if (el.contains(elem)) return false;
      return elem.matches(overlaySelector) || (elem.childElementCount > 0 && Boolean(elem.querySelector(overlaySelector)));
    };
    const isOverlayMutation = (records: MutationRecord[]): boolean => records.some((record) => {
      if (record.type === "childList") {
        for (const node of record.addedNodes) if (hasOverlayNode(node)) return true;
        for (const node of record.removedNodes) if (hasOverlayNode(node)) return true;
        return false;
      }
      if (record.target.nodeType !== 1) return false;
      const target = record.target as Element;
      return !el.contains(target);
    });
    // Observa apenas estrutura/atributos de overlay no body (nunca `style`/`class` globais, evitando tempestade no streaming do chat).
    const bodyMo = typeof MutationObserver !== "undefined"
      ? new MutationObserver((records) => {
          if (!isOverlayMutation(records)) return;
          watchOverlayAttrs();
          invalidateCovers();
          wake();
        })
      : null;
    bodyMo?.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open", "data-over-webview", "popover", "role"],
    });
    const onScroll = () => wake();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("resize", wake);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });

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
      overlayAttrMo?.disconnect();
      bodyMo?.disconnect();
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("resize", wake);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("pointerenter", onPointerEnter, true);
      closed = true;
      clearThrottle();
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
