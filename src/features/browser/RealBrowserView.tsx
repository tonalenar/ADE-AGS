import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { keyDownEvent, cdpModifiers, mouseButton, pageMetrics, pagePoint, realBrowserClose, realBrowserOpen, realBrowserSend } from "./realBrowser";

/** A tela do Chrome real dentro do Portal: mostra os quadros do screencast e devolve mouse e
 *  teclado. O tamanho da página acompanha o tamanho do Portal (sem o zoom do canvas). */
export function RealBrowserView({ viewId, url, zoom, script, onUrl, onError }: {
  viewId: string;
  url: string;
  /** O piloto dos agentes, injetado em cada documento (ver `real_browser_open`). */
  script?: string;
  /** O zoom da página (1 = 100%), o mesmo dos botões de zoom do navegador. */
  zoom: number;
  onUrl: (url: string) => void;
  onError: (message: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const page = useRef({ width: 1280, height: 800 });
  const [ready, setReady] = useState(false);
  const urlRef = useRef(url);
  urlRef.current = url;
  // A última URL que o Chrome mostrou: uma URL nova na vista que não é esta veio da barra de endereço.
  const shownUrl = useRef(url);
  const opened = useRef(false);
  const onUrlRef = useRef(onUrl);
  onUrlRef.current = onUrl;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // O tamanho em layout (offset), não o da tela: o zoom do canvas não muda a página.
  const metrics = () => pageMetrics({ width: box.current?.offsetWidth ?? 0, height: box.current?.offsetHeight ?? 0 }, zoomRef.current, devicePixelRatio);

  // Abre ao montar; fecha ao desmontar (o login fica no perfil, não na página).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    opened.current = false;
    shownUrl.current = urlRef.current;
    realBrowserOpen(viewId, urlRef.current || "about:blank", metrics(), script)
      .then(() => {
        opened.current = true;
        // A barra mudou enquanto abria.
        if (urlRef.current && urlRef.current !== shownUrl.current) {
          shownUrl.current = urlRef.current;
          realBrowserSend(viewId, "Page.navigate", { url: urlRef.current }).catch(() => undefined);
        }
      })
      .catch((e) => onError(String(e)));
    const resize = new ResizeObserver(() => {
      if (!opened.current) return;
      realBrowserSend(viewId, "Emulation.setDeviceMetricsOverride", metrics()).catch(() => undefined);
    });
    resize.observe(el);
    return () => {
      resize.disconnect();
      realBrowserClose(viewId).catch(() => undefined);
    };
  }, [viewId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (opened.current) realBrowserSend(viewId, "Emulation.setDeviceMetricsOverride", metrics()).catch(() => undefined);
  }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!opened.current || !url || url === shownUrl.current) return;
    shownUrl.current = url;
    realBrowserSend(viewId, "Page.navigate", { url }).catch((e) => onError(String(e)));
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const offs = [
      listen<{ id: string; data: string; width: number; height: number }>("real-browser-frame", (e) => {
        if (e.payload.id !== viewId || !img.current) return;
        img.current.src = `data:image/jpeg;base64,${e.payload.data}`;
        page.current = { width: e.payload.width, height: e.payload.height };
        setReady(true);
      }),
      listen<{ id: string; url: string }>("real-browser-url", (e) => {
        if (e.payload.id !== viewId) return;
        shownUrl.current = e.payload.url;
        onUrlRef.current(e.payload.url);
      }),
    ];
    return () => { offs.forEach((p) => p.then((off) => off())); };
  }, [viewId]);

  // A roda tem que ser não passiva e não subir: senão o canvas também rola ou dá zoom.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = img.current?.getBoundingClientRect();
      if (!rect) return;
      const { x, y } = pagePoint(e.clientX, e.clientY, rect, page.current);
      realBrowserSend(viewId, "Input.dispatchMouseEvent", {
        type: "mouseWheel", x, y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: cdpModifiers(e),
      }).catch(() => undefined);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [viewId]);

  const mouse = (type: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (type === "mousePressed") {
      e.preventDefault();
      box.current?.focus();
    }
    const rect = img.current?.getBoundingClientRect();
    if (!rect) return;
    const { x, y } = pagePoint(e.clientX, e.clientY, rect, page.current);
    realBrowserSend(viewId, "Input.dispatchMouseEvent", {
      type, x, y,
      button: type === "mouseMoved" ? "none" : mouseButton(e.button),
      buttons: e.buttons,
      clickCount: type === "mouseMoved" ? 0 : Math.max(1, e.detail),
      modifiers: cdpModifiers(e),
    }).catch(() => undefined);
  };

  return (
    <div
      ref={box}
      tabIndex={0}
      data-real-browser
      className="relative flex-1 h-full min-h-0 overflow-hidden bg-white outline-none select-none"
      onMouseDown={mouse("mousePressed")}
      onMouseUp={mouse("mouseReleased")}
      onMouseMove={mouse("mouseMoved")}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const event = keyDownEvent(e);
        if (event) realBrowserSend(viewId, "Input.dispatchKeyEvent", event).catch(() => undefined);
      }}
      onKeyUp={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Dead") return;
        realBrowserSend(viewId, "Input.dispatchKeyEvent", {
          type: "keyUp", key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode, modifiers: cdpModifiers(e),
        }).catch(() => undefined);
      }}
    >
      <img ref={img} alt="" draggable={false} className="block w-full h-full object-fill pointer-events-none" />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center text-[12px] text-gray-500">Abrindo o Chrome…</div>
      )}
    </div>
  );
}
