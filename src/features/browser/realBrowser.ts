// O Chrome de verdade por trás do Portal (protótipo): ver `src-tauri/src/real_browser.rs`.
import { isLocalUrl } from "@/features/tabs/viewTabs";
import { invoke } from "@tauri-apps/api/core";

/** A densidade mínima com que o Chrome desenha a página. O quadro que ele entrega é limitado ao tamanho da janela dele
 *  (cerca de 1,25× o box, medido), mas ele o reduz com um bom filtro a partir do desenho: desenhar a 2× e entregar a
 *  1,25× sai bem mais nítido que desenhar já a 1,25× (medido numa página de texto pequeno, comparando com o Chrome
 *  nativo na mesma escala: 0,36 → 0,65; de 2,0 em diante não muda). */
/**
 * Um site de fora (Google, Trello, um painel na nuvem) abre no Chrome de verdade; só o servidor desta
 * máquina vai pelo proxy (selector, mocks e rede ficam à mão). Pelo proxy o site vê um cliente
 * estranho (o Google responde `/sorry` com reCAPTCHA recusado) e a página roda na origem do proxy.
 * `realChrome` explícito (a pessoa ligou ou desligou o botão) sempre vale. Pura.
 */
export function shouldOpenInRealChrome(url: string, realChrome: boolean | undefined): boolean {
  if (realChrome !== undefined) return realChrome;
  return /^https?:\/\//i.test(url) && !isLocalUrl(url);
}

/** Quanto tempo uma URL informada pelo Chrome ainda conta como "dele": a corrida entre duas trocas seguidas de URL
 *  dura alguns quadros, e digitar um endereço na barra leva bem mais que isto. */
export const REPORTED_URL_MS = 3_000;

/** Anota uma URL que o próprio Chrome informou agora, guardando só as `max` mais recentes. */
export function rememberReported(reported: Map<string, number>, url: string, now: number, max = 32): void {
  reported.delete(url);
  reported.set(url, now);
  while (reported.size > max) reported.delete(reported.keys().next().value!);
}

/** A URL nova da vista é só um eco atrasado do que o Chrome acabou de informar (e não um endereço digitado)? */
export function isEchoOfReported(reported: Map<string, number>, url: string, now: number): boolean {
  const at = reported.get(url);
  return at !== undefined && now - at < REPORTED_URL_MS;
}

/** Quantas navegações seguidas para o mesmo endereço (sem contar a query), sem a pessoa mexer, e em quanto tempo,
 *  já são um laço de recarga. Um redirecionamento normal são 2-4; o Google logo depois de entrar na conta pelo Portal
 *  chegou a recarregar `/?zx=…` a cada ~0,7 s sem parar, só naquela aba (uma aba nova no mesmo perfil fica parada). */
export const RELOAD_LOOP = { count: 6, windowMs: 6_000 };

export type Navigation = { at: number; key: string };

/** O endereço sem query nem âncora: `/?zx=1` e `/?zx=2` contam como a mesma página. */
export function navigationKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/** Anota a navegação e diz se a página entrou em laço: as últimas `count` foram para o mesmo endereço, dentro da
 *  janela, todas depois do último clique ou tecla (quem recarrega é a página, não a pessoa). Guarda só as `count`. */
export function noteNavigation(navs: Navigation[], url: string, now: number, lastInput: number): boolean {
  navs.push({ at: now, key: navigationKey(url) });
  while (navs.length > RELOAD_LOOP.count) navs.shift();
  if (navs.length < RELOAD_LOOP.count) return false;
  const first = navs[0];
  return now - first.at <= RELOAD_LOOP.windowMs && first.at > lastInput && navs.every((n) => n.key === first.key);
}

export const MIN_RENDER_DENSITY = 2;

/** Quantos pixels, no máximo, o Chrome desenha por quadro: acima disso (nó muito grande) o desenho a 2× pesa demais. */
export const MAX_RENDER_PIXELS = 8_000_000;

/** O tamanho da página no Chrome para um Portal de `box` pixels CSS, com o zoom da página e a densidade da tela. É o
 *  zoom do próprio Chrome: a página tem menos pixels CSS, cada um com mais pixels de verdade. */
export function pageMetrics(box: { width: number; height: number }, zoom: number, dpr: number) {
  const z = zoom > 0 ? zoom : 1;
  const area = Math.max(1, box.width * box.height);
  // O teto de pixels vale mesmo contra a densidade da tela: nunca abaixo dela, nem acima do que o nó aguenta.
  const density = Math.max(dpr > 0 ? dpr : 1, Math.min(MIN_RENDER_DENSITY, Math.sqrt(MAX_RENDER_PIXELS / area)));
  return {
    width: Math.max(200, Math.round(box.width / z)),
    height: Math.max(200, Math.round(box.height / z)),
    deviceScaleFactor: Math.round(z * density * 100) / 100,
    mobile: false,
  };
}

/** `script`: o piloto dos agentes, que o Chrome roda em todo documento (o mesmo que o proxy injeta no outro navegador). */
/** `fresh`: troca a janela do Portal por uma nova, mesmo já aberta (sai de um laço de recarga). */
export const realBrowserOpen = (id: string, url: string, metrics: ReturnType<typeof pageMetrics>, script?: string, fresh?: boolean) =>
  invoke<void>("real_browser_open", { id, url, width: metrics.width, height: metrics.height, scale: metrics.deviceScaleFactor, script, fresh });

