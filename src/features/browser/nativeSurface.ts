/**
 * O que um conteúdo nativo por cima do webview (o navegador do Portal, a tela do simulador iOS) precisa saber do
 * DOM: o retângulo do elemento que reserva o espaço, quem o recorta e o que do app está por cima dele.
 */
import type { Box } from "./realBrowser";

/** O que do app pode ficar por cima da página: menus, diálogos, dicas, o painel lateral. */
export const OVERLAYS = '[role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"], [data-radix-popper-content-wrapper], [data-session-panel], [data-over-webview]';
/** A grade de pontos que procura o que está por cima (outro nó do canvas, um popover sem papel ARIA). */
export const GRID = { cols: 12, rows: 8 };
/** De quanto em quanto tempo procurar o que está por cima (o lugar do Portal é medido a cada quadro). */
export const COVER_MS = 120;

export function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
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

/** O que do app está por cima do elemento nativo `el`: o maior bloco acima dele que não o contém. */
export function coversOf(el: HTMLElement, rect: Box, ignore?: string): Box[] {
  const found = new Set<Element>();
  for (const overlay of document.querySelectorAll(OVERLAYS)) {
    if (!overlay.contains(el) && !el.contains(overlay)) found.add(overlay);
  }
  for (let i = 0; i < GRID.cols; i++) {
    for (let j = 0; j < GRID.rows; j++) {
      const hit = document.elementFromPoint(rect.x + ((i + 0.5) * rect.width) / GRID.cols, rect.y + ((j + 0.5) * rect.height) / GRID.rows);
      if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
      // Quem pede pode ignorar o que não deve abrir buraco (o simulador fica por cima dos outros nós).
      if (ignore && hit.closest(ignore)) continue;
      let top = hit;
      while (top.parentElement && !top.parentElement.contains(el)) top = top.parentElement;
      found.add(top);
    }
  }
  return [...found].map(boxOf).filter((b) => b.width > 0 && b.height > 0);
}
