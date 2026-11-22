import { BOOT_HOST_MSG, parseBootMessage } from "./artboardBoot";
import { applyArtboardStorage, flushArtboardStorage, recordFrameError } from "./artboardStore";

/**
 * A ponte entre o app e as pranchetas (iframes com `data-artboard-id`): o que a prancheta grava e os erros
 * que ela relata chegam aqui, e o tema do app vai para todas elas, sem recarregar o srcdoc. Instalada uma
 * vez, ao carregar o módulo, para não perder mensagem de um iframe que monta antes de a tela pedir.
 */

/** O tema do app: a classe `dark` (variante do Tailwind) ou o `data-theme` do html. */
export function isAppDark(): boolean {
  if (typeof document === "undefined") return false;
  const root = document.documentElement;
  return root.classList.contains("dark") || root.getAttribute("data-theme") === "dark";
}

const artboardFrames = (): HTMLIFrameElement[] =>
  typeof document === "undefined" ? [] : [...document.querySelectorAll<HTMLIFrameElement>("iframe[data-artboard-id]")];

const sendTheme = (frame: HTMLIFrameElement, dark: boolean) => {
  frame.contentWindow?.postMessage({ type: BOOT_HOST_MSG, kind: "theme", dark }, "*");
};

export function postThemeToFrames(dark: boolean = isAppDark()): void {
  for (const frame of artboardFrames()) sendTheme(frame, dark);
}

/** A prancheta que mandou a mensagem: só vale o iframe com `data-artboard-id` cuja janela é a origem. */
export function artboardFrameOf(source: MessageEventSource | null): HTMLIFrameElement | null {
  if (!source) return null;
  return artboardFrames().find((frame) => frame.contentWindow === source) ?? null;
}

function onBootMessage(e: MessageEvent) {
  const frame = artboardFrameOf(e.source);
  const id = frame?.dataset.artboardId;
  const m = parseBootMessage(e.data);
  if (!id || !m) return;
  if (m.kind === "error") recordFrameError(id, { message: m.message, line: m.line });
  else applyArtboardStorage(id, m);
}

let installed = false;
export function installArtboardBridge(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("message", onBootMessage);
  // Cada iframe que termina de carregar recebe o tema atual (o srcdoc pode ter nascido com outro).
  document.addEventListener("load", (e) => {
    const t = e.target;
    if (t instanceof HTMLIFrameElement && t.dataset.artboardId) sendTheme(t, isAppDark());
  }, true);
  new MutationObserver(() => postThemeToFrames()).observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
  window.addEventListener("pagehide", () => { void flushArtboardStorage(); });
}

installArtboardBridge();
