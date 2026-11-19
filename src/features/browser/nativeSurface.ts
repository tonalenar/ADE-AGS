/**
 * O que um conteúdo nativo por cima do webview (o navegador do Portal, a tela do simulador iOS) precisa saber do
 * DOM: o retângulo do elemento que reserva o espaço, quem o recorta e o que do app está por cima dele.
 */
import type { Box } from "./realBrowser";

/** O que do app pode ficar por cima da página: menus, diálogos, dicas, o painel lateral. */
export const OVERLAYS = 'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"], [popover], [data-radix-popper-content-wrapper], [data-session-panel], [data-over-webview]:not([data-over-webview="hit"]), [data-native-overlay]';
/** Controles invisíveis que só precisam receber clique/hover sem abrir buraco visual na página nativa. */
export const HIT_OVERLAYS = '[data-over-webview="hit"]';
/** A grade de pontos que procura o que está por cima (outro nó do canvas, um popover sem papel ARIA). */
export const GRID = { cols: 12, rows: 8 };
/** De quanto em quanto tempo procurar o que está por cima (o lugar do Portal é medido a cada quadro). */
export const COVER_MS = 120;

export function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function isVisibleOverlay(el: Element): boolean {
  const s = getComputedStyle(el);
  return s.display !== "none" && s.visibility !== "hidden";
}

/** Os ancestrais que recortam o que passa da borda deles (o canvas, a área de conteúdo). */
export function clippingAncestors(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let p = el.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (s.overflowX !== "visible" || s.overflowY !== "visible") out.push(p);
  }
  return out;
}

/** Áreas somente de recorte de clique (`data-over-webview="hit"`), sem abrir buraco visual no nativo. */
export function hitCoversOf(el: HTMLElement): Box[] {
  const out: Box[] = [];
  for (const overlay of document.querySelectorAll(HIT_OVERLAYS)) {
    if (overlay.contains(el) || el.contains(overlay) || !isVisibleOverlay(overlay)) continue;
    const box = boxOf(overlay);
    if (box.width > 0 && box.height > 0) out.push(box);
  }
  return out;
}

/** O que do app está por cima do elemento nativo `el`: o maior bloco acima dele que não o contém. */
export function coversOf(el: HTMLElement, rect: Box, ignore?: string): Box[] {
  const found = new Set<Element>();
  for (const overlay of document.querySelectorAll(OVERLAYS)) {
    if (!overlay.contains(el) && !el.contains(overlay) && isVisibleOverlay(overlay)) found.add(overlay);
  }
  for (let i = 0; i < GRID.cols; i++) {
    for (let j = 0; j < GRID.rows; j++) {
      const hit = document.elementFromPoint(rect.x + ((i + 0.5) * rect.width) / GRID.cols, rect.y + ((j + 0.5) * rect.height) / GRID.rows);
      if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
      // Recorte somente de clique não abre buraco visual na página nem pela grade de detecção.
      if (hit.closest(HIT_OVERLAYS)) continue;
      // Quem pede pode ignorar o que não deve abrir buraco (o simulador fica por cima dos outros nós).
      if (ignore && hit.closest(ignore)) continue;
      // Menu ou diálogo conhecido dentro da casca do chat não deve escalar até `[data-chat-shell]`.
      const known = hit.closest(OVERLAYS);
      if (known && !known.contains(el) && !el.contains(known)) {
        if (isVisibleOverlay(known)) found.add(known);
        continue;
      }
      const chain: Element[] = [];
      let top: Element | null = hit;
      while (top && !top.contains(el)) {
        chain.push(top);
        if (!top.parentElement || top.parentElement.contains(el)) break;
        top = top.parentElement;
      }
      const root = chain[chain.length - 1];
      if (!root) continue;
      // No modo chat, `<EditorArea>` fica acima da casca (`z-20`); só filhos com `z-index` explícito ficam por cima dela.
      if (chain.some((node) => node.hasAttribute("data-chat-shell"))) {
        let stacked: Element | null = null;
        for (let k = chain.length - 1; k >= 0; k--) {
          const candidate = chain[k]!;
          if (candidate.hasAttribute("data-chat-shell") || candidate.hasAttribute("data-column-tabbar") || candidate.tagName === "MAIN" || candidate.tagName === "ASIDE") continue;
          const z = getComputedStyle(candidate).zIndex;
          if (z && z !== "auto" && Number(z) !== 0) {
            stacked = candidate;
            break;
          }
        }
        if (stacked && isVisibleOverlay(stacked)) found.add(stacked);
        continue;
      }
      if (isVisibleOverlay(root)) found.add(root);
    }
  }
  return [...found].map(boxOf).filter((b) => b.width > 0 && b.height > 0);
}
