// O navegador nativo do Portal (um WebView2 dentro da janela, como o `<webview>` do T3 Code): ver
// `src-tauri/src/real_browser/mod.rs`. O flag `realChrome` da vista continua com esse nome por ser o estado salvo.
import { isLocalUrl } from "@/features/tabs/viewTabs";
import { invoke } from "@tauri-apps/api/core";

/**
 * Um site de fora (Google, Trello, um painel na nuvem) abre no navegador nativo; só o servidor desta máquina vai
 * pelo proxy (selector, mocks e rede ficam à mão). Pelo proxy o site vê um cliente estranho (o Google responde
 * `/sorry`) e a página roda na origem do proxy. `realChrome` explícito (a pessoa ligou ou desligou o botão) sempre
 * vale. Pura.
 */
export function shouldOpenInRealChrome(url: string, realChrome: boolean | undefined): boolean {
  if (realChrome !== undefined) return realChrome;
  return /^https?:\/\//i.test(url) && !isLocalUrl(url);
}

/** Um retângulo em pixels CSS. */
export type Box = { x: number; y: number; width: number; height: number };

/** Onde o Portal está: `rect` na janela; `visible` e `holes` relativos ao próprio Portal (ver `real_browser::Place`). */
export type Place = { rect: Box; zoom: number; visible: Box | null; holes: Box[] };

/** A interseção de dois retângulos, ou `null` se não se tocam. */
export function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/** `box` (na janela) relativo a `origin`. */
export function relativeTo(box: Box, origin: Box): Box {
  return { x: box.x - origin.x, y: box.y - origin.y, width: box.width, height: box.height };
}

/**
 * Onde o Portal está e o que dele aparece. `rect` é onde ele está na janela; `clips`, os retângulos que o recortam
 * (o canvas, a área de conteúdo, a própria janela); `covers`, o que do app está por cima dele. O zoom do canvas é
 * `rect.width / layoutWidth` (o `getBoundingClientRect` já vem escalado; o `offsetWidth`, não): a página acompanha
 * com o zoom do WebView, para o Portal mostrar a mesma página em qualquer zoom do canvas. Pura.
 */
export function placeOf(rect: Box, layoutWidth: number, pageZoom: number, clips: Box[], covers: Box[], shown: boolean): Place {
  const canvasZoom = layoutWidth > 0 ? rect.width / layoutWidth : 1;
  let visible: Box | null = shown ? rect : null;
  for (const clip of clips) visible = visible && intersect(visible, clip);
  const holes = visible ? covers.map((c) => intersect(c, visible!)).filter((c): c is Box => !!c).map((c) => relativeTo(c, rect)) : [];
  return {
    rect,
    zoom: Math.round(canvasZoom * (pageZoom > 0 ? pageZoom : 1) * 1000) / 1000,
    visible: visible && relativeTo(visible, rect),
    holes,
  };
}

export function samePlace(a: Place | null, b: Place): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
}

/** `script`: o piloto dos agentes, que o navegador roda em todo documento (o mesmo que o proxy injeta no outro). */
export const realBrowserOpen = (id: string, url: string, place: Place, script?: string) =>
  invoke<void>("real_browser_open", { id, url, place, script });

export const realBrowserPlace = (id: string, place: Place) => invoke<void>("real_browser_place", { id, place });

/** A barra de endereço ou um agente mandou ir para `url` (a mesma de novo recarrega). Único caminho que navega. */
export const realBrowserNavigate = (id: string, url: string) => invoke<void>("real_browser_navigate", { id, url });

/** Voltar (-1), avançar (+1) ou recarregar (0). */
export const realBrowserHistory = (id: string, delta: number) => invoke<void>("real_browser_history", { id, delta });

export const realBrowserClose = (id: string) => invoke<void>("real_browser_close", { id });

export const realBrowserFocus = (id: string) => invoke<void>("real_browser_focus", { id });

/** Uma mensagem do app para o piloto da página (`page:run`, `connect`…). */
export const realBrowserPost = (id: string, message: unknown) => invoke<void>("real_browser_post", { id, message });

/** A foto da página agora: PNG em base64 e o tamanho em px CSS. */
export const realBrowserScreenshot = (id: string) =>
  invoke<{ data: string; width: number; height: number }>("real_browser_screenshot", { id });

/** A foto da página num canvas, com o tamanho da página em px CSS. */
export async function realBrowserShot(id: string): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  const shot = await realBrowserScreenshot(id);
  const img = new Image();
  img.src = `data:image/png;base64,${shot.data}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d")?.drawImage(img, 0, 0);
  return { canvas, width: shot.width || img.naturalWidth, height: shot.height || img.naturalHeight };
}
