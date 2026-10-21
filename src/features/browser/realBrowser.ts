// O Chrome de verdade por trás do Portal (protótipo): ver `src-tauri/src/real_browser.rs`.
import { invoke } from "@tauri-apps/api/core";

export const realBrowserOpen = (id: string, url: string, width: number, height: number) =>
  invoke<void>("real_browser_open", { id, url, width: Math.round(width), height: Math.round(height) });

export const realBrowserSend = (id: string, method: string, params: Record<string, unknown>) =>
  invoke<void>("real_browser_send", { id, method, params });

export const realBrowserHistory = (id: string, delta: number) => invoke<void>("real_browser_history", { id, delta });

export const realBrowserWindow = (id: string, show: boolean) => invoke<void>("real_browser_window", { id, show });

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

/** Abre o perfil do app num Chrome comum (sem controle remoto) para entrar numa conta. */
export const realBrowserLogin = (url: string) => invoke<void>("real_browser_login", { url });