/** Uma mensagem do app para o piloto da página (`page:run`, `connect`…). */
export const realBrowserPost = (id: string, message: unknown) => invoke<void>("real_browser_post", { id, message });

/** A foto da página agora: PNG em base64 e o tamanho em px CSS. */
export const realBrowserScreenshot = (id: string) =>
  invoke<{ data: string; width: number; height: number }>("real_browser_screenshot", { id });

/** A foto do Chrome real num canvas, com o tamanho da página em px CSS. */
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

export const realBrowserSend = (id: string, method: string, params: Record<string, unknown>) =>
  invoke<void>("real_browser_send", { id, method, params });

export const realBrowserHistory = (id: string, delta: number) => invoke<void>("real_browser_history", { id, delta });

export const realBrowserClose = (id: string) => invoke<void>("real_browser_close", { id });

/** Os modificadores no formato do CDP: Alt=1, Ctrl=2, Meta=4, Shift=8. */
export function cdpModifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

/** Atalhos de edição que o Chrome só executa se vierem como `commands` no evento de tecla. */
const EDIT_COMMANDS: Record<string, string> = { a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo", y: "redo" };

/** O evento `keyDown` do CDP para uma tecla apertada no Portal. `null` = ignorar (tecla morta). */
export function keyDownEvent(e: {
  key: string; code: string; keyCode: number; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean;
}): Record<string, unknown> | null {
  if (e.key === "Dead" || e.key === "Process") return null;
  const modifiers = cdpModifiers(e);
  const base = { key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode, modifiers };
  const shortcut = e.ctrlKey || e.metaKey;
  if (shortcut) {
    const command = EDIT_COMMANDS[e.key.toLowerCase()];
    return { ...base, type: "rawKeyDown", ...(command ? { commands: [command] } : {}) };
  }
  // Caractere digitável (inclusive acentuado, depois da tecla morta): vai com o texto.
  if ([...e.key].length === 1) return { ...base, type: "keyDown", text: e.key, unmodifiedText: e.key };
  if (e.key === "Enter") return { ...base, type: "keyDown", text: "\r", unmodifiedText: "\r" };
  return { ...base, type: "rawKeyDown" };
}

const BUTTONS = ["left", "middle", "right", "back", "forward"] as const;

export function mouseButton(button: number): string {
  return BUTTONS[button] ?? "none";
}

/** A posição do ponteiro na página do Chrome: desfaz o tamanho com que o quadro aparece na tela
 *  (inclusive o zoom do canvas, que está no `getBoundingClientRect`). */
export function pagePoint(
  clientX: number, clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  page: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: Math.round(((clientX - rect.left) * page.width) / Math.max(rect.width, 1)),
    y: Math.round(((clientY - rect.top) * page.height) / Math.max(rect.height, 1)),
  };
}

/** Onde começa o login: a raiz do site. Um endereço de login do meio do fluxo carrega parâmetros que
 *  vencem (o Google responde 400), então nunca é reaproveitado. Sem endereço, a conta Google. */
export function loginStartUrl(address: string): string {
  try {
    const url = new URL(/^https?:\/\//i.test(address) ? address : `https://${address}`);
    if (url.protocol === "http:" || url.protocol === "https:") return `${url.origin}/`;
  } catch { /* endereço vazio ou inválido */ }
  return "https://accounts.google.com/";
}

/** Uma página de login do Google. Ali o Chrome controlado é recusado e, pior, a tentativa marca o
 *  perfil, que passa a ser recusado até num Chrome comum. O Portal não deixa digitar nela. */
export function isGoogleSignIn(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "accounts.google.com" && /signin|ServiceLogin|AddSession|InteractiveLogin/i.test(u.pathname);
  } catch {
    return false;
  }
}

export const realBrowserLoginFinish = () => invoke<void>("real_browser_login_finish");

/** Onde o Portal está na janela do app (pixels CSS). `null` = fora de vista. */
export type PortalRect = { x: number; y: number; width: number; height: number; scale: number } | null;

/** O retângulo do elemento, ou `null` se ele não está à vista (sem tamanho, ou a janela escondida). */
export function portalRect(el: Element | null): PortalRect {
  if (!el || document.visibilityState === "hidden") return null;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1 || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return null;
  return { x: r.left, y: r.top, width: r.width, height: r.height, scale: devicePixelRatio };
}

export function sameRect(a: PortalRect, b: PortalRect): boolean {
  if (!a || !b) return a === b;
  return a.scale === b.scale && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}

/** Abre o perfil do app num Chrome comum (sem controle remoto), em cima do Portal, para entrar numa conta. */
export const realBrowserLogin = (url: string, rect: PortalRect) => invoke<void>("real_browser_login", { url, rect });

/** O Portal mudou de lugar ou saiu de vista: a janela de login acompanha. */
export const realBrowserLoginPlace = (rect: PortalRect) => invoke<void>("real_browser_login_place", { rect });
